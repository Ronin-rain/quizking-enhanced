// verify-incognito.mjs — QuizKing 无痕/受限环境改动的冒烟测试。
// 用法: node verify-incognito.mjs [cdpBase] [pageUrl] [mockEndpointBase]
// 校验：SW 起来了 / manifest 正确 / 内容脚本注入 / content→background 通道
//      / 无痕分支（普通窗口开设置）/ 抓题全链路与历史写入。
const CDP = process.argv[2] || "http://127.0.0.1:9334";
const PAGE = process.argv[3] || "http://127.0.0.1:8123/";
const MOCK = process.argv[4] || "http://127.0.0.1:8135/v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPEN = [];

function rpc(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const st = { id: 0, pending: new Map(), events: [], ws };
    OPEN.push(st);
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && st.pending.has(m.id)) {
        const done = st.pending.get(m.id);
        st.pending.delete(m.id);
        done(m);
      } else if (m.method) {
        st.events.push(m);
      }
    });
    st.send = (method, params = {}) =>
      new Promise((r) => {
        const id = ++st.id;
        st.pending.set(id, r);
        ws.send(JSON.stringify({ id, method, params }));
      });
    ws.addEventListener("open", () => resolve(st));
    ws.addEventListener("error", () => reject(new Error("ws failed: " + wsUrl)));
  });
}

function finish(code) {
  process.exitCode = code;
  for (const st of OPEN) { try { st.ws.close(); } catch (e) { void e; } }
  setTimeout(() => process.exit(code), 500).unref();
}

async function evaluate(st, expression, contextId) {
  const msg = await st.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    contextId,
  });
  const out = msg.result || {};
  if (out.exceptionDetails) {
    return { error: out.exceptionDetails.exception?.description || out.exceptionDetails.text };
  }
  return { value: out.result ? out.result.value : undefined };
}

function json(e) {
  if (!e || e.value === undefined || e.value === null) return null;
  try { return JSON.parse(e.value); } catch { return null; }
}

const report = [];
function say(ok, label, detail) {
  report.push({ ok, label });
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail === undefined ? "" : "  -> " + JSON.stringify(detail)));
}

const targets = await (await fetch(CDP + "/json/list")).json();
const sw = targets.find((t) => t.type === "service_worker" && t.url.includes("background.js"));
const page = targets.find((t) => t.type === "page" && t.url.startsWith(PAGE));
say(!!sw, "扩展 service worker 已启动", sw ? sw.url : "未找到 background.js target");
say(!!page, "测试页 target 存在", page ? page.url : "未找到 " + PAGE);

let swSt = null;
if (sw) {
  swSt = await rpc(sw.webSocketDebuggerUrl);
  const mf = json(await evaluate(swSt, "JSON.stringify(chrome.runtime.getManifest())"));
  say(mf?.incognito === "spanning", "manifest.incognito = spanning", mf?.incognito);
  say(mf?.version === "0.4.1", "manifest.version = 0.4.1", mf?.version);
  const access = await evaluate(swSt, "new Promise(r=>chrome.extension.isAllowedIncognitoAccess(r))");
  say(access.value !== undefined, "isAllowedIncognitoAccess() 可读", access.value ?? access.error);
}

