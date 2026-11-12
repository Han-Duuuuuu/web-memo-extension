importScripts("attachments.js");
// 安装或更新时注册菜单；浏览器右键菜单仍保留。
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "memo-open",
      title: "在此页记备忘录",
      contexts: ["all"]
    });
  });
});

async function openMemo(tab) {
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "OPEN_MEMO" }, { frameId: 0 });
  } catch (error) {
    // 安装扩展前已打开的普通网页没有自动注入内容脚本，点击时补注入。
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "OPEN_MEMO" }, { frameId: 0 });
    } catch (injectionError) {
      console.warn("无法在此页面打开备忘录：", injectionError);
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "memo-open") openMemo(tab);
});
chrome.action.onClicked.addListener(openMemo);
