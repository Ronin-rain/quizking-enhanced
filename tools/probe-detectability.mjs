// probe-detectability.mjs — 站在“网站脚本”的视角，量一量它能观测到扩展的什么。
// 用法: node tools/probe-detectability.mjs [cdpBase] [pageUrl]
// 分两个状态测：页面刚加载完（未使用扩展）与气泡已显示（使用中）。
const CDP = process.argv[2] || "http://127.0.0.1:9340";
const PAGE = process.argv[3] || "http://127.0.0.1:8123/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPEN = [];

function rpc(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const st = { id: 0, pending: new Map(), ws };
    OPEN.push(st);
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && st.pending.has(m.id)) { const d = st.pending.get(m.id); st.pending.delete(m.id); d(m); }
    });
    st.send = (method, params = {}) => new Promise((r) => { const id = ++st.id; st.pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    ws.addEventListener("open", () => resolve(st));
    ws.addEventListener("error", () => reject(new Error("ws failed " + wsUrl)));
  });
}
function finish(code) {
  process.exitCode = code;
  for (const st of OPEN) { try { st.ws.close(); } catch (e) { void e; } }
  setTimeout(() => process.exit(code), 500).unref();
}
async function ev(st, expr) {
  const m = await st.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  const o = m.result || {};
  if (o.exceptionDetails) return { error: o.exceptionDetails.exception?.description || o.exceptionDetails.text };
  return { value: o.result ? o.result.value : undefined };
}
const targets = () => fetch(CDP + "/json/list").then((r) => r.json());
async function findSW() {
  for (let i = 0; i < 30; i++) {
    const t = (await targets()).find((x) => x.type === "service_worker" && x.url.includes("background.js"));
    if (t) return rpc(t.webSocketDebuggerUrl);
    await sleep(300);
  }
  return null;
}

// 这段代码运行在页面主世界，也就是网站脚本能拿到的一切。
const SURFACE = `(() => {
  const desc = (el) => el.tagName.toLowerCase()
    + (el.id ? "#" + el.id : "")
    + (el.getAttributeNames().length ? "[" + el.getAttributeNames().join(",") + "]" : "");
  const known = (el) => ["HEAD", "BODY", "SCRIPT", "STYLE", "LINK", "META", "TITLE", "DIV", "H1", "P", "IFRAME", "SPAN", "B", "A"].includes(el.tagName);
  const foreign = [];
  for (const el of document.documentElement.children) if (!known(el)) foreign.push("html>" + desc(el));
  for (const el of document.body.children) if (el.id && el.id.startsWith("aqh")) foreign.push("body>" + desc(el));
  const host = document.getElementById("aqh-root");
  let hostInfo = null;
  if (host) {
    const cs = getComputedStyle(host);
    hostInfo = {
      tag: desc(host),
      hasStyleAttr: host.hasAttribute("style"),
      shadowRootReadable: !!host.shadowRoot,
      innerNodes: host.shadowRoot ? host.shadowRoot.querySelectorAll("*").length : 0,
      position: cs.position,
      zIndex: cs.zIndex,
      display: cs.display,
      inTopLayer: (() => { try { return host.matches(":popover-open"); } catch (e) { return "n/a"; } })(),
    };
  }
  const extSheets = Array.from(document.styleSheets)
    .map((s) => s.href || "(inline)")
    .filter((h) => h.includes("chrome-extension"));
  return JSON.stringify({
    foreignNodes: foreign,
    host: hostInfo,
    chromeExtensionStylesheets: extSheets,
    pageWorldHasChromeRuntime: !!(window.chrome && window.chrome.runtime && window.chrome.runtime.id),
    pageWorldGlobalMarker: typeof window.__aqh_injected__,
    pageWorldGlobalConfig: typeof window.cfg,
  });
})()`;

const sw = await findSW();
if (!sw) { console.error("扩展 service worker 不可用"); finish(2); }