let ctxId = null;
if (page) {
  const s = await rpc(page.webSocketDebuggerUrl);
  await s.send("Runtime.enable");
  await sleep(1500);
  const contexts = s.events
    .filter((e) => e.method === "Runtime.executionContextCreated")
    .map((e) => e.params.context);
  for (const ctx of contexts) {
    const probe = await evaluate(s, "typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id", ctx.id);
    if (probe.value === true) { ctxId = ctx.id; break; }
  }
  say(ctxId !== null, "内容脚本已注入页面（隔离世界可访问 chrome.runtime）", contexts.length + " 个执行上下文");

  if (ctxId !== null) {
    const cfg = json(await evaluate(s,
      "new Promise(r=>chrome.runtime.sendMessage({type:'aqh/get-config'},x=>r(JSON.stringify(x))))", ctxId));
    say(!!cfg?.ok, "content→background aqh/get-config 通道可用", cfg && { ok: cfg.ok, incognito: cfg.incognito });
    say(typeof cfg?.incognito === "boolean", "回执带 incognito 标记", cfg?.incognito);
    say(!!cfg?.cfg && cfg.cfg.apiKey === undefined, "cfg 已剥离 apiKey（内容脚本拿不到 key）");

    const tinfo = json(await evaluate(s,
      "new Promise(r=>chrome.runtime.sendMessage({type:'aqh/test'},x=>r(JSON.stringify(x))))", ctxId));
    say(!!tinfo?.ok, "aqh/test 路由可用（popup 探测用）", tinfo && { version: tinfo.version });
    say(typeof tinfo?.incognitoAccess === "boolean", "aqh/test 回报无痕权限状态", tinfo?.incognitoAccess);

    const normal = json(await evaluate(s,
      "new Promise(r=>chrome.runtime.sendMessage({type:'aqh/open-options'},x=>r(JSON.stringify(x))))", ctxId));
    say(normal?.ok === true && normal.where === "options-page", "普通窗口：设置页走常规路径", normal);

    // 无痕窗口里走的就是这条分支：spanning 模式不能在无痕标签里加载扩展页面。
    const incogBranch = json(await evaluate(s,
      "new Promise(r=>chrome.runtime.sendMessage({type:'aqh/open-options',payload:{incognito:true}},x=>r(JSON.stringify(x))))", ctxId));
    say(incogBranch?.ok === true && incogBranch.where === "normal-window",
      "无痕分支：自动改用普通窗口打开设置页", incogBranch);

    // 气泡渲染 + 普通窗口不应出现「无痕」角标。
    // 注意：内容脚本收不到自己发的消息，所以必须由 background 用 tabs.sendMessage 转发
    //（真实场景里快捷键/右键菜单/popup 也正是这条路径）。
    const TARGET = PAGE.replace(/\/$/, "") + "/*";
    await evaluate(swSt,
      "new Promise(async r=>{const t=await chrome.tabs.query({url:" + JSON.stringify(TARGET) + "});" +
      "await chrome.tabs.sendMessage(t[0].id,{type:'aqh/capture',payload:{kind:'selection'}});r(1)})");
    await sleep(400);
    const dom = json(await evaluate(s, `(() => {
      const h = document.getElementById("aqh-root");
      const sr = h && h.shadowRoot;
      const g = (id) => (sr ? sr.getElementById(id) : document.getElementById(id));
      const acts = sr ? sr.querySelectorAll("#aqh-actions button").length : document.querySelectorAll("#aqh-actions button").length;
      let topLayer = false;
      try { topLayer = !!(h && h.matches(":popover-open")); } catch (e) {}
      return JSON.stringify({
        host: !!h, shadow: !!sr, bubble: !!g("aqh-bubble"), badge: !!g("aqh-incog"), acts, topLayer,
        styleAttr: !!(h && h.hasAttribute("style")),
        hostDisplay: h ? getComputedStyle(h).display : "",
      });
    })()`, ctxId));
    say(dom?.bubble === true && dom.acts === 3, "气泡可渲染且头部按钮齐全", dom);
    say(dom?.badge === false, "普通窗口不显示「无痕」角标", dom?.badge);
    say(dom?.shadow === true, "UI 位于 Shadow DOM 内（页面 CSS 够不到）", dom?.shadow);
    say(dom?.hostDisplay === "block" && dom?.styleAttr === false,
      "宿主样式来自 shadow :host!important，不带内联 style（痕迹更少）", { display: dom?.hostDisplay, styleAttr: dom?.styleAttr });
    say(dom?.topLayer === true, "宿主已进入顶层（无 z-index 能盖住）", dom?.topLayer);

    // 全链路：本地 mock LLM → 抓题 → 增量推送 → 历史落盘。
    if (swSt) {
      const provider = {
        providers: [{ id: "mock", label: "Mock", endpoint: MOCK.replace(/\/$/, ""), apiKey: "test-key", model: "mock-1", enabled: true }],
        saveHistory: true,
        saveHistoryIncognito: false,
        promptMode: "reason",
      };
      await evaluate(swSt, "new Promise(r=>chrome.storage.sync.set(" + JSON.stringify(provider) + ",r))");
      await evaluate(swSt, "new Promise(r=>chrome.storage.local.set({history:[]},r))");

      await evaluate(s, "window.__aqhPushed=[];chrome.runtime.onMessage.addListener(m=>window.__aqhPushed.push(m.type));", ctxId);
      const asked = json(await evaluate(s,
        "new Promise(r=>chrome.runtime.sendMessage({type:'aqh/ask',payload:{mode:'text',text:'1+1=?'}},x=>r(JSON.stringify(x))))", ctxId));
      say(!!asked?.result?.reqId, "aqh/ask 立即回执服务商名单", asked?.result && asked.result.pending);
      say(asked?.result?.incognito === false, "回执带 incognito=false（普通窗口）", asked?.result?.incognito);

      await sleep(2500);
      const pushed = json(await evaluate(s, "JSON.stringify(window.__aqhPushed||[])", ctxId));
      say(Array.isArray(pushed) && pushed.includes("aqh/ask-item") && pushed.includes("aqh/ask-finish"),
        "结果按增量推送到页面", pushed);

      const hist = json(await evaluate(swSt, "new Promise(r=>chrome.storage.local.get({history:[]},x=>r(JSON.stringify(x.history))))"));
      const first = Array.isArray(hist) ? hist[0] : null;
      say(!!first && first.answer === "42", "普通窗口抓题写入历史（answer=42）", first && { answer: first.answer, incognito: first.incognito });
      say(first?.incognito === false, "历史条目标注 incognito=false", first?.incognito);
    }
  }
}

const failed = report.filter((r) => !r.ok);
console.log("\n" + (failed.length ? "FAILED " + failed.length + " / " : "ALL PASS ") + report.length);
finish(failed.length ? 1 : 0);
