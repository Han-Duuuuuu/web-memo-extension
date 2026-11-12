(function () {
  "use strict";
  const HOST = "com.webmemo.localfiles";
  const drops = new Map();
  const drags = new Map();
  let renameQueue = Promise.resolve();
  async function nativeRequest(message) {
    try { return await chrome.runtime.sendNativeMessage(HOST, message); }
    catch (error) {
      console.warn("本地文件助手未连接", error);
      return { ok: false, code: "HOST_UNAVAILABLE", error: "本地文件助手未连接，请先点击“本地文件设置”完成安装。" };
    }
  }
  let dataQueue = Promise.resolve(), migrated = false;
  function dataTask(task) {
    const result = dataQueue.catch(() => {}).then(task);
    dataQueue = result; return result;
  }
  function validKey(key) { return typeof key === "string" && key.startsWith("wb_memo_") && key.length <= 16000; }
  async function disk(op, extra = {}) {
    const result = await nativeRequest({action:"memoData",op,...extra});
    if (!result?.ok) throw new Error(result?.error || "D 盘保存失败，请更新本地助手。");
    return result;
  }
  async function migrate() {
    if (migrated) return;
    // 每条记录写入成功后才移除浏览器旧记录；中断后可继续，磁盘已有数据优先。
    const old = await chrome.storage.local.get(null);
    for (const [key,value] of Object.entries(old)) {
      if (!validKey(key)) continue;
      await disk("import", {key,value});
      await chrome.storage.local.remove(key);
    }
    migrated = true;
  }
  async function notify(values) {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id,{type:"MEMO_DATA_CHANGED",values},{frameId:0})));
  }
  function cancelDrop(tabId) { drops.get(tabId)?.finish({ ok: true, cancelled: true }); }
  function cancelDragOut(tabId) { drags.get(tabId)?.finish({ ok: true, cancelled: true }); }
  function nativeSession(tabId, action, request) {
    const sessions = action === "drop" ? drops : drags;
    if (sessions.has(tabId)) return Promise.resolve({ ok:false, error:"已有拖放操作，请先完成或关闭本地窗口。" });
    return new Promise(resolve => {
      let port, timer, finished = false;
      const finish = result => {
        if (finished) return; finished = true; sessions.delete(tabId); clearTimeout(timer);
        if (port) { try { port.disconnect(); } catch {} }
        resolve(result);
      };
      try {
        port = chrome.runtime.connectNative(HOST);
        sessions.set(tabId, { finish });
        timer = setTimeout(() => finish({ok:false,error:"拖放等待超时，请重试。"}), 125000);
        port.onMessage.addListener(result => {
          if (result.ready) {
            chrome.tabs.sendMessage(tabId, {type:action === "drop" ? "MEMO_DROP_READY" : "MEMO_DRAG_READY"}, {frameId:0}).catch(() => {});
          } else { finish(result); }
        });
        port.onDisconnect.addListener(() => {
          const error = chrome.runtime.lastError;
          finish({ok:false,error:error ? "本地助手未连接或版本过旧，请重新运行新包里的 Install.cmd。" : "本地拖放窗口已关闭，请重试。"});
        });
        port.postMessage({action,...request});
      } catch { finish({ok:false,error:"无法启动本地拖放，请检查本地文件设置。"}); }
    });
  }
  async function propagateEntries(changed, rename) {
    if (!changed?.length && !rename) return;
    const byId = new Map((changed || []).map(e => [e.id,e]));
    function map(items) {
      return items.map(item => {
        let e = byId.has(item.id) ? {...item,...byId.get(item.id)} : {...item};
        if (rename && typeof e.path === "string") {
          const current = e.path.toLowerCase(), old = rename.oldPath.toLowerCase();
          if (current === old || (rename.folder && current.startsWith(old + "\\"))) {
            e.path = rename.newPath + e.path.slice(rename.oldPath.length); e.name = e.path.split(/[\\/]/).pop();
          }
        }
        if (e.children) e.children = map(e.children); return e;
      });
    }
    const all = {}, updates = {};
    for (let offset = 0; ; offset += 100) {
      const page = await disk("keys",{offset});
      for (const key of page.keys) all[key] = (await disk("get",{key})).value;
      if (!page.more) break;
    }
    for (const [key,value] of Object.entries(all)) {
      if (!key.startsWith("wb_memo_attachments_") || !Array.isArray(value)) continue;
      const next = map(value); if (JSON.stringify(next) !== JSON.stringify(value)) updates[key] = next;
    }
    for (const [key,value] of Object.entries(updates)) await disk("set",{key,value});
    if (Object.keys(updates).length) await notify(updates);
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !message) return;
    if (message.type === "MEMO_LOCAL_SETTINGS") {
      chrome.runtime.openOptionsPage().then(() => reply({ok:true}), () => reply({ok:false})); return true;
    }
    if (["MEMO_DATA_READ","MEMO_DATA_WRITE"].includes(message.type)) {
      dataTask(async () => {
        await migrate();
        if (message.type === "MEMO_DATA_READ") {
          if (!Array.isArray(message.keys) || message.keys.length > 2 || !message.keys.every(validKey)) throw new Error("存储键无效");
          const values = {};
          for (const key of message.keys) { const r = await disk("get",{key}); if (r.exists) values[key] = r.value; }
          return {ok:true,values};
        }
        const pairs = Object.entries(message.values || {});
        if (pairs.length !== 1 || !validKey(pairs[0][0])) throw new Error("存储内容无效");
        for (const [key,value] of pairs) await disk("set",{key,value});
        // 通知失败不改变已经落盘的保存结果。
        try { await notify(message.values); } catch {}
        return {ok:true};
      }).then(reply,error=>reply({ok:false,error:error.message})); return true;
    }
    if (message.type !== "MEMO_LOCAL_REQUEST") return;
    const action = message.action;
    if (!["ping","chooseFiles","chooseFolder","drop","cancelDrop","dragOut","cancelDragOut","open","reveal","rename","describe","list"].includes(action)) {
      reply({ok:false,error:"不支持的操作"}); return;
    }
    if (["open","reveal","rename","list","dragOut"].includes(action) && !/^[a-f0-9]{32}$/.test(message.id || "")) {
      reply({ok:false,error:"关联无效，请重新添加"}); return;
    }
    if (["drop","cancelDrop","dragOut","cancelDragOut"].includes(action)) {
      if (!Number.isInteger(sender.tab?.id)) { reply({ok:false,error:"请从文献页的备忘录开启拖放。"}); return; }
      if (action === "cancelDrop") { cancelDrop(sender.tab.id); reply({ok:true}); }
      else if (action === "cancelDragOut") { cancelDragOut(sender.tab.id); reply({ok:true}); }
      else if (action === "dragOut") nativeSession(sender.tab.id, action, {id:message.id, mode:message.mode === "direct" ? "direct" : "window"}).then(reply);
      else nativeSession(sender.tab.id, action, {placement:message.placement === "cursor" ? "cursor" : "center"}).then(reply);
      return true;
    }
    if (action === "rename") {
      if (typeof message.name !== "string" || !message.name.trim() || message.name.length > 255) {
        reply({ok:false,error:"请输入有效的新名称。"}); return;
      }
      renameQueue = renameQueue.catch(() => {}).then(() => dataTask(async () => {
        await migrate();
        const result = await nativeRequest({action, id:message.id, name:message.name});
        if (result.ok) {
          try { await propagateEntries(result.entries,result.rename); }
          catch { result.warning = "原文件已改名，部分关联列表保存失败；重新打开便签可刷新。"; }
        }
        return result;
      }));
      renameQueue.then(reply, () => reply({ok:false,error:"改名失败，请重试。"})); return true;
    }
    if (action === "list") {
      const offset = message.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) { reply({ok:false,error:"目录页码无效"}); return; }
      nativeRequest({action,id:message.id,offset}).then(reply); return true;
    }
    if (action === "describe") {
      if (!Array.isArray(message.ids) || message.ids.length > 2000 || message.ids.some(id => !/^[a-f0-9]{32}$/.test(id))) {
        reply({ok:false,error:"关联列表无效"}); return;
      }
      nativeRequest({action,ids:message.ids}).then(reply); return true;
    }
    nativeRequest({action,id:message.id}).then(reply); return true;
  });
  chrome.tabs.onRemoved.addListener(cancelDrop);
  chrome.tabs.onRemoved.addListener(cancelDragOut);
  chrome.tabs.onActivated.addListener(info => { for (const tabId of [...drops.keys()]) if (tabId !== info.tabId) cancelDrop(tabId); });
  // 拖出时允许悬停切换到目标标签页；只在来源页关闭或导航时取消。
  chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === "loading") { cancelDrop(tabId); cancelDragOut(tabId); } });
})();