// 必须用全新的标签页，否则量到的是上一轮已经用过的页面。
const version = await (await fetch(CDP + "/json/version")).json();
const browser = await rpc(version.webSocketDebuggerUrl);
const created = await browser.send("Target.createTarget", { url: PAGE });
const targetId = created.result?.targetId;
let pageTarget = null;
for (let i = 0; i < 40 && !pageTarget; i++) {
  await sleep(150);
  pageTarget = (await targets()).find((t) => t.type === "page" && t.url.startsWith(PAGE) && (!targetId || t.id === targetId))
    || (await targets()).find((t) => t.type === "page" && t.url.startsWith(PAGE));
}
if (!pageTarget) { console.error("找不到页面目标"); finish(2); }
const page = await rpc(pageTarget.webSocketDebuggerUrl);
const tabId = (await ev(sw, `new Promise(async r => {
  const tabs = await chrome.tabs.query({ url: ${JSON.stringify(PAGE.replace(/\/$/, "") + "/*")} });
  r(tabs.length ? tabs[tabs.length - 1].id : null);
})`)).value;
await sleep(600);

const parse = (e) => { try { return JSON.parse(e.value); } catch { return { error: e.error || String(e.value) }; } };
const show = (title, s) => {
  console.log("\n[" + title + "]");
  console.log("  非页面自有节点           : " + (s.foreignNodes.length ? s.foreignNodes.join(", ") : "无"));
  console.log("  页面世界里 chrome.runtime : " + (s.pageWorldHasChromeRuntime ? "可见（泄漏！）" : "不可见"));
  console.log("  页面世界里的扩展全局变量 : " + s.pageWorldGlobalMarker + " / " + s.pageWorldGlobalConfig);
  console.log("  带 chrome-extension 的样式表: " + (s.chromeExtensionStylesheets.length ? s.chromeExtensionStylesheets.join(", ") : "无"));
  if (s.host) {
    console.log("  宿主节点                : " + s.host.tag);
    console.log("    内联 style 属性        : " + (s.host.hasStyleAttr ? "有" : "无"));
    console.log("    shadowRoot 可读        : " + s.host.shadowRootReadable + " (" + s.host.innerNodes + " 个内部节点)");
    console.log("    position/z-index/display: " + s.host.position + " / " + s.host.zIndex + " / " + s.host.display + "，顶层=" + s.host.inTopLayer);
  } else {
    console.log("  宿主节点                : 无");
  }
};

const idle = parse(await ev(page, SURFACE));
show("页面刚加载完（未使用扩展）", idle);

// 触发一次抓题，再量一遍
await ev(sw, `new Promise(async r => {
  try { await chrome.tabs.sendMessage(${JSON.stringify(tabId)}, { type: "aqh/capture", payload: { kind: "selection" } }, { frameId: 0 }); r(1); }
  catch (e) { r(0); }
})`);
await sleep(900);
const active = parse(await ev(page, SURFACE));
show("气泡显示中（使用中）", active);

// 点 ✕ 关掉气泡后，宿主节点应当整个从页面里消失
await ev(sw, `new Promise(async r => {
  try { await chrome.tabs.sendMessage(${JSON.stringify(tabId)}, { type: "aqh/close" }, { frameId: 0 }); r(1); }
  catch (e) { r(0); }
})`);
await sleep(500);
const closed = parse(await ev(page, SURFACE));
show("关掉气泡后（不使用时）", closed);

const okIdle = idle.foreignNodes.length === 0 && !idle.pageWorldHasChromeRuntime &&
  idle.chromeExtensionStylesheets.length === 0 && idle.pageWorldGlobalMarker === "undefined";
const okActive = active.foreignNodes.length === 1 && active.host && active.host.hasStyleAttr === false &&
  active.chromeExtensionStylesheets.length === 0 && !active.pageWorldHasChromeRuntime;
const okClosed = closed.foreignNodes.length === 0;
console.log("\n" + (okIdle ? "PASS" : "FAIL") + "  未使用时：页面看不到任何扩展痕迹");
console.log((okActive ? "PASS" : "FAIL") + "  使用时：痕迹仅剩 1 个无 style 属性的宿主节点（这是无法隐藏的部分）");
console.log((okClosed ? "PASS" : "FAIL") + "  关闭气泡后：宿主节点被整体摘除，回到零痕迹");
if (targetId) await browser.send("Target.closeTarget", { targetId });
finish(okIdle && okActive && okClosed ? 0 : 1);
