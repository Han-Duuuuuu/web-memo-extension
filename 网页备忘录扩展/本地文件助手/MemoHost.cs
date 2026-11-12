using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class MemoHost
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    private static readonly string Root = ResolveRoot();

    // 数据根目录：优先 D 盘，其次 E 盘，最后才回退到系统用户目录（C 盘）。
    // 可用环境变量 WEBMEMO_ROOT 指定自定义目录。
    private static string ResolveRoot()
    {
        string custom = Environment.GetEnvironmentVariable("WEBMEMO_ROOT");
        if (!String.IsNullOrEmpty(custom)) { try { return Path.GetFullPath(custom); } catch { } }
        foreach (string drive in new string[] { "D:", "E:" })
        {
            try { if (Directory.Exists(drive + "\\")) return Path.Combine(drive + "\\", "网页备忘录数据"); }
            catch { }
        }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WebMemoLocalFiles");
    }

    private static readonly string Index = Path.Combine(Root, "links.json");
    private static readonly HashSet<string> Documents = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".tsv", ".rtf", ".odt", ".ods", ".odp", ".md",
        ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".webp", ".zip", ".7z", ".rar", ".json", ".xml", ".nii", ".gz", ".nrrd", ".dcm"
    };
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] internal static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);

    [STAThread]
    public static void Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test") {
            try { SelfTest(); Console.WriteLine("Local helper self-test passed: ZIP, Unicode paths, rename, path containment and FileDrop data."); }
            catch (Exception error) { Console.Error.WriteLine("Self-test failed: " + error.Message); Environment.ExitCode = 1; }
            return;
        }
        try {
            SetProcessDPIAware(); Application.EnableVisualStyles();
            Stream input = Console.OpenStandardInput();
            Dictionary<string, object> message = ReadMessage(input);
            if (message == null) return;
            if (GetString(message, "action") == "drop") {
                using (DropReceiver window = new DropReceiver(GetString(message, "placement") == "cursor")) {
                    window.Shown += delegate {
                        WriteResponse(new { ok = true, ready = true });
                        Thread watcher = new Thread(delegate() {
                            try { ReadMessage(input); } catch { }
                            try { if (!window.IsDisposed) window.BeginInvoke((MethodInvoker)delegate { window.Close(); }); } catch { }
                        });
                        watcher.IsBackground = true; watcher.Start();
                    };
                    Application.Run(window);
                    WriteResponse(window.Paths.Count == 0 ? (object)new { ok = true, cancelled = true } : AttachPaths(window.Paths));
                }
            } else if (GetString(message, "action") == "dragOut") {
                Dictionary<string, object> entry = null;
                WithIndex(delegate(Dictionary<string, object> data) { entry = GetEntry(data, GetString(message, "id")); });
                string path = GetString(entry, "path");
                EnsureExists(path, GetString(entry, "kind") == "folder");
                using (DragSource window = new DragSource(path, GetString(message, "mode") == "direct")) {
                    window.Shown += delegate {
                        WriteResponse(new { ok = true, ready = true });
                        Thread watcher = new Thread(delegate() {
                            try { ReadMessage(input); } catch { }
                            // OLE 拖放在嵌套消息循环中运行；先置位，QueryContinueDrag 才能取消。
                            window.Cancelled = true;
                            try { if (!window.IsDisposed) window.BeginInvoke((MethodInvoker)delegate { if (!window.Dragging) window.Close(); }); } catch { }
                        });
                        watcher.IsBackground = true; watcher.Start();
                    };
                    Application.Run(window);
                    if (window.Error != null) WriteResponse(new { ok = false, error = window.Error });
                    else WriteResponse(new { ok = true, cancelled = window.Effect == DragDropEffects.None });
                }
            } else { WriteResponse(Handle(message)); }
        } catch (Exception error) { WriteResponse(new { ok = false, error = error.Message }); }
    }
    private static Dictionary<string, object> ReadMessage(Stream stream)
    {
        byte[] prefix = ReadExact(stream, 4); if (prefix == null) return null;
        uint length = BitConverter.ToUInt32(prefix, 0);
        if (length == 0 || length > 4 * 1024 * 1024) throw new Exception("请求长度无效。");
        byte[] body = ReadExact(stream, (int)length); if (body == null) return null;
        return Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body));
    }
    private static byte[] ReadExact(Stream stream, int size)
    {
        byte[] bytes = new byte[size]; int offset = 0;
        while (offset < size) { int count = stream.Read(bytes, offset, size - offset); if (count == 0) return null; offset += count; }
        return bytes;
    }
    private static void WriteResponse(object result)
    {
        byte[] payload = Encoding.UTF8.GetBytes(Json.Serialize(result));
        if (payload.Length > 1024 * 1024) payload = Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"返回项目过多，请分批操作。\"}");
        Stream output = Console.OpenStandardOutput(); output.Write(BitConverter.GetBytes(payload.Length), 0, 4); output.Write(payload, 0, payload.Length); output.Flush();
    }
    private static object Handle(Dictionary<string, object> message)
    {
        string action = GetString(message, "action");
        if (action == "memoData") return MemoData(message);
        if (action == "ping") return new { ok = true, version = "1.5.0", features = new string[] { "drop", "dragOut", "rename", "zip", "list", "memoData" } };
        if (action == "chooseFiles" || action == "chooseFolder") {
            List<string> paths = new List<string>();
            using (Form owner = new Form()) {
                owner.ShowInTaskbar = false; owner.TopMost = true; owner.Opacity = 0; owner.Width = 1; owner.Height = 1; owner.Show();
                if (action == "chooseFiles") {
                    using (OpenFileDialog picker = new OpenFileDialog()) {
                        picker.Title = "选择这篇文献的补充材料（可多选，ZIP 自动解压）";
                        picker.Filter = "所有文件 (*.*)|*.*"; picker.Multiselect = true; picker.CheckFileExists = true;
                        if (picker.ShowDialog(owner) == DialogResult.OK) paths.AddRange(picker.FileNames);
                    }
                } else {
                    using (FolderBrowserDialog picker = new FolderBrowserDialog()) {
                        picker.Description = "选择这篇文献的补充材料文件夹"; picker.ShowNewFolderButton = false;
                        if (picker.ShowDialog(owner) == DialogResult.OK) paths.Add(picker.SelectedPath);
                    }
                }
            }
            return paths.Count == 0 ? (object)new { ok = true, cancelled = true } : AttachPaths(paths);
        }
        if (action == "describe") {
            List<Dictionary<string, object>> entries = new List<Dictionary<string, object>>();
            object raw; IEnumerable ids = message.TryGetValue("ids", out raw) ? raw as IEnumerable : null;
            if (ids == null || raw is string) throw new Exception("关联列表无效。");
            WithIndex(delegate(Dictionary<string, object> data) {
                int count = 0;
                foreach (object value in ids) { if (++count > 2000) throw new Exception("关联列表过长。"); string id = value as string; if (id != null && data.ContainsKey(id)) entries.Add(GetEntry(data, id)); }
            });
            return new { ok = true, entries = entries };
        }
        if (action == "list") return ListChildren(message);
        if (action == "rename") return Rename(message);
        if (action == "open" || action == "reveal") {
            Dictionary<string, object> entry = null;
            WithIndex(delegate(Dictionary<string, object> data) { entry = GetEntry(data, GetString(message, "id")); });
            string path = GetString(entry, "path"), kind = GetString(entry, "kind");
            EnsureExists(path, kind == "folder");
            string explorer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
            if (action == "reveal") Process.Start(new ProcessStartInfo(explorer, "/select," + QuotePath(path)) { UseShellExecute = true });
            else if (kind == "folder") Process.Start(new ProcessStartInfo(explorer, QuotePath(path)) { UseShellExecute = true });
            else {
                if (!Documents.Contains(Path.GetExtension(path))) throw new Exception("此类型请点击“定位”后从资源管理器打开。");
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            }
            return new { ok = true };
        }
        throw new Exception("本地助手版本不支持此操作，请重新运行新包里的 Install.cmd。");
    }
    private static object AttachPaths(List<string> paths)
    {
        if (paths.Count > 200) throw new Exception("一次最多关联 200 个项目，请分批拖入。");
        List<Dictionary<string, object>> entries = new List<Dictionary<string, object>>();
        WithIndex(delegate(Dictionary<string, object> data) {
            foreach (string selected in paths) {
                string path = Path.GetFullPath(selected);
                Dictionary<string, object> entry = Register(data, path, false);
                if (GetString(entry, "kind") == "file" && Path.GetExtension(path).Equals(".zip", StringComparison.OrdinalIgnoreCase)) {
                    string rootId = GetString(entry, "rootId");
                    bool available = rootId != "" && data.ContainsKey(rootId) && Directory.Exists(GetString(GetEntry(data, rootId), "path"));
                    if (!available) {
                        string target = ExtractZip(path);
                        Dictionary<string, object> folder = Register(data, target, true);
                        entry["archive"] = true; entry["rootId"] = GetString(folder, "id");
                    }
                }
                entries.Add(entry);
            }
            SaveIndex(data);
        });
        return new { ok = true, entries = entries };
    }
    private static Dictionary<string, object> Register(Dictionary<string, object> data, string path, bool extracted)
    {
        bool folder = Directory.Exists(path); EnsureExists(path, folder);
        foreach (object value in data.Values) {
            Dictionary<string, object> old = value as Dictionary<string, object>;
            if (old != null && GetString(old, "path").Equals(path, StringComparison.OrdinalIgnoreCase)) return old;
        }
        string id = Guid.NewGuid().ToString("N");
        Dictionary<string, object> entry = new Dictionary<string, object> { {"id",id}, {"path",path}, {"name",NameOf(path)}, {"kind",folder ? "folder" : "file"} };
        if (extracted) entry["extracted"] = true;
        data[id] = entry; return entry;
    }
    private static object ListChildren(Dictionary<string, object> message)
    {
        List<Dictionary<string, object>> entries = new List<Dictionary<string, object>>();
        int offset = 0; object raw; if (message.TryGetValue("offset", out raw)) offset = Convert.ToInt32(raw);
        if (offset < 0 || offset > 100000) throw new Exception("目录页码无效。");
        int? next = null;
        WithIndex(delegate(Dictionary<string, object> data) {
            Dictionary<string, object> entry = GetEntry(data, GetString(message, "id"));
            if (GetString(entry, "rootId") != "") entry = GetEntry(data, GetString(entry, "rootId"));
            if (GetString(entry, "kind") != "folder") throw new Exception("只能展开文件夹或已解压的 ZIP。");
            string directory = GetString(entry, "path"); EnsureExists(directory, true);
            List<string> folders = new List<string>(Directory.GetDirectories(directory)); folders.Sort(StringComparer.OrdinalIgnoreCase);
            List<string> files = new List<string>(Directory.GetFiles(directory)); files.Sort(StringComparer.OrdinalIgnoreCase); folders.AddRange(files);
            int end = Math.Min(offset + 100, folders.Count);
            bool extracted = entry.ContainsKey("extracted") && Object.Equals(entry["extracted"], true);
            for (int i = offset; i < end; i++) entries.Add(Register(data, folders[i], extracted));
            if (end < folders.Count) next = end;
            SaveIndex(data);
        });
        return new { ok = true, entries = entries, nextOffset = next };
    }
    private static string ExtractZip(string source)
    {
        string directory = Path.Combine(Root, "Extracted"); Directory.CreateDirectory(directory);
        string final = Path.Combine(directory, Guid.NewGuid().ToString("N"));
        string temp = final + ".pending"; Directory.CreateDirectory(temp);
        const long maxBytes = 2L * 1024 * 1024 * 1024;
        long total = 0, actual = 0;
        try {
            using (FileStream file = File.OpenRead(source))
            using (ZipArchive archive = new ZipArchive(file, ZipArchiveMode.Read, false, Encoding.GetEncoding(936))) {
                if (archive.Entries.Count > 5000) throw new Exception("ZIP 项目过多（最多 5000 项），请先解压后关联文件夹。");
                foreach (ZipArchiveEntry item in archive.Entries) {
                    total += item.Length; if (total > maxBytes) throw new Exception("ZIP 解压后超过 2 GB，请先手动解压后关联文件夹。");
                    string relative = item.FullName.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
                    if (String.IsNullOrEmpty(relative)) continue;
                    if (Path.IsPathRooted(relative) || relative.IndexOf(':') >= 0) throw new Exception("ZIP 含有无效的文件路径，未解压。");
                    string target = Path.GetFullPath(Path.Combine(temp, relative));
                    if (!target.StartsWith(temp + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("ZIP 路径超出解压目录，未解压。");
                    if (relative.EndsWith(Path.DirectorySeparatorChar.ToString())) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream sourceStream = item.Open())
                    using (FileStream output = new FileStream(target, FileMode.CreateNew, FileAccess.Write)) {
                        byte[] buffer = new byte[65536]; int count;
                        while ((count = sourceStream.Read(buffer, 0, buffer.Length)) > 0) {
                            actual += count; if (actual > maxBytes) throw new Exception("ZIP 实际解压内容过大，已停止。");
                            output.Write(buffer, 0, count);
                        }
                    }
                }
            }
            Directory.Move(temp, final); return final;
        } catch (Exception error) {
            try { Directory.Delete(temp, true); } catch { }
            throw new Exception("ZIP 自动解压失败：" + error.Message);
        }
    }
    private static object Rename(Dictionary<string, object> message)
    {
        Dictionary<string, object> updated = null;
        string oldPath = "", newPath = ""; bool folder = false;
        WithIndex(delegate(Dictionary<string, object> data) {
            Dictionary<string, object> entry = GetEntry(data, GetString(message, "id"));
            oldPath = GetString(entry, "path"); folder = GetString(entry, "kind") == "folder"; EnsureExists(oldPath, folder);
            string stem = GetString(message, "name");
            string name = stem + (folder ? "" : ExtensionOf(NameOf(oldPath)));
            ValidateName(name);
            string parent = Path.GetDirectoryName(oldPath.TrimEnd(Path.DirectorySeparatorChar));
            if (String.IsNullOrEmpty(parent)) throw new Exception("不能重命名磁盘根目录。");
            newPath = Path.Combine(parent, name);
            if (oldPath.Equals(newPath, StringComparison.Ordinal)) { updated = entry; return; }
            if (!oldPath.Equals(newPath, StringComparison.OrdinalIgnoreCase) && (File.Exists(newPath) || Directory.Exists(newPath))) throw new Exception("同一位置已有这个名称，请换一个；不会覆盖原有项目。");
            MovePath(oldPath, newPath, folder);
            try {
                foreach (object value in data.Values) {
                    Dictionary<string, object> item = value as Dictionary<string, object>; if (item == null) continue;
                    string path = GetString(item, "path");
                    if (path.Equals(oldPath, StringComparison.OrdinalIgnoreCase) || (folder && path.StartsWith(oldPath + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))) {
                        string target = newPath + path.Substring(oldPath.Length); item["path"] = target; item["name"] = NameOf(target);
                    }
                }
                SaveIndex(data); updated = entry;
            } catch {
                try { MovePath(newPath, oldPath, folder); } catch { throw new Exception("项目已改名，但关联记录未能保存。请保留本地记录并重新关联。"); }
                throw;
            }
        });
        return new { ok = true, entries = new Dictionary<string, object>[] { updated }, rename = new { oldPath = oldPath, newPath = newPath, folder = folder } };
    }
    private static void MovePath(string source, string target, bool folder)
    {
        if (source.Equals(target, StringComparison.OrdinalIgnoreCase) && !source.Equals(target, StringComparison.Ordinal)) {
            string temp = Path.Combine(Path.GetDirectoryName(source), ".wbmemo-" + Guid.NewGuid().ToString("N"));
            if (folder) Directory.Move(source, temp); else File.Move(source, temp);
            try { if (folder) Directory.Move(temp, target); else File.Move(temp, target); }
            catch { if (folder) Directory.Move(temp, source); else File.Move(temp, source); throw; }
        } else if (folder) Directory.Move(source, target); else File.Move(source, target);
    }
    private static void ValidateName(string name)
    {
        if (String.IsNullOrWhiteSpace(name) || name.Length > 255 || name == "." || name == ".." || name.EndsWith(".") || name.EndsWith(" ") || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new Exception("名称无效，请勿使用斜杠、冒号、问号等字符或末尾空格。");
        string root = name.Split('.')[0].TrimEnd(' ').ToUpperInvariant();
        if (root == "CON" || root == "PRN" || root == "AUX" || root == "NUL" || System.Text.RegularExpressions.Regex.IsMatch(root, "^(COM|LPT)[1-9]$")) throw new Exception("该名称被 Windows 保留，请换一个。");
    }
    private static string ExtensionOf(string name) { int dot = name.LastIndexOf('.'); return dot > 0 ? name.Substring(dot) : ""; }
    private static string NameOf(string path) { string name = Path.GetFileName(path.TrimEnd(Path.DirectorySeparatorChar)); return String.IsNullOrEmpty(name) ? path : name; }
    private static void EnsureExists(string path, bool folder) { if (folder ? !Directory.Exists(path) : !File.Exists(path)) throw new Exception("项目已移动、改名或删除，请移除旧关联并重新添加。"); }
    private static Dictionary<string, object> GetEntry(Dictionary<string, object> data, string id)
    {
        Guid parsed; if (id == null || id.Length != 32 || !Guid.TryParseExact(id, "N", out parsed) || !data.ContainsKey(id)) throw new Exception("本地关联不存在，请重新添加。");
        Dictionary<string, object> entry = data[id] as Dictionary<string, object>; if (entry == null) throw new Exception("关联损坏，请重新添加。"); return entry;
    }
    private static string QuotePath(string path) { int trailing = path.Length - path.TrimEnd('\\').Length; return "\"" + path + new String('\\', trailing) + "\""; }
    private static string GetString(Dictionary<string, object> source, string key) { object value; return source != null && source.TryGetValue(key, out value) && value is string ? (string)value : ""; }
    private static void WithIndex(Action<Dictionary<string, object>> action)
    {
        using (Mutex gate = new Mutex(false, "Local\\WebMemoLocalFilesIndex")) {
            bool acquired = false;
            try {
                try { acquired = gate.WaitOne(15000); } catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new Exception("本地关联忙，请稍后重试。");
                Dictionary<string, object> data = File.Exists(Index) ? Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Index, Encoding.UTF8)) : new Dictionary<string, object>();
                if (data == null) throw new Exception("关联记录无法读取，请保留记录并重新配置助手。"); action(data);
            } finally { if (acquired) gate.ReleaseMutex(); }
        }
    }
    private static void SaveIndex(Dictionary<string, object> data)
    {
        Directory.CreateDirectory(Root); string temp = Index + ".tmp"; File.WriteAllText(temp, Json.Serialize(data), new UTF8Encoding(false));
        if (File.Exists(Index)) File.Replace(temp, Index, Index + ".bak"); else File.Move(temp, Index);
    }
    private static object MemoData(Dictionary<string, object> message)
    {
        // Windows 上明确要求 D 盘，不在不可用时悄悄回退到 C 盘。
        if (Path.DirectorySeparatorChar == '\\' && !Root.StartsWith("D:\\", StringComparison.OrdinalIgnoreCase)) throw new Exception("备忘录必须保存在 D 盘，请检查 D 盘和 WEBMEMO_ROOT 设置。");
        string directory = Path.Combine(Root, "Memos");
        object result = null;
        WithIndex(delegate(Dictionary<string, object> unused) {
            Directory.CreateDirectory(directory);
            string op = GetString(message, "op");
            if (op == "keys") {
                int offset = message.ContainsKey("offset") ? Convert.ToInt32(message["offset"]) : 0;
                if (offset < 0) throw new Exception("页码无效。");
                string[] files = Directory.GetFiles(directory, "*.json"); Array.Sort(files, StringComparer.Ordinal);
                List<string> keys = new List<string>();
                for (int i = offset; i < Math.Min(files.Length, offset + 100); i++) {
                    Dictionary<string, object> record = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(files[i], Encoding.UTF8));
                    keys.Add(GetString(record, "key"));
                }
                result = new { ok = true, keys = keys, more = offset + 100 < files.Length }; return;
            }
            string key = GetString(message, "key");
            if (!key.StartsWith("wb_memo_", StringComparison.Ordinal) || key.Length > 16000) throw new Exception("备忘录存储键无效。");
            string hash;
            using (System.Security.Cryptography.SHA256 sha = System.Security.Cryptography.SHA256.Create()) { hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(key))).Replace("-", "").ToLowerInvariant(); }
            string path = Path.Combine(directory, hash + ".json");
            Dictionary<string, object> existing = null;
            if (File.Exists(path)) {
                existing = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
                if (existing == null || GetString(existing, "key") != key || !existing.ContainsKey("value")) throw new Exception("D 盘记录损坏，请保留文件并恢复备份。");
            }
            if (op == "get") { result = new { ok = true, exists = existing != null, value = existing == null ? null : existing["value"] }; return; }
            if (op != "set" && op != "import") throw new Exception("不支持的存储操作。");
            object value;
            if (!message.TryGetValue("value", out value) || (key.StartsWith("wb_memo_attachments_", StringComparison.Ordinal) ? !(value is IList) : !(value is string))) throw new Exception("备忘录内容格式无效。");
            if (op == "import" && existing != null) { result = new { ok = true }; return; }
            string json = Json.Serialize(new Dictionary<string, object> { {"key",key}, {"value",value} });
            if (Encoding.UTF8.GetByteCount(json) > 700000) throw new Exception("单条备忘录或附件列表过大（上限约 680 KB），未覆盖原数据。");
            string temp = path + ".tmp";
            try {
                using (FileStream stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None)) {
                    byte[] bytes = Encoding.UTF8.GetBytes(json); stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
                }
                if (File.Exists(path)) File.Replace(temp, path, path + ".bak"); else File.Move(temp, path);
            } finally { if (File.Exists(temp)) File.Delete(temp); }
            result = new { ok = true };
        });
        return result;
    }
    private static DataObject FileDragData(string path)
    {
        // CF_HDROP 交给资源管理器和浏览器的是实际文件，不能用路径文本或 file:// 链接代替。
        DataObject data = new DataObject();
        data.SetData(DataFormats.FileDrop, true, new string[] { path });
        return data;
    }
    private static void SelfTest()
    {
        string source = Path.Combine(Path.GetTempPath(), "WebMemoTest-" + Guid.NewGuid().ToString("N"));
        string unpacked = null; Directory.CreateDirectory(source);
        try {
            string zip = Path.Combine(source, "sample.zip");
            using (ZipArchive output = new ZipArchive(File.Create(zip), ZipArchiveMode.Create, false, Encoding.UTF8)) {
                using (StreamWriter writer = new StreamWriter(output.CreateEntry("材料/表S1.csv").Open(), Encoding.UTF8)) writer.Write("name,value\nA,1\n");
            }
            unpacked = ExtractZip(zip);
            string original = Path.Combine(unpacked, "材料");
            if (!File.ReadAllText(Path.Combine(original, "表S1.csv"), Encoding.UTF8).Contains("A,1")) throw new Exception("ZIP or Unicode file names did not round-trip.");
            string renamed = Path.Combine(unpacked, "改名后的材料"); MovePath(original, renamed, true);
            if (!File.Exists(Path.Combine(renamed, "表S1.csv"))) throw new Exception("Folder rename failed.");
            string renamedFile = Path.Combine(renamed, "新的表名.csv"); MovePath(Path.Combine(renamed, "表S1.csv"), renamedFile, false);
            if (!File.Exists(renamedFile)) throw new Exception("File rename failed.");
            foreach (string path in new string[] { renamedFile, renamed, zip }) {
                DataObject dragData = FileDragData(path);
                string[] paths = dragData.GetData(DataFormats.FileDrop) as string[];
                if (paths == null || paths.Length != 1 || paths[0] != path) throw new Exception("FileDrop data did not round-trip.");
            }
            bool blocked = false; try { ValidateName("CON.txt"); } catch { blocked = true; }
            if (!blocked) throw new Exception("Reserved file name was accepted.");
            string invalid = Path.Combine(source, "invalid.zip");
            using (ZipArchive output = new ZipArchive(File.Create(invalid), ZipArchiveMode.Create)) {
                using (StreamWriter writer = new StreamWriter(output.CreateEntry("../outside.txt").Open())) writer.Write("must not be extracted");
            }
            blocked = false;
            try { string unexpected = ExtractZip(invalid); Directory.Delete(unexpected, true); } catch { blocked = true; }
            if (!blocked) throw new Exception("Archive path containment failed.");
        } finally {
            if (unpacked != null && Directory.Exists(unpacked)) Directory.Delete(unpacked, true);
            if (Directory.Exists(source)) Directory.Delete(source, true);
        }
    }
    private sealed class DragSource : Form
    {
        public volatile bool Cancelled;
        public bool Dragging;
        public DragDropEffects Effect = DragDropEffects.None;
        public string Error;
        private readonly string path;
        private readonly bool direct;
        private readonly System.Windows.Forms.Timer timeout;
        private DateTime dragStarted;
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get { CreateParams p = base.CreateParams; p.ExStyle |= 0x08000000; return p; } }
        public DragSource(string selectedPath, bool directDrag)
        {
            path = selectedPath; direct = directDrag;
            Text = "本页备忘录 · 拖出文件"; ShowInTaskbar = false; TopMost = true;
            FormBorderStyle = FormBorderStyle.FixedToolWindow; StartPosition = FormStartPosition.Manual;
            ClientSize = new Size(390, 150); BackColor = Color.FromArgb(241, 246, 255);
            Point cursor; GetCursorPos(out cursor); Rectangle area = Screen.FromPoint(cursor).WorkingArea;
            Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + (area.Height - Height) / 2);
            if (direct) {
                // OLE 使用本进程的 HWND；不激活、不覆盖目标网页，也不模拟鼠标点击。
                FormBorderStyle = FormBorderStyle.None; Size = new Size(1, 1); Opacity = 0;
                Shown += delegate { BeginInvoke((MethodInvoker)StartDrag); };
            } else {
                Label hint = new Label { Dock = DockStyle.Top, Height = 58, TextAlign = ContentAlignment.MiddleCenter, Text = "按住下方名称，拖到目标窗口后松开\n拖动中按 Esc 取消；关闭窗口可退出" };
                Label source = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Text = NameOf(path), AutoEllipsis = true, Cursor = Cursors.Hand, Font = new Font("Microsoft YaHei UI", 11, FontStyle.Bold), ForeColor = Color.FromArgb(40, 84, 181) };
                Controls.Add(source); Controls.Add(hint);
                Point start = Point.Empty; bool pressed = false;
                source.MouseDown += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) { start = e.Location; pressed = true; } };
                source.MouseUp += delegate { pressed = false; };
                source.MouseMove += delegate(object sender, MouseEventArgs e) {
                    if (!pressed || e.Button != MouseButtons.Left) return;
                    Size threshold = SystemInformation.DragSize;
                    if (Math.Abs(e.X - start.X) < threshold.Width / 2 && Math.Abs(e.Y - start.Y) < threshold.Height / 2) return;
                    pressed = false; StartDrag();
                };
            }
            KeyPreview = true; KeyDown += delegate(object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Escape) { Cancelled = true; if (!Dragging) Close(); } };
            QueryContinueDrag += delegate(object sender, QueryContinueDragEventArgs e) {
                if (e.EscapePressed || Cancelled || DateTime.UtcNow - dragStarted > TimeSpan.FromSeconds(90)) e.Action = DragAction.Cancel;
                // 直接拖出的按下事件发生在 Edge 线程，读取实际按钮状态，避免新建窗口的队列状态滞后。
                else e.Action = (GetAsyncKeyState(0x01) & 0x8000) != 0 ? DragAction.Continue : DragAction.Drop;
            };
            timeout = new System.Windows.Forms.Timer { Interval = 90000 };
            timeout.Tick += delegate { Cancelled = true; if (!Dragging) Close(); }; timeout.Start();
        }
        private void StartDrag()
        {
            if (Dragging || IsDisposed) return;
            try {
                if (Cancelled) return;
                if ((GetAsyncKeyState(0x01) & 0x8000) == 0) {
                    if (direct) Error = "鼠标已松开。请按住附件名称稍等片刻再拖动，或点击“拖出”从本地窗口拖动。";
                    return;
                }
                EnsureExists(path, Directory.Exists(path));
                Dragging = true; dragStarted = DateTime.UtcNow;
                // 只提供 Copy，避免拖往文件夹时移动原文件而破坏已有关联。
                Effect = DoDragDrop(FileDragData(path), DragDropEffects.Copy);
            } catch (Exception error) { Error = error.Message; }
            finally { Dragging = false; Close(); }
        }
        protected override void Dispose(bool disposing) { if (disposing && timeout != null) timeout.Dispose(); base.Dispose(disposing); }
    }
    private sealed class DropReceiver : Form
    {
        public readonly List<string> Paths = new List<string>();
        private readonly System.Windows.Forms.Timer timeout;
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get { CreateParams p = base.CreateParams; p.ExStyle |= 0x08000000; return p; } }
        public DropReceiver(bool atCursor)
        {
            Text = "本页备忘录 · 拖入补充材料"; FormBorderStyle = FormBorderStyle.FixedToolWindow; ShowInTaskbar = false; TopMost = true;
            StartPosition = FormStartPosition.Manual; ClientSize = new Size(370, 142); BackColor = Color.FromArgb(241, 246, 255); AllowDrop = true;
            Label message = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Microsoft YaHei UI", 10), Text = "把文件、文件夹或 ZIP 拖到这里后松开\nZIP 会自动解压并显示内容\n只建立关联，保留原文件；关闭窗口可取消", AllowDrop = true };
            Controls.Add(message);
            DragEventHandler accept = delegate(object sender, DragEventArgs e) { e.Effect = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None; };
            DragEventHandler drop = delegate(object sender, DragEventArgs e) {
                if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;
                string[] paths = e.Data.GetData(DataFormats.FileDrop) as string[]; if (paths != null) Paths.AddRange(paths); Close();
            };
            DragEnter += accept; DragOver += accept; DragDrop += drop; message.DragEnter += accept; message.DragOver += accept; message.DragDrop += drop;
            Point cursor; GetCursorPos(out cursor); Rectangle area = Screen.FromPoint(cursor).WorkingArea;
            int x = atCursor ? cursor.X - Width / 2 : area.Left + (area.Width - Width) / 2;
            int y = atCursor ? cursor.Y - Height / 2 : area.Top + (area.Height - Height) / 2;
            Location = new Point(Math.Max(area.Left, Math.Min(area.Right - Width, x)), Math.Max(area.Top, Math.Min(area.Bottom - Height, y)));
            timeout = new System.Windows.Forms.Timer { Interval = 90000 }; timeout.Tick += delegate { Close(); }; timeout.Start();
        }
        protected override void Dispose(bool disposing) { if (disposing && timeout != null) timeout.Dispose(); base.Dispose(disposing); }
    }
}
