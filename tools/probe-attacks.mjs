// probe-attacks.mjs — 用真实内核逐个验证「网页能怎么弄坏扩展 UI」。
// 用法: node tools/probe-attacks.mjs [cdpBase] [attacksUrl]
// 每个攻击模式都在新标签页里跑：注入 → 抓题渲染气泡 → 检查 可见/在最上层/可点击/被删后能否自愈。
const CDP = process.argv[2] || "http://127.0.0.1:9338";
const BASE = process.argv[3] || "http://127.0.0.1:8123/attacks.html";

const ATTACKS = [
  ["none", "对照组：无攻击"],
  ["sweep", "MutationObserver + 定时清理：删除所有注入到 <html> 的未知节点"],
  ["sweepbody", "更狠一档：连 <body> 里新增的节点也定时+MutationObserver 清掉"],
  ["wipeonce", "单次暴力删除扩展宿主节点"],
  ["css", "页内 CSS 强杀：#aqh-root / * / [data-act] + user-select:none"],
  ["zfight", "全屏遮罩抢 z-index=2147483647，并反复后置"],
  ["blockclick", "window 捕获阶段吞掉 click/pointerdown"],
  ["monkey", "页面世界猴子补丁：appendChild/remove/removeChild/MutationObserver/getSelection"],
  ["selectnone", "禁用文本选择（划词通道）"],
  ["transformbody", "body 带 transform（会破坏 fixed 定位），应自动回退挂到 <html>"],
];

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
    st.send = (method, params = {}) =>
      new Promise((r) => { const id = ++st.id; st.pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    ws.addEventListener("open", () => resolve(st));
    ws.addEventListener("error", () => reject(new Error("ws failed: " + wsUrl)));
  });
}

function finish(code) {
  process.exitCode = code;
  for (const st of OPEN) { try { st.ws.close(); } catch (e) { void e; } }
  setTimeout(() => process.exit(code), 500).unref();
}

async function evalIn(st, expression) {
  const m = await st.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const o = m.result || {};
  if (o.exceptionDetails) return { error: o.exceptionDetails.exception?.description || o.exceptionDetails.text };
  return { value: o.result ? o.result.value : undefined };
}
const asJson = (e) => { try { return e.value === undefined || e.value === null ? null : JSON.parse(e.value); } catch { return null; } };

const targets = () => fetch(CDP + "/json/list").then((r) => r.json());
const version = await (await fetch(CDP + "/json/version")).json();
const browser = await rpc(version.webSocketDebuggerUrl);

// MV3 的 service worker 空闲三十秒就会被回收，所以每次用之前都要重新找；
// 打开一个页面时内容脚本的 get-config 会把它唤醒。
async function findSW(timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = (await targets()).find((x) => x.type === "service_worker" && x.url.includes("background.js"));
    if (t) return await rpc(t.webSocketDebuggerUrl);
    await sleep(300);
  }
  return null;
}
// 如果 SW 正在休眠，用一个临时页面把它叫醒（内容脚本启动时的 get-config 就是唤醒信号）。
async function wakeAndFindSW() {
  let sw = await findSW(1500);
  if (sw) return sw;
  const warm = await browser.send("Target.createTarget", { url: BASE });
  const warmId = warm.result?.targetId;
  sw = await findSW(8000);
  if (warmId) await browser.send("Target.closeTarget", { targetId: warmId });
  return sw;
}
const swProbe = await wakeAndFindSW();
if (!swProbe) { console.error("找不到扩展 service worker —— 扩展可能没加载成功"); finish(2); }

const CHECK = `(() => {
  const out = { host: false, connected: false, bubble: false, parent: "", display: "", visibility: "", opacity: "",
                w: 0, h: 0, top: "", ontop: false, topLayer: false, inShadow: false };
  const host = document.getElementById("aqh-root");
  out.host = !!host;
  out.connected = !!(host && host.isConnected);
  if (!host) return JSON.stringify(out);
  out.parent = host.parentElement ? host.parentElement.tagName : "";
  const cs = getComputedStyle(host);
  out.display = cs.display; out.visibility = cs.visibility; out.opacity = cs.opacity;
  try { out.topLayer = host.matches(":popover-open"); } catch (e) {}
  const sr = host.shadowRoot;
  out.inShadow = !!sr;
  const b = sr ? sr.getElementById("aqh-bubble") : document.getElementById("aqh-bubble");
  out.bubble = !!b;
  if (!b) return JSON.stringify(out);
  const r = b.getBoundingClientRect();
  out.w = Math.round(r.width); out.h = Math.round(r.height);
  const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  const el = document.elementFromPoint(cx, cy);
  out.top = el ? (el.id || el.tagName) : "(null)";
  out.ontop = !!(el && (el === host || host.contains(el)));
  const btn = (sr || document).querySelector('[data-act="close"]');
  if (btn) { const br = btn.getBoundingClientRect(); out.close = { x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2) }; }
  return JSON.stringify(out);
})()`;

