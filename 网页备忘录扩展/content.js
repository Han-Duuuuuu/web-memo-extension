(function () {
  "use strict";
  if (window.__wbMemoLoaded) return;
  window.__wbMemoLoaded = true;
  // 沿用 1.0 / 1.1 的文字键，更新不改变原有备忘录。
  const pageKey = location.origin + location.pathname + location.search;
  const storageKey = "wb_memo_" + pageKey;
  const filesKey = "wb_memo_attachments_" + pageKey;
  let host, panel, ui, textarea, statusEl, filesStatus, list;
  let entries = [], initialized = false, loading = null, saveQueue = Promise.resolve();
  let busy = false;
  let dropPending = false;
  let dragOutPending = false, dragOutMode = "";

  // document_start 时在 window 捕获阶段接收，先于网页自己的上传/拖放处理。
  // closed Shadow DOM 在外层会把 target 重定向为 host，坐标检查也兼容网页覆盖层。
  function memoFileDrag(e) {
    if (!e.isTrusted || !host?.isConnected || host.style.display === "none" ||
        !Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    const rect = panel.getBoundingClientRect();
    if (!e.composedPath().includes(host) && !(e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const zone = ui.querySelector(".wb-drop-zone");
    if (e.type === "dragleave") {
      if (e.clientX <= rect.left || e.clientX >= rect.right || e.clientY <= rect.top || e.clientY >= rect.bottom) zone.removeAttribute("data-drag");
      return;
    }
    if (dragOutPending) { if (e.dataTransfer) e.dataTransfer.dropEffect = "none"; return; }
    if (e.dataTransfer) e.dataTransfer.dropEffect = busy && !dropPending ? "none" : "copy";
    zone.toggleAttribute("data-drag", e.type !== "drop");
    // 有些页面/覆盖层不产生可用的 dragenter，dragover 同样可以启动接收框。
    if (!busy && initialized) addEntries("drop", {placement:"cursor"});
    if (e.type === "drop") fileStatus("请拖到出现的本地接收框再松开；若已松开，请重新拖一次，或先点击虚线区域。");
  }
  for (const type of ["dragenter", "dragover", "dragleave", "drop"]) window.addEventListener(type, memoFileDrag, {capture:true, passive:false});

  function button(label, click) {
    const el = document.createElement("button"); el.type = "button"; el.textContent = label;
    el.addEventListener("click", e => { if (e.isTrusted) click(e); });
    return el;
  }
  function fileStatus(text, error = false) {
    filesStatus.textContent = text;
    filesStatus.toggleAttribute("data-error", error);
  }
  async function native(action, id, extra = {}) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "MEMO_LOCAL_REQUEST", action, id, ...extra });
      if (!res?.ok) throw new Error(res?.error || "操作失败，请检查本地文件助手连接。");
      return res;
    } catch (error) { throw new Error(error.message || "连接失败，请刷新页面重试。"); }
  }
  async function memoGet(keys) {
    const result = await chrome.runtime.sendMessage({type:"MEMO_DATA_READ",keys});
    if (!result?.ok) throw new Error(result?.error || "D 盘数据读取失败，请更新本地助手。");
    return result.values;
  }
  async function memoSet(values) {
    const result = await chrome.runtime.sendMessage({type:"MEMO_DATA_WRITE",values});
    if (!result?.ok) throw new Error(result?.error || "D 盘保存失败。");
  }
  function mapTree(items, changes, rename) {
    const byId = new Map(changes.map(e => [e.id,e]));
    return items.map(item => {
      let e = byId.has(item.id) ? {...item,...byId.get(item.id)} : {...item};
      if (rename && typeof e.path === "string") {
        const old = rename.oldPath.toLowerCase(), current = e.path.toLowerCase();
        if (current === old || (rename.folder && current.startsWith(old + "\\"))) {
          e.path = rename.newPath + e.path.slice(rename.oldPath.length); e.name = e.path.split(/[\\/]/).pop();
        }
      }
      if (e.children) e.children = mapTree(e.children, changes, rename);
      return e;
    });
  }
  function findEntry(id, items = entries) {
    for (const e of items) { if (e.id === id) return e; const nested = e.children && findEntry(id,e.children); if (nested) return nested; }
    return null;
  }
  async function loadChildren(entry, offset = 0, auto = false) {
    if (busy && !auto) return;
    const wasBusy = busy; setBusy(true); fileStatus("正在读取目录…");
    try {
      const result = await native("list", entry.id, {offset});
      entry = findEntry(entry.id); if (!entry) return;
      const previous = offset ? entry.children || [] : [];
      entry.children = [...previous,...(result.entries || []).filter(e => !previous.some(old => old.id === e.id))];
      entry.nextOffset = result.nextOffset; entry.expanded = true; entry.childrenLoaded = true;
      await memoSet({[filesKey]:entries}); renderFiles();
      fileStatus(entry.archive ? "ZIP 已解压。可直接打开下面的文件，或展开文件夹。" : "目录已展开。");
    } catch (error) { fileStatus(error.message,true); }
    finally { setBusy(wasBusy); }
  }
  async function toggleChildren(entry) {
    if (busy) return;
    if (!entry.childrenLoaded) { await loadChildren(entry); return; }
    entry = findEntry(entry.id); entry.expanded = !entry.expanded;
    try { await memoSet({[filesKey]:entries}); renderFiles(); }
    catch { fileStatus("目录状态保存失败，请重试。",true); }
  }
  function renderFiles() {
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("p"); empty.className = "wb-files-hint";
      empty.textContent = "拖入文件、文件夹或 ZIP；ZIP 自动解压并展开。"; list.append(empty); return;
    }
    function draw(items, parent, depth) {
      for (const entry of items) {
        const row = document.createElement("div"); row.className = "wb-file-row";
        const name = button((entry.archive ? "📦 " : entry.kind === "folder" ? "📁 " : "📄 ") + entry.name, () => openEntry(entry, "open"));
        name.className = "wb-file-name"; name.title = entry.path + "\n单击打开；按住名称拖出文件";
        bindDragSource(name, entry);
        const path = document.createElement("div"); path.className = "wb-file-path";
        path.textContent = entry.archive ? "ZIP 已自动解压 · 原压缩包保留" : (entry.extracted ? "已解压副本 · " : "") + entry.path;
        const actions = document.createElement("div"); actions.className = "wb-file-actions";
        actions.append(button(entry.archive ? "打开解压目录" : "打开", () => openEntry(entry,"open")), button("拖出", () => dragOut(entry,"window")), button("定位", () => openEntry(entry,"reveal")), button("改名", () => startRename(entry,row)));
        if (depth === 0) actions.append(button("移除", () => removeEntry(entry)));
        if (entry.archive || entry.kind === "folder") actions.append(button(entry.expanded ? "收起" : "展开", () => toggleChildren(entry)));
        row.append(name,path,actions); parent.append(row);
        if (entry.expanded) {
          const children = document.createElement("div"); children.className = "wb-file-children";
          if (entry.children?.length) draw(entry.children,children,depth+1);
          else { const empty = document.createElement("p"); empty.className = "wb-files-hint"; empty.textContent = "空文件夹"; children.append(empty); }
          if (entry.nextOffset != null) children.append(button("加载更多", () => loadChildren(entry,entry.nextOffset)));
          parent.append(children);
        }
      }
    }
    draw(entries,list,0); setBusy(busy);
  }
  function setBusy(value) {
    busy = value;
    ui.querySelectorAll(".wb-files-tools button[data-add], .wb-files-list button").forEach(b => { b.disabled = value || !initialized; });
  }
  function bindDragSource(name, entry) {
    let gesture = null, suppressClick = false;
    name.draggable = false;
    name.addEventListener("click", e => {
      if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    name.addEventListener("keydown", e => { if (["Enter", " "].includes(e.key)) suppressClick = false; });
    name.addEventListener("pointerdown", e => {
      if (!e.isTrusted || e.button !== 0 || e.pointerType !== "mouse" || busy || !initialized) return;
      suppressClick = false; gesture = {id:e.pointerId,x:e.clientX,y:e.clientY};
      name.setPointerCapture(e.pointerId); name.focus(); e.preventDefault();
    });
    name.addEventListener("pointermove", e => {
      if (!e.isTrusted || !gesture || gesture.id !== e.pointerId) return;
      if (!(e.buttons & 1)) { gesture = null; return; }
      if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) < 6) return;
      const id = gesture.id; gesture = null; suppressClick = true;
      if (name.hasPointerCapture(id)) name.releasePointerCapture(id);
      e.preventDefault(); e.stopPropagation(); dragOut(entry,"direct");
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) name.addEventListener(type, () => { gesture = null; });
  }
  async function dragOut(entry, mode) {
    if (busy || !initialized) return;
    dragOutPending = true; dragOutMode = mode; setBusy(true);
    fileStatus(mode === "direct" ? "请保持按住鼠标，正在准备文件拖放…" : "正在打开拖出窗口…");
    try {
      const result = await native("dragOut", entry.id, {mode});
      fileStatus(result.cancelled ? "已取消拖出。也可点击“拖出”，从本地窗口重新拖动。" : "拖放已结束，请在目标窗口确认文件。");
    } catch (error) { fileStatus(error.message,true); }
    finally { dragOutPending = false; dragOutMode = ""; setBusy(false); }
  }
  async function addEntries(action, extra = {}) {
    if (busy || !initialized) return;
    setBusy(true);
    dropPending = action === "drop";
    fileStatus(dropPending ? "正在打开本地接收框，请先保持拖动，出现接收框后再松开。" : "请在系统窗口中选择…");
    try {
      const result = await native(action, undefined, extra);
      if (result.cancelled) { fileStatus("已取消选择。"); return; }
      const next = [...entries];
      for (const entry of result.entries || []) {
        const index = next.findIndex(item => item.path.toLowerCase() === entry.path.toLowerCase() && item.kind === entry.kind);
        if (index < 0) next.push(entry);
        else {
          const merged = {...next[index],...entry};
          if (entry.rootId && next[index].rootId !== entry.rootId) {
            delete merged.children; delete merged.childrenLoaded; delete merged.expanded; delete merged.nextOffset;
          }
          next[index] = merged;
        }
      }
      await memoSet({ [filesKey]: next });
      entries = next; renderFiles(); fileStatus("关联已保存。单击名称打开，按住名称可拖出文件。");
      for (const attached of result.entries || []) {
        const archive = findEntry(attached.id);
        if (archive?.archive && !archive.childrenLoaded) await loadChildren(archive,0,true);
      }
    } catch (error) { fileStatus(error.message, true); }
    finally { dropPending = false; ui.querySelector(".wb-drop-zone").toggleAttribute("data-drag", false); setBusy(false); }
  }
  async function openEntry(entry, action) {
    if (busy) return;
    setBusy(true); fileStatus("正在打开…");
    try { await native(action, action === "open" && entry.archive ? entry.rootId : entry.id); fileStatus(action === "reveal" ? "已请求资源管理器定位。" : "已请求系统打开。"); }
    catch (error) { fileStatus(error.message, true); }
    finally { setBusy(false); }
  }
  function extensionOf(entry) {
    if (entry.kind !== "file") return "";
    const dot = entry.name.lastIndexOf(".");
    return dot > 0 ? entry.name.slice(dot) : "";
  }
  function startRename(entry, row) {
    if (busy) return;
    ui.querySelector(".wb-rename")?.remove();
    const form = document.createElement("div"); form.className = "wb-rename";
    const input = document.createElement("input"); input.type = "text"; input.maxLength = 255;
    input.setAttribute("aria-label", "新名称");
    const ext = extensionOf(entry); input.value = ext ? entry.name.slice(0, -ext.length) : entry.name;
    const help = document.createElement("div"); help.className = "wb-files-hint";
    help.textContent = (entry.extracted ? "修改解压副本（原压缩包不变）：" : "修改电脑上的原") + (entry.kind === "folder" ? "文件夹" : "文件") + "名称" + (ext ? "；扩展名 " + ext + " 保留" : "");
    async function commit() {
      if (busy) return;
      const name = input.value;
      if (!name.trim()) { fileStatus("请输入新名称。", true); return; }
      setBusy(true); input.disabled = true; fileStatus("正在改名…");
      try {
        const result = await native("rename", entry.id, {name});
        entries = mapTree(entries,result.entries || [],result.rename);
        renderFiles(); fileStatus(result.warning || "原文件已改名，关联位置已更新。");
      } catch (error) { input.disabled = false; fileStatus(error.message, true); }
      finally { setBusy(false); }
    }
    input.addEventListener("keydown", e => {
      if (!e.isTrusted) return;
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape" && !busy) form.remove();
    });
    form.append(help, input, button("确定改名", commit), button("取消", () => form.remove()));
    row.append(form); input.focus(); input.select();
  }
  async function refreshEntries() {
    if (!entries.length || busy) return;
    try {
      const ids = [];
      function collect(items) { for (const e of items) { ids.push(e.id); if (e.children) collect(e.children); } }
      collect(entries); const changed = [];
      for (let i = 0; i < ids.length; i += 1000) {
        const result = await native("describe", undefined, {ids:ids.slice(i,i+1000)}); changed.push(...(result.entries || []));
      }
      if (!changed.length || busy) return;
      const next = mapTree(entries,changed);
      if (JSON.stringify(next) !== JSON.stringify(entries)) {
        entries = next; await memoSet({[filesKey]:next}); renderFiles();
      }
    } catch {}
  }
  function cancelDrop() {
    if (dropPending) chrome.runtime.sendMessage({type:"MEMO_LOCAL_REQUEST",action:"cancelDrop"}).catch(() => {});
  }
  function cancelDragOut() {
    if (dragOutPending) chrome.runtime.sendMessage({type:"MEMO_LOCAL_REQUEST",action:"cancelDragOut"}).catch(() => {});
  }
  async function removeEntry(entry) {
    if (busy) return;
    setBusy(true);
    try {
      const next = entries.filter(item => item.id !== entry.id);
      await memoSet({ [filesKey]: next });
      entries = next; renderFiles(); fileStatus("已移除此页关联，原文件仍保留。");
    } catch { fileStatus("保存失败，请重试。", true); }
    finally { setBusy(false); }
  }
  function buildPanel() {
    host = document.createElement("div"); host.id = "wb-memo-host";
    // 关闭的 Shadow DOM 隔离网页样式，并避免网页直接读取便签及本地路径。
    ui = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style"); style.textContent = ":host {\n  --wb-memo-accent: #4a6cf7;\n  --wb-memo-bg: #ffffff;\n  --wb-memo-text: #1f2328;\n  --wb-memo-border: #e1e4e8;\n  --wb-memo-muted: #6a737d;\n}\n\n#wb-memo-panel {\n  position: fixed;\n  z-index: 2147483647;\n  width: 320px;\n  background: var(--wb-memo-bg);\n  border: 1px solid var(--wb-memo-border);\n  border-radius: 10px;\n  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);\n  font-family: -apple-system, \"Segoe UI\", \"Microsoft YaHei\", sans-serif;\n  color: var(--wb-memo-text);\n  font-size: 14px;\n  line-height: 1.5;\n  display: block;\n  overflow: hidden;\n}\n\n#wb-memo-panel.wb-memo-visible {\n  display: block;\n}\n\n.wb-memo-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 10px 12px;\n  background: var(--wb-memo-accent);\n  color: #fff;\n  cursor: move;\n  user-select: none;\n}\n\n.wb-memo-title {\n  font-weight: 600;\n  font-size: 14px;\n}\n\n.wb-memo-header-btns {\n  display: flex;\n  gap: 6px;\n}\n\n.wb-memo-btn {\n  border: none;\n  background: rgba(255, 255, 255, 0.2);\n  color: #fff;\n  border-radius: 5px;\n  cursor: pointer;\n  font-size: 12px;\n  padding: 2px 8px;\n  line-height: 1.6;\n}\n\n.wb-memo-btn:hover {\n  background: rgba(255, 255, 255, 0.35);\n}\n\n#wb-memo-textarea {\n  width: 100%;\n  box-sizing: border-box;\n  min-height: 140px;\n  padding: 10px 12px;\n  border: none;\n  outline: none;\n  resize: vertical;\n  font-family: inherit;\n  font-size: 14px;\n  color: var(--wb-memo-text);\n  background: #fafbfc;\n}\n\n#wb-memo-textarea:focus {\n  background: #fff;\n}\n\n.wb-memo-footer {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 8px 12px;\n  border-top: 1px solid var(--wb-memo-border);\n}\n\n.wb-memo-status {\n  font-size: 12px;\n  color: var(--wb-memo-muted);\n}\n\n.wb-memo-actions {\n  display: flex;\n  gap: 8px;\n}\n\n.wb-memo-actions button {\n  border: 1px solid var(--wb-memo-border);\n  background: #fff;\n  color: var(--wb-memo-text);\n  border-radius: 6px;\n  padding: 4px 10px;\n  cursor: pointer;\n  font-size: 13px;\n}\n\n.wb-memo-actions button.wb-memo-save {\n  background: var(--wb-memo-accent);\n  color: #fff;\n  border-color: var(--wb-memo-accent);\n}\n\n.wb-memo-actions button:hover {\n  opacity: 0.85;\n}\n\n#wb-memo-panel { width: 380px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); overflow:auto; }\n* { box-sizing:border-box; }\nbutton { font-family:inherit; }\nbutton:disabled { opacity:.5; cursor:wait; }\n.wb-files { padding:10px 12px; border-top:1px solid #e1e4e8; background:white; }\n.wb-files-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }\n.wb-files-head strong { font-size:13px; }\n.wb-files-tools { display:flex; gap:5px; margin:8px 0; flex-wrap:wrap; }\n.wb-files button { font-size:12px; border:1px solid #d3dbe7; border-radius:5px; background:#f8fafc; padding:4px 7px; color:#243041; cursor:pointer; }\n.wb-file-row { padding:8px 0; border-top:1px solid #eef1f5; }\n.wb-file-row .wb-file-name { cursor:grab; user-select:none; touch-action:none; display:block; max-width:100%; text-align:left; color:#2854b5; background:none; border:0; padding:0; font-size:13px; font-weight:600; overflow-wrap:anywhere; }\n.wb-file-path { font-size:11px; color:#65758b; overflow-wrap:anywhere; margin:3px 0 5px; }\n.wb-file-actions { display:flex; gap:6px; }\n.wb-files-hint { font-size:12px; color:#65758b; margin:5px 0; }\n.wb-files-status { font-size:12px; line-height:1.6; color:#345890; overflow-wrap:anywhere; }\n.wb-files-status[data-error] { color:#ad302a; }\n.wb-files-list { max-height:230px; overflow:auto; }\n.wb-memo-footer { gap:8px; }\nbutton:focus-visible { outline:2px solid #315ed4; outline-offset:2px; }\n\n.wb-drop-zone { border:2px dashed #a8b9de; border-radius:7px; padding:12px 8px; margin:8px 0; text-align:center; color:#3159a4; background:#f3f7ff; font-size:13px; cursor:pointer; }\n.wb-drop-zone small { font-size:11px; color:#6c7e98; }\n.wb-drop-zone[data-drag] { background:#e0ecff; border-color:#315ed4; }\n.wb-rename { padding:8px 0; }\n.wb-rename input { width:100%; font:13px inherit; padding:6px; border:1px solid #b6c5df; border-radius:4px; margin:4px 0; }\n.wb-rename button { margin-right:6px; }\n\n.wb-file-children { border-left:2px solid #dce6f6; margin-left:8px; padding-left:10px; }\n.wb-file-actions { flex-wrap:wrap; }\n.wb-files-list { max-height:340px; }\n";
    ui.append(style);
    panel = document.createElement("section"); panel.id = "wb-memo-panel"; panel.setAttribute("aria-label", "本页备忘录");
    panel.innerHTML = `
      <div class="wb-memo-header"><span class="wb-memo-title">📝 本页备忘录</span><span class="wb-memo-header-btns"><button type="button" class="wb-memo-btn" id="wb-memo-close" aria-label="关闭备忘录">✕</button></span></div>
      <textarea id="wb-memo-textarea" aria-label="备忘录文字" placeholder="为什么留下这一篇？有什么值得参考？"></textarea>
      <div class="wb-memo-footer"><span class="wb-memo-status" id="wb-memo-status" role="status"></span><span class="wb-memo-actions"><button type="button" id="wb-memo-clear">清空文字</button><button type="button" id="wb-memo-save" class="wb-memo-save">保存</button></span></div>
      <div class="wb-files"><div class="wb-files-head"><strong>本地补充材料</strong></div><div class="wb-files-tools"></div><div class="wb-drop-zone" role="button" tabindex="0" aria-label="拖入文件或文件夹">把文件、文件夹或 ZIP 拖到这里<br><small>出现本地接收框后松开鼠标；也可点击先打开接收框</small></div><div class="wb-files-list"></div><div class="wb-files-status" role="status"></div></div>`;
    ui.append(panel);
    panel.style.right = "20px"; panel.style.bottom = "20px";
    host.style.cssText = "all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;display:block!important;";
    document.documentElement.append(host);
    textarea = ui.querySelector("textarea"); statusEl = ui.querySelector("#wb-memo-status");
    filesStatus = ui.querySelector(".wb-files-status"); list = ui.querySelector(".wb-files-list");
    const tools = ui.querySelector(".wb-files-tools");
    for (const [label, action] of [["＋ 添加文件", "chooseFiles"], ["＋ 添加文件夹", "chooseFolder"]]) {
      const b = button(label, () => addEntries(action)); b.dataset.add = "true"; tools.append(b);
    }
    tools.append(button("本地文件设置", async () => {
      try { await chrome.runtime.sendMessage({ type: "MEMO_LOCAL_SETTINGS" }); }
      catch { fileStatus("扩展已更新，请刷新文献页面。", true); }
    }));
    ui.querySelector("#wb-memo-close").addEventListener("click", () => { cancelDrop(); cancelDragOut(); host.style.setProperty("display", "none", "important"); });
    ui.querySelector("#wb-memo-save").addEventListener("click", save);
    ui.querySelector("#wb-memo-clear").addEventListener("click", () => { textarea.value = ""; save(); });
    textarea.addEventListener("input", save);
    let drag;
    ui.querySelector(".wb-memo-header").addEventListener("pointerdown", e => {
      if (e.target.closest("button") || e.button !== 0) return;
      const rect = panel.getBoundingClientRect(); drag = { x:e.clientX, y:e.clientY, left:rect.left, top:rect.top };
      e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault();
    });
    ui.querySelector(".wb-memo-header").addEventListener("pointermove", e => {
      if (!drag) return;
      panel.style.left = Math.max(0, Math.min(innerWidth - panel.offsetWidth, drag.left + e.clientX - drag.x)) + "px";
      panel.style.top = Math.max(0, Math.min(innerHeight - 45, drag.top + e.clientY - drag.y)) + "px";
      panel.style.right = "auto"; panel.style.bottom = "auto";
    });
    for (const event of ["pointerup", "lostpointercapture"]) ui.querySelector(".wb-memo-header").addEventListener(event, () => { drag = null; });
    const zone = ui.querySelector(".wb-drop-zone");
    function beginDrop(placement) { if (!busy && initialized) addEntries("drop", {placement}); }
    zone.addEventListener("click", e => { if (e.isTrusted) beginDrop("center"); });
    zone.addEventListener("keydown", e => { if (e.isTrusted && ["Enter", " "].includes(e.key)) { e.preventDefault(); beginDrop("center"); } });
    document.addEventListener("visibilitychange", () => { if (document.hidden) cancelDrop(); });
    window.addEventListener("pagehide", () => { cancelDrop(); cancelDragOut(); });
    renderFiles();
  }
  function save() {
    if (!initialized) return;
    const text = textarea.value; statusEl.textContent = "正在保存…";
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await memoSet({ [storageKey]: text });
      if (textarea.value === text) statusEl.textContent = "已保存到 D 盘";
    }).catch(error => { statusEl.textContent = "保存失败：" + error.message; });
    return saveQueue;
  }
  async function open() {
    if (!panel) buildPanel();
    host.style.setProperty("display", "block", "important");
    if (!initialized && !loading) {
      textarea.disabled = true;
      ui.querySelector("#wb-memo-clear").disabled = true;
      ui.querySelector("#wb-memo-save").disabled = true;
      loading = (async () => {
        try {
          const result = await memoGet([storageKey, filesKey]);
          textarea.value = typeof result[storageKey] === "string" ? result[storageKey] : "";
          entries = Array.isArray(result[filesKey]) ? result[filesKey].filter(e => e && /^[a-f0-9]{32}$/.test(e.id) && typeof e.path === "string" && typeof e.name === "string" && ["file", "folder"].includes(e.kind)) : [];
          initialized = true; statusEl.textContent = textarea.value ? "已保存到 D 盘" : "输入自动保存到 D 盘"; renderFiles();
        } catch (error) { statusEl.textContent = "读取失败：" + error.message; }
        finally {
          textarea.disabled = !initialized;
          ui.querySelector("#wb-memo-clear").disabled = !initialized;
          ui.querySelector("#wb-memo-save").disabled = !initialized;
          setBusy(false);
        }
      })();
    }
    await loading; loading = null;
    if (initialized) { textarea.focus(); refreshEntries(); }
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type === "MEMO_DATA_CHANGED" && initialized && Object.hasOwn(msg.values || {},filesKey)) {
      entries = msg.values[filesKey] || []; renderFiles(); return;
    }
    if (msg?.type === "MEMO_DROP_READY") { fileStatus("本地接收框已打开，请拖到接收框中松开鼠标。"); return; }
    if (msg?.type === "MEMO_DRAG_READY") { fileStatus(dragOutMode === "direct" ? "保持按住鼠标，拖到目标窗口后松开。" : "请按住本地窗口中的文件名称，拖到目标窗口后松开。"); return; }
    if (msg?.type === "OPEN_MEMO") { open().then(() => reply({ ok: true })); return true; }
  });
})();
