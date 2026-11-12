"use strict";
document.querySelector("#extension-id").value = chrome.runtime.id;
const status = document.querySelector("#status");
document.querySelector("#copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(chrome.runtime.id); status.textContent = "ID 已复制，请粘贴到安装窗口。"; }
  catch { document.querySelector("#extension-id").select(); status.textContent = "请按 Ctrl+C 复制 ID。"; }
});
document.querySelector("#test").addEventListener("click", async () => {
  status.textContent = "正在检查…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "MEMO_LOCAL_REQUEST", action: "ping" });
    if (result?.ok && result.features?.includes("zip") && result.features?.includes("drop") && result.features?.includes("rename") && result.features?.includes("dragOut") && result.features?.includes("memoData")) {
      const storage = await chrome.runtime.sendMessage({type:"MEMO_DATA_READ",keys:[]});
      if (!storage?.ok) { status.textContent = storage?.error || "D 盘数据目录无法访问。"; return; }
      status.textContent = "连接成功（助手 " + result.version + "）。文字和附件列表保存到 D 盘，支持拖入、拖出和 ZIP 展开。";
    } else if (result?.ok) {
      status.textContent = "已连接旧版助手（" + (result.version || "未知版本") + "）。请重新运行新包里的 Install.cmd，更新后再检查连接。";
    } else { status.textContent = result?.error || "未连接，请检查安装时填写的扩展 ID。"; }
  } catch { status.textContent = "扩展连接失败，请在 edge://extensions/ 重新加载扩展，再打开本页。"; }
});