const results = [];

for (const [name, label] of ATTACKS) {
  const url = BASE + "?atk=" + name;
  const created = await browser.send("Target.createTarget", { url });
  const targetId = created.result?.targetId;
  if (!targetId) { results.push({ name, label, fatal: "createTarget failed" }); continue; }

  // 等页面目标出现并加载完成
  let pageTarget = null;
  for (let i = 0; i < 40 && !pageTarget; i++) {
    await sleep(150);
    pageTarget = (await targets()).find((t) => t.type === "page" && t.url.includes("atk=" + name));
  }
  if (!pageTarget) { results.push({ name, label, fatal: "no page target" }); continue; }

  const page = await rpc(pageTarget.webSocketDebuggerUrl);
  await browser.send("Target.activateTarget", { targetId });
  await sleep(900);

  const sw = await findSW();
  if (!sw) { results.push({ name, label, fatal: "service worker 未就绪" }); continue; }

  // 触发一次抓题（无选区 → 渲染提示气泡），只发给顶层框架
  await evalIn(sw, `new Promise(async r => {
    const q = ${JSON.stringify(BASE.replace(/attacks\.html.*$/, "") + "*")};
    const tabs = await chrome.tabs.query({ url: q });
    const tab = tabs[tabs.length - 1];
    if (!tab) return r("no-tab");
    try { await chrome.tabs.sendMessage(tab.id, { type: "aqh/capture", payload: { kind: "selection" } }, { frameId: 0 }); }
    catch (e) { return r("send-failed:" + ((e && e.message) || e)); }
    r("sent");
  })`);
  await sleep(1700);

  const before = asJson(await evalIn(page, CHECK));

  // 可点击性：先测——在 ✕ 按钮中心派发真实鼠标事件，气泡应当关闭
  let clickable = null;
  if (before?.close) {
    await browser.send("Target.activateTarget", { targetId });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: before.close.x, y: before.close.y, button: "left", clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: before.close.x, y: before.close.y, button: "left", clickCount: 1 });
    await sleep(400);
    const after = asJson(await evalIn(page, CHECK));
    clickable = after ? !after.bubble : null;
  }

  // 自愈：重新画一个气泡，然后从页面侧把宿主删掉，等一个心跳周期后应当自动
  // 回来，且气泡内容还在。
  const trigger = `new Promise(async r => {
    const tabs = await chrome.tabs.query({ url: ${JSON.stringify(BASE.replace(/attacks\.html.*$/, "") + "*")} });
    const tab = tabs[tabs.length - 1];
    try { await chrome.tabs.sendMessage(tab.id, { type: "aqh/capture", payload: { kind: "selection" } }, { frameId: 0 }); r("sent"); }
    catch (e) { r("failed"); }
  })`;
  await evalIn(sw, trigger);
  await sleep(700);
  await evalIn(page, `(() => { const h = document.getElementById("aqh-root"); if (h) h.remove(); return 1; })()`);
  let healed = false;
  for (let i = 0; i < 15; i++) {
    await sleep(110);
    const s = asJson(await evalIn(page, CHECK));
    if (s?.host && s?.connected && s?.bubble) { healed = true; break; }
  }

  const visible = !!before?.bubble && before.display !== "none" && before.visibility !== "hidden" &&
    Number(before.opacity) > 0.05 && before.w > 100 && before.h > 40;
  results.push({
    name, label,
    rendered: !!before?.bubble, visible, ontop: !!before?.ontop, topLayer: !!before?.topLayer,
    healed, clickable, top: before?.top, parent: before?.parent,
  });
  await browser.send("Target.closeTarget", { targetId });
}

console.log("\n攻击模式逐个实测（新版：Shadow DOM + 顶层 + 自愈 + 捕获期事件）");
console.log("模式".padEnd(14) + "渲染  可见  最上层  顶层  自愈  可点击  挂载点  对方盖在上面的是");
for (const r of results) {
  if (r.fatal) { console.log(r.name.padEnd(14) + " 执行失败: " + r.fatal); continue; }
  const y = (v) => (v === true ? " ✓ " : v === false ? " ✗ " : " ? ");
  console.log(r.name.padEnd(14) + y(r.rendered) + "  " + y(r.visible) + "  " + y(r.ontop) + "   " + y(r.topLayer) + "  " + y(r.healed) + "  " + y(r.clickable) + "   " + String(r.parent || "-").padEnd(6) + " " + (r.top || ""));
}
const broken = results.filter((r) => r.fatal || !r.visible || !r.ontop || r.clickable === false);
console.log("\n" + (broken.length ? "仍会被弄坏的场景: " + broken.map((r) => r.name).join(", ") : "全部场景下 UI 都活着"));
finish(broken.length ? 1 : 0);
