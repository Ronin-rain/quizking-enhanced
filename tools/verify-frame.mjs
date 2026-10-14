// verify-frame.mjs — 验证「题目在 iframe 里」时划词通道是否还能用。
// 用法: node tools/verify-frame.mjs [cdpBase] [framePageUrl]
const CDP = process.argv[2] || "http://127.0.0.1:9338";
const PAGE = process.argv[3] || "http://127.0.0.1:8123/frame.html";
const NEEDLE = "IFRAME-QUESTION-42";
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

// 干净的收尾：关掉所有调试连接，避免 Node 退出时和未关闭的句柄打架。
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

const sw = await findSW();
if (!sw) { console.error("扩展 service worker 不可用"); finish(2); }

// 用 background 打开 iframe 场景页（也顺便验证 SW 能正常开标签页）
const opened = await ev(sw, `new Promise(r => chrome.tabs.create({ url: ${JSON.stringify(PAGE)} }, t => r(t && t.id)))`);
const tabId = opened.value;
if (tabId === undefined || tabId === null) { console.error("打不开测试页"); finish(2); }
await sleep(2200);

const sent = await ev(sw, `new Promise(async r => {
  try { await chrome.tabs.sendMessage(${tabId}, { type: "aqh/capture", payload: { kind: "selection" } }, { frameId: 0 }); r("sent"); }
  catch (e) { r("failed:" + ((e && e.message) || e)); }
})`);
await sleep(1200);

const pageTarget = (await targets()).find((t) => t.type === "page" && t.url.startsWith(PAGE));
if (!pageTarget) { console.error("找不到页面目标"); finish(2); }
const page = await rpc(pageTarget.webSocketDebuggerUrl);
const bodyText = (await ev(page, `(() => {
  const h = document.getElementById("aqh-root");
  const sr = h && h.shadowRoot;
  const body = sr && sr.getElementById("aqh-body");
  return body ? body.innerText : "(no bubble body)";
})()`)).value || "";
// 气泡里的“已捕获”块会被答案覆盖，所以以历史记录里的 question 为准。
const captured = (await ev(sw, `new Promise(r => chrome.storage.local.get({ history: [] }, x => r((x.history[0] && x.history[0].question) || "")))`)).value || "";

const ok = String(sent.value) === "sent" && String(captured).includes(NEEDLE);
console.log("SW 触发抓题:", sent.value);
console.log("历史里记录的捕获原文:", JSON.stringify(String(captured).slice(0, 120)));
console.log("气泡最终文本:", JSON.stringify(bodyText.slice(0, 80)));
console.log(ok ? "PASS  iframe 内的选区被成功取到并送进气泡" : "FAIL  iframe 选区没传到顶层");

await ev(sw, `new Promise(r => chrome.tabs.remove(${tabId}, r))`);
finish(ok ? 0 : 1);
