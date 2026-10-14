/**
 * QuizKing · 答题王 — content script injected into every page.
 * @license MIT
 *
 * Three capture modes:
 *   * selection — text selected in the page
 *   * visible   — screenshot of visible tab via background; base64 PNG (with optional user-drawn crop)
 *   * page      — DOM plain text (main visible body)
 * Sends captured payload to background (aqh/ask) and renders the bubble.
 */

(() => {
  if (window.__aqh_injected__) return;
  window.__aqh_injected__ = true;

  const ROOT_ID = "aqh-root";
  let cfg = null;
  // True when this tab lives in an incognito window (reported by background).
  let incognito = false;
  // Per-call: result.promptMode is read inside showAnswer.
  let promptMode = "answer";
  // In-flight multi-provider request: { reqId, roster, items, promptMode, label }.
  let activeReq = null;

  // --- Hardened container ---------------------------------------------------
  // Pages break injected UIs in a handful of ways; each one has a counter here:
  //   * `#aqh-root{display:none!important}` / `* { ... }` resets
  //     → the UI lives in a Shadow DOM (page CSS cannot reach inside) and the
  //       host carries inline !important declarations (beats page !important).
  //   * a full-screen overlay at z-index 2147483647
  //     → the host is promoted to the top layer via the popover API.
  //   * MutationObserver sweeps that delete unknown nodes
  //     → a 1s tick re-attaches the host; its content (open bubble included)
  //       survives, because it never left the detached host's shadow root.
  //   * `window.addEventListener('click', …, true)` swallowing events
  //     → the manifest runs at document_start and all UI clicks are delegated
  //       through one capture listener registered before any page script.
  // What hardening cannot do: hide the extension. Any page script can walk the
  // DOM and see the host element, and no extension API changes that.
  const IS_TOP_FRAME = (() => {
    try { return window.top === window; } catch (e) { return false; }
  })();

  const HOST_STYLE = {
    all: "initial",
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    margin: "0",
    padding: "0",
    border: "0",
    background: "transparent",
    "z-index": "2147483647",
    display: "block",
    visibility: "visible",
    opacity: "1",
    overflow: "visible",
    "max-width": "none",
    "max-height": "none",
    transform: "none",
    filter: "none",
    "clip-path": "none",
    contain: "none",
    "pointer-events": "none",
    "mix-blend-mode": "normal",
  };

  const BUBBLE_CSS = `
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
  color: #1f2330;
}

#aqh-bubble {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 360px;
  max-width: 60vw;
  max-height: 60vh;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 14px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  font-size: 14px;
  line-height: 1.5;
  opacity: var(--aqh-o, 0.95);
  /* Answer text stays selectable even on pages that kill selection globally. */
  user-select: text;
  pointer-events: auto;
  filter: saturate(clamp(0, (var(--aqh-o, 0.95) - 0.4) / 0.4, 1));
}

#aqh-title-glyph,
.aqh-btn-primary,
.aqh-consensus,
.aqh-item-flag {
  opacity: clamp(0.3, (var(--aqh-o, 0.95) - 0.4) / 0.4, 1);
}

#aqh-title {
  opacity: clamp(0, (var(--aqh-o, 0.95) - 0.4) / 0.4, 1);
}

.aqh-btn-primary {
  appearance: none;
  border: 0;
  background: #3563ff;
  color: #fff;
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.aqh-btn-primary:hover { filter: brightness(1.08); }

#aqh-bubble.aqh-hide { display: none; }

#aqh-header {
  cursor: move;
  background: linear-gradient(180deg, #f7f8fc 0%, #eef1f8 100%);
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  user-select: none;
}
#aqh-title-glyph {
  display: inline-block;
  width: 22px; height: 22px; line-height: 22px;
  text-align: center;
  background: #3563ff; color: #fff;
  border-radius: 6px;
  margin-right: 8px;
  font-family: "PingFang SC","Microsoft YaHei",Heiti,sans-serif;
  font-weight: 700; font-size: 14px;
}
#aqh-title-text { font-weight: 600; }
#aqh-title {
  font-weight: 600;
  flex: 1;
  font-size: 13px;
  color: #3b3f51;
}
/* Incognito marker: the same code runs in an incognito window, but the user
   deserves to see which window an answer came from. Fades with the title row. */
#aqh-incog {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #eef1f8;
  border: 1px solid #dfe3ee;
  color: #5b6273;
  font-size: 11px;
  font-weight: 500;
}
#aqh-actions { display: flex; gap: 4px; }
#aqh-actions button {
  appearance: none;
  border: 0;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
  color: #5b6273;
  border-radius: 6px;
}
#aqh-actions button:hover { background: rgba(0, 0, 0, 0.06); }

#aqh-body { padding: 10px 12px; overflow: auto; flex: 1; }

.aqh-answer-label, .aqh-reasoning-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6b7080;
  margin: 4px 0 2px;
}
.aqh-answer-block {
  background: #eaf3ff;
  border: 1px solid #cfe1ff;
  border-radius: 10px;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
.aqh-reasoning-block {
  background: #fafbff;
  border: 1px solid #eef0f6;
  border-radius: 10px;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
.aqh-pre {
  background: #f3f4f8;
  border-radius: 6px;
  padding: 6px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.aqh-err { color: #b3261e; }

/* --- Multi-provider results --------------------------------------------- */
.aqh-consensus {
  font-size: 12px;
  font-weight: 600;
  padding: 5px 10px;
  border-radius: 8px;
  margin-bottom: 8px;
  border: 1px solid transparent;
}
.aqh-consensus.aqh-same { background: #eaf7ee; border-color: #cbe8d5; color: #1a7f42; }
.aqh-consensus.aqh-diff { background: #fff6e8; border-color: #f2ddba; color: #9a6212; }
.aqh-consensus.aqh-wait { background: #f2f3f8; border-color: #e4e6ef; color: #6b7080; }
.aqh-item-pending { border-style: dashed; background: #fbfcfe; }
.aqh-item-pending .aqh-item-ms { font-style: italic; }

.aqh-item {
  border: 1px solid #eef0f6;
  border-radius: 10px;
  padding: 8px 10px;
  background: #fafbff;
  margin-bottom: 8px;
}
.aqh-item:last-child { margin-bottom: 0; }
.aqh-item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 12px;
}
.aqh-item-label { font-weight: 600; color: #3b3f51; }
.aqh-item-model {
  color: #6b7080;
  background: #eef1f8;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 11px;
}
.aqh-item-ms { color: #99a0b3; font-size: 11px; margin-left: auto; }
.aqh-item-flag {
  background: #fff6e8;
  border: 1px solid #f2ddba;
  color: #9a6212;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 11px;
}
.aqh-item.aqh-minority { border-color: #f2ddba; background: #fffdf8; }
.aqh-item.aqh-item-fail { border-color: #f0d5d2; background: #fdf6f5; }
.aqh-item .aqh-answer-block { margin: 0; }
.aqh-item-reason { margin-top: 6px; }
.aqh-item-reason > summary {
  cursor: pointer;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6b7080;
  list-style: none;
}
.aqh-item-reason > summary::-webkit-details-marker { display: none; }
.aqh-item-reason > summary::before { content: "▸ "; }
.aqh-item-reason[open] > summary::before { content: "▾ "; }
.aqh-item-reason .aqh-reasoning-block { margin-top: 4px; }

#aqh-status {
  font-size: 12px;
  color: #6b7080;
  padding: 6px 10px;
  border-top: 1px solid rgba(0, 0, 0, 0.05);
  background: rgba(247, 248, 252, 0.7);
  display: flex;
  align-items: center;
  gap: 6px;
}
.aqh-spinner {
  width: 12px; height: 12px;
  border: 2px solid #b9c0d4;
  border-top-color: #3563ff;
  border-radius: 50%;
  animation: aqh-spin 0.7s linear infinite;
  display: inline-block;
}
@keyframes aqh-spin { to { transform: rotate(360deg); } }

#aqh-fab {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 44px; height: 44px;
  border-radius: 50%;
  background: #3563ff;
  color: #fff;
  border: 0;
  cursor: pointer;
  box-shadow: 0 8px 22px rgba(53, 99, 255, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: "PingFang SC","Microsoft YaHei",Heiti,sans-serif;
  font-weight: 700;
  font-size: 18px;
  pointer-events: auto;
  opacity: 0.85;
}
#aqh-fab:hover { opacity: 1; }
#aqh-fab.aqh-fab-expanded {
  width: auto;
  height: 40px;
  border-radius: 999px;
  padding: 0 6px;
  gap: 6px;
}
.aqh-fab-btn {
  appearance: none;
  border: 0;
  background: rgba(255,255,255,0.18);
  color: #fff;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 999px;
  cursor: pointer;
}
.aqh-fab-btn:hover { background: rgba(255,255,255,0.32); }

.aqh-mask {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.25);
  cursor: crosshair;
  pointer-events: auto;
}
.aqh-mask-hint {
  position: fixed;
  left: 50%;
  top: 12px;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.72);
  color: #fff;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 12px;
}
`;

  let hostEl = null;
  let shadowEl = null;
  let healTimer = null;
  let fabEl = null;
  let fabExpanded = false;
  let fabCollapseTimer = null;

  function getRuntime() { return chrome.runtime; }

  function callBg(type, payload) {
    return new Promise((resolve) => {
      try {
        getRuntime().sendMessage({ type, payload }, (res) => resolve(res));
      } catch (e) {
        resolve({ ok: false, error: e?.message || String(e) });
      }
    });
  }

  function applyHostStyle(el) {
    for (const prop of Object.keys(HOST_STYLE)) {
      // Inline !important outranks any page stylesheet, including page !important.
      el.style.setProperty(prop, HOST_STYLE[prop], prop === "all" ? "" : "important");
    }
  }

  // A transformed/filtered ancestor turns position:fixed into "absolute to that
  // ancestor", which would let the bubble scroll away with the page.
  function createsContainingBlock(el) {
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { return false; }
    if (!cs) return false;
    if (cs.transform && cs.transform !== "none") return true;
    if (cs.filter && cs.filter !== "none") return true;
    if (cs.backdropFilter && cs.backdropFilter !== "none") return true;
    if (cs.perspective && cs.perspective !== "none") return true;
    if (cs.contain && /paint|layout|strict|content/.test(cs.contain)) return true;
    if (cs.willChange && /transform|filter|perspective/.test(cs.willChange)) return true;
    return false;
  }

  // Where to hang the host. <body> is where injected UI conventionally lives and
  // it dodges the common "delete stray children of <html>" cleanup script — but
  // only when nothing in body's chain would break fixed positioning.
  function pickParent() {
    const body = document.body;
    if (!body) return document.documentElement; // document_start: body not parsed yet
    for (let el = body; el && el !== document.documentElement; el = el.parentElement) {
      if (createsContainingBlock(el)) return document.documentElement;
    }
    return body;
  }

  // The popover API puts the host in the top layer, above every z-index on the
  // page. Unsupported browsers simply keep the normal fixed positioning.
  function enterTopLayer() {
    if (!hostEl || typeof hostEl.showPopover !== "function") return;
    try {
      if (!hostEl.matches(":popover-open")) hostEl.showPopover();
    } catch (e) { void e; }
  }

  function ensureRoot() {
    if (!hostEl) {
      const existing = document.getElementById(ROOT_ID);
      if (existing && existing.shadowRoot) {
        hostEl = existing;
        shadowEl = existing.shadowRoot;
      } else {
        if (existing) existing.remove();
        hostEl = document.createElement("div");
        hostEl.id = ROOT_ID;
        hostEl.setAttribute("popover", "manual");
        applyHostStyle(hostEl);
        shadowEl = hostEl.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = BUBBLE_CSS;
        shadowEl.appendChild(style);
      }
    }
    // After a page DOM sweep the host is detached on purpose: put it back, and
    // the bubble that lives inside its shadow root comes back with it.
    const parent = pickParent();
    if (hostEl.parentNode !== parent) parent.appendChild(hostEl);
    enterTopLayer();
    return hostEl;
  }

  // Everything UI-side is looked up inside the shadow root.
  function q(id) {
    if (shadowEl) {
      const el = shadowEl.getElementById(id);
      if (el) return el;
    }
    return document.getElementById(id);
  }

  function uiIsLive() {
    return !!(q("aqh-bubble") || q("aqh-fab"));
  }

  function startHealing() {
    if (!IS_TOP_FRAME || healTimer) return;
    healTimer = setInterval(() => {
      if (!uiIsLive()) { stopHealing(); return; }
      ensureRoot(); // re-attach after a sweep, re-enter the top layer
    }, 1000);
  }

  function stopHealing() {
    if (healTimer) { clearInterval(healTimer); healTimer = null; }
  }

  function stopHealingIfIdle() {
    if (!uiIsLive()) stopHealing();
  }

  // One capture-phase handler for every button in the UI, registered while the
  // document is still empty so a page listener on window/document cannot eat
  // the click before it reaches us.
  function onUiClick(e) {
    if (!hostEl) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (!path.includes(hostEl)) return;
    let actEl = null;
    for (const node of path) {
      if (node === hostEl) break;
      if (node instanceof Element && node.hasAttribute("data-act")) { actEl = node; break; }
    }
    if (!actEl) return;
    e.preventDefault();
    e.stopPropagation();
    runAction(actEl.getAttribute("data-act"), actEl.getAttribute("data-k"));
  }

  function runAction(act, k) {
    if (act === "close") return closeBubble();
    if (act === "min") {
      const bubble = q("aqh-bubble");
      if (bubble) bubble.classList.toggle("aqh-hide");
      return;
    }
    if (act === "settings" || act === "openopts") return openSettings();
    if (act === "fab-toggle") {
      if (!fabExpanded) { renderFab(true); return; }
      handleTrigger("selection");
      renderFab(false);
      return;
    }
    if (act === "fab-run") {
      handleTrigger(k);
      renderFab(false);
    }
  }

  // Capture phase on window, installed before page scripts (see manifest
  // run_at: document_start).
  window.addEventListener("click", onUiClick, true);

  function getCssOpacity() {
    const v = Number((cfg && cfg.bubbleOpacity) ?? 0.95);
    if (!Number.isFinite(v)) return 0.95;
    return Math.min(1, Math.max(0.4, v));
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function log(...a) { try { console.log("[aqh]", ...a); } catch (e) { void e; } }

  function renderBubble(html, opts) {
    opts = opts || {};
    // Only the top frame owns UI: with all_frames enabled, a subframe that drew
    // its own bubble would be clipped by the iframe box.
    if (!IS_TOP_FRAME) return;
    ensureRoot();
    const stale = q("aqh-bubble");
    if (stale) stale.remove();
    const wrap = document.createElement("div");
    wrap.id = "aqh-bubble";
    wrap.style.setProperty("--aqh-o", String(getCssOpacity()));
    if (opts.hidden) wrap.classList.add("aqh-hide");
    wrap.innerHTML =
      '<div id="aqh-header">' +
        '<div id="aqh-title"><span id="aqh-title-glyph">王</span><span id="aqh-title-text">QuizKing · 答题王</span>' +
          (incognito ? '<span id="aqh-incog" title="当前标签页处于无痕窗口">无痕</span>' : "") +
        '</div>' +
        '<div id="aqh-actions">' +
          '<button data-act="settings" title="设置">⚙</button>' +
          '<button data-act="min" title="隐藏">—</button>' +
          '<button data-act="close" title="关闭">✕</button>' +
        '</div>' +
      '</div>' +
      '<div id="aqh-body">' + html + '</div>' +
      '<div id="aqh-status">' + (opts.status || "") + '</div>';
    shadowEl.appendChild(wrap);

    enableDrag(wrap, wrap.querySelector("#aqh-header"));
    startHealing();
  }

  // Ask background to open the options page: from an incognito window Chrome
  // cannot show the extension's own page in a tab, so background opens it in a
  // regular window instead of silently doing nothing.
  function openSettings() {
    callBg("aqh/open-options").then((res) => {
      if (res && res.ok === false) {
        log("openOptions failed", res.error);
      }
    });
  }

  function setStatus(text, loading) {
    const status = q("aqh-status");
    if (!status) return;
    status.innerHTML = loading
      ? '<span class="aqh-spinner"></span><span>' + escapeHtml(text) + '</span>'
      : escapeHtml(text || "");
  }

  function closeBubble() {
    const bubble = q("aqh-bubble");
    if (bubble) bubble.remove();
    activeReq = null;
    stopHealingIfIdle();
  }

  function enableDrag(box, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      const r = box.getBoundingClientRect();
      ox = r.left; oy = r.top;
      sx = e.clientX; sy = e.clientY;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const nx = Math.max(0, Math.min(window.innerWidth - 80, ox + (e.clientX - sx)));
      const ny = Math.max(0, Math.min(window.innerHeight - 40, oy + (e.clientY - sy)));
      box.style.left = nx + "px";
      box.style.top = ny + "px";
      box.style.right = "auto";
      box.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => { dragging = false; });
  }

  function getSelectionText() {
    const sel = window.getSelection && window.getSelection();
    if (!sel) return "";
    return sel.toString().trim();
  }

  function getPageText(limit) {
    limit = limit || 6000;
    const root = document.body || document.documentElement;
    const text = (root.innerText || "").trim();
    return text.length > limit ? text.slice(0, limit) : text;
  }

  async function captureVisibleScreenshot() {
    const res = await callBg("aqh/capture-visible-tab");
    if (!res || !res.ok) throw new Error((res && res.error) || "截图失败");
    return res.dataUrl;
  }

  async function chooseCropAndCapture() {
    const full = await captureVisibleScreenshot();
    const rect = await pickRectOnPage();
    if (!rect) {
      log("crop: user cancelled, using full shot");
      return full;
    }
    return cropDataUrl(full, rect);
  }

  function pickRectOnPage() {
    return new Promise((resolve) => {
      ensureRoot();
      const host = shadowEl; // the crop overlay belongs to our shadow root too

      const mask = document.createElement("div");
      mask.id = "aqh-mask";
      mask.style.cssText =
        "position:fixed;left:0;top:0;right:0;bottom:0;width:100%;height:100%;" +
        "z-index:2147483647;background:rgba(0,0,0,0.25);cursor:crosshair;" +
        "touch-action:none;user-select:none;";
      host.appendChild(mask);

      const hint = document.createElement("div");
      hint.id = "aqh-mask-hint";
      hint.textContent = "拖动鼠标框选区域，ESC 取消";
      hint.style.cssText =
        "position:fixed;left:50%;top:12px;transform:translateX(-50%);padding:6px 12px;" +
        "border-radius:999px;background:rgba(0,0,0,0.72);color:#fff;font-size:12px;" +
        "z-index:2147483647;pointer-events:none;user-select:none;";
      host.appendChild(hint);

      const sel = document.createElement("div");
      sel.id = "aqh-sel";
      sel.style.cssText =
        "position:fixed;border:2px dashed #3563ff;background:rgba(53,99,255,0.18);" +
        "pointer-events:none;display:none;z-index:2147483647;";
      host.appendChild(sel);

      const fab = q("aqh-fab");
      if (fab) fab.style.pointerEvents = "none";
      const bubble = q("aqh-bubble");
      const prevBubblePE = bubble ? bubble.style.pointerEvents : "";
      if (bubble) bubble.style.pointerEvents = "none";

      let startX = 0, startY = 0, drawing = false, moveCount = 0, finished = false;

      function done(rect, why) {
        if (finished) return;
        finished = true;
        log("done:", why, rect);
        mask.removeEventListener("mousedown", onDown);
        mask.removeEventListener("mouseup", onUp);
        mask.removeEventListener("contextmenu", onCtx);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("keydown", onKey);
        sel.remove(); hint.remove(); mask.remove();
        if (fab) fab.style.pointerEvents = "";
        if (bubble) bubble.style.pointerEvents = prevBubblePE;
        resolve(rect);
      }

      function onDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        drawing = true;
        startX = e.clientX;
        startY = e.clientY;
        sel.style.left = startX + "px";
        sel.style.top = startY + "px";
        sel.style.width = "0px";
        sel.style.height = "0px";
        sel.style.display = "block";
        log("down:", startX, startY);
      }

      function onMove(e) {
        if (!drawing) return;
        moveCount++;
        const left = Math.min(startX, e.clientX);
        const top = Math.min(startY, e.clientY);
        const width = Math.abs(e.clientX - startX);
        const height = Math.abs(e.clientY - startY);
        sel.style.left = left + "px";
        sel.style.top = top + "px";
        sel.style.width = width + "px";
        sel.style.height = height + "px";
      }

      function onUp(e) {
        if (!drawing) return;
        drawing = false;
        e.preventDefault();
        e.stopPropagation();
        const left = Math.min(startX, e.clientX);
        const top = Math.min(startY, e.clientY);
        const width = Math.abs(e.clientX - startX);
        const height = Math.abs(e.clientY - startY);
        log("up:", { left, top, width, height, moveCount });
        if (width < 3 || height < 3) return done(null, "too small");
        done({ left, top, width, height, dpr: window.devicePixelRatio || 1 }, "ok");
      }

      function onKey(e) {
        if (e.key === "Escape") { drawing = false; done(null, "esc"); }
      }

      function onCtx(e) { e.preventDefault(); }

      mask.addEventListener("mousedown", onDown);
      mask.addEventListener("mouseup", onUp);
      mask.addEventListener("contextmenu", onCtx);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("keydown", onKey);

      log("pick: mask shown");
    });
  }

  function cropDataUrl(dataUrl, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const dpr = rect.dpr || 1;
        const sx = rect.left * dpr;
        const sy = rect.top * dpr;
        const sw = rect.width * dpr;
        const sh = rect.height * dpr;
        const targetW = Math.min(1600, sw);
        const targetH = sh * (targetW / sw);
        const c = document.createElement("canvas");
        c.width = targetW; c.height = targetH;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function askAndShow(payload, label) {
    if (!cfg || !cfg.hasKey) {
      renderBubble(
        '<div class="aqh-err">未配置 API Key。</div>' +
        '<div style="margin-top:8px">' +
          '<button id="aqh-openopts" class="aqh-btn-primary" data-act="openopts">打开设置</button>' +
        '</div>',
        { status: "需要先在选项页填写 API Key" }
      );
      return;
    }
    const n = ((cfg && cfg.providers) || []).filter((p) => p.enabled && p.hasKey).length;
    renderBubble(
      '<div class="aqh-reasoning-block"><div class="aqh-reasoning-label">已捕获</div>' +
      escapeHtml(label || "(image)") + '</div>',
      { status: n > 1 ? ("正在向 " + n + " 个模型并行发送请求…") : "正在向 LLM 发送请求…", loading: true }
    );
    const res = await callBg("aqh/ask", payload);
    if (!res || !res.ok) {
      setStatus("失败：" + ((res && res.error) || "未知错误"));
      appendError((res && res.error) || "未知错误");
      return;
    }
    beginIncremental(res.result, label);
  }

  /**
   * Results stream in one provider at a time. The roster arrives with the
   * immediate reply so every card can be drawn up front; each pushed item then
   * fills its own card. A single provider keeps the original plain layout.
   */
  function beginIncremental(result, label) {
    const roster = Array.isArray(result.pending) ? result.pending : [];
    if (!result.reqId) { showAnswer(result); return; }
    activeReq = {
      reqId: result.reqId,
      roster,
      items: {},
      promptMode: result.promptMode,
      label: label || "",
    };
    if (roster.length <= 1) return; // nothing to interleave: wait for the single result
    renderProgress();
  }

  function currentItems() {
    if (!activeReq) return [];
    return activeReq.roster.map((p) => activeReq.items[p.id] || {
      id: p.id, label: p.label, model: p.model, ok: null,
    });
  }

  function renderProgress() {
    const st = activeReq;
    if (!st) return;
    ensureRoot(); // insurance: a page sweep may have detached the host
    const body = q("aqh-body");
    if (!body) return;
    const items = currentItems();
    body.innerHTML = ""; // re-render the whole set; each arrival replaces the previous frame
    renderMulti(body, items, st.promptMode, st.label);
    const arrived = items.filter((it) => it.ok !== null).length;
    setStatus(arrived < items.length
      ? ("已返回 " + arrived + "/" + items.length + "，等待其余模型…")
      : "完成。");
  }

  function appendError(msg) {
    const body = q("aqh-body");
    if (!body) return;
    const div = document.createElement("div");
    div.className = "aqh-err";
    div.style.marginTop = "8px";
    div.textContent = msg;
    body.appendChild(div);
  }

  // Models often wrap the payload in prose or code fences; unwrap when we can.
  function unwrapResult(answer, reasoning) {
    let a = String(answer || "").trim();
    let re = String(reasoning || "").trim();
    if (a && (a.startsWith("{") || a.startsWith("`"))) {
      try {
        const obj = JSON.parse(a.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim());
        if (obj && typeof obj === "object") {
          if (obj.answer) a = String(obj.answer).trim();
          if (!re && obj.reasoning) re = String(obj.reasoning).trim();
        }
      } catch {}
    }
    if (re && re.startsWith("{")) {
      try {
        const obj = JSON.parse(re);
        if (obj && obj.reasoning) re = String(obj.reasoning).trim();
      } catch {}
    }
    return { answer: a, reasoning: re };
  }

  // Heuristic equality: ignore case and whitespace.
  function normAnswer(s) {
    return String(s || "").trim().toUpperCase().replace(/\s+/g, "");
  }

  function showAnswer(r) {
    ensureRoot(); // insurance: a page sweep may have detached the host
    const body = q("aqh-body");
    if (!body) return;
    const items = Array.isArray(r.items) ? r.items : null;
    log("showAnswer items=", items ? items.length : "(legacy)", "mode=", r.promptMode);
    body.innerHTML = "";

    if (items && items.length) {
      if (items.length === 1) {
        const only = items[0];
        if (!only.ok) {
          body.appendChild(itemCard(only));
          setStatus(only.ok === null ? "等待中…" : ("失败：" + (only.error || "未知错误")));
          return;
        }
        // Single provider: keep the original plain layout.
        renderSingle(body, only.answer, only.reasoning, only.raw, r.promptMode);
        return;
      }
      renderMulti(body, items, r.promptMode, r.label);
      return;
    }
    // Legacy response shape (single answer, no items array).
    renderSingle(body, r.answer, r.reasoning, r.raw, r.promptMode);
  }

  function renderSingle(body, answerRaw, reasoningRaw, raw, modeIn) {
    const { answer, reasoning } = unwrapResult(answerRaw, reasoningRaw);
    // Use mode from the per-call response; fall back to module-level.
    const mode = modeIn || promptMode || "answer";
    // In answer-only mode, drop any reasoning the model still emitted.
    const showReasoning = mode !== "answer" && !!reasoning && reasoning !== answer;

    if (answer) {
      const a = document.createElement("div");
      a.className = "aqh-answer";
      a.innerHTML =
        '<div class="aqh-answer-label">答案</div>' +
        '<div class="aqh-answer-block"></div>';
      a.querySelector(".aqh-answer-block").textContent = answer;
      body.appendChild(a);
    }
    if (showReasoning) {
      const re = document.createElement("div");
      re.className = "aqh-reasoning";
      re.style.marginTop = "8px";
      re.innerHTML =
        '<div class="aqh-reasoning-label">解析</div>' +
        '<div class="aqh-reasoning-block"></div>';
      re.querySelector(".aqh-reasoning-block").textContent = reasoning;
      body.appendChild(re);
    }
    if (!answer && !reasoning && raw) {
      const rw = document.createElement("div");
      rw.style.marginTop = "8px";
      rw.innerHTML = '<div class="aqh-reasoning-label">原始输出</div><div class="aqh-pre"></div>';
      rw.querySelector(".aqh-pre").textContent = raw;
      body.appendChild(rw);
    }
    setStatus(answer ? "完成。" : "完成（模型未返回结构化输出，已展示原始文本）。");
  }

  function renderMulti(body, items, modeIn, label) {
    const mode = modeIn || promptMode || "answer";
    // ok === true 成功 / false 失败 / null 尚未返回
    const okItems = items.filter((it) => it.ok === true);
    const failedCount = items.filter((it) => it.ok === false).length;
    const pendingCount = items.filter((it) => it.ok === null).length;
    const norms = okItems.map((it) => normAnswer(unwrapResult(it.answer, it.reasoning).answer));

    // Majority vote is only used to flag outliers, never to hide results.
    const counts = {};
    norms.forEach((n) => { counts[n] = (counts[n] || 0) + 1; });
    let majority = null, best = 0;
    Object.keys(counts).forEach((k) => { if (counts[k] > best) { best = counts[k]; majority = k; } });
    const hasMajority = best > 1;
    const allSame = okItems.length > 1 && best === okItems.length;

    if (label) {
      const cap = document.createElement("div");
      cap.className = "aqh-reasoning-block";
      cap.style.marginBottom = "8px";
      cap.innerHTML = '<div class="aqh-reasoning-label">已捕获</div>';
      const t = document.createElement("div");
      t.textContent = label;
      cap.appendChild(t);
      body.appendChild(cap);
    }

    const badge = document.createElement("div");
    badge.className = "aqh-consensus " + (pendingCount ? "aqh-wait" : (allSame ? "aqh-same" : "aqh-diff"));
    let text;
    if (okItems.length > 1) {
      text = allSame
        ? ("✓ " + okItems.length + " 个模型答案一致")
        : (hasMajority ? ("⚠ 答案不一致（" + best + "/" + okItems.length + " 一致）") : "⚠ 答案各不相同");
    } else if (okItems.length === 1) {
      text = "仅 1 个模型返回结果";
    } else if (pendingCount) {
      text = "等待模型返回…";
    } else {
      text = "全部模型调用失败";
    }
    const notes = [];
    if (failedCount) notes.push(failedCount + " 个失败");
    if (pendingCount) notes.push(pendingCount + " 个等待中");
    if (notes.length) text += " · " + notes.join(" · ");
    badge.textContent = text;
    body.appendChild(badge);

    items.forEach((it) => {
      const minority = it.ok === true && hasMajority &&
        normAnswer(unwrapResult(it.answer, it.reasoning).answer) !== majority;
      body.appendChild(itemCard(it, mode, minority));
    });

    if (pendingCount) return; // status line is owned by renderProgress while streaming
    setStatus(okItems.length ? "完成。" : "失败：所有服务商均未返回结果。");
  }

  function itemCard(it, modeIn, minority) {
    const mode = modeIn || promptMode || "answer";
    const pending = it.ok === null;
    const wrap = document.createElement("div");
    wrap.className = "aqh-item" +
      (it.ok === false ? " aqh-item-fail" : "") +
      (pending ? " aqh-item-pending" : "") +
      (minority ? " aqh-minority" : "");

    const head = document.createElement("div");
    head.className = "aqh-item-head";
    const name = document.createElement("span");
    name.className = "aqh-item-label";
    name.textContent = it.label || it.model || "服务商";
    head.appendChild(name);
    if (it.model) {
      const m = document.createElement("span");
      m.className = "aqh-item-model";
      m.textContent = it.model;
      head.appendChild(m);
    }
    if (pending) {
      const w = document.createElement("span");
      w.className = "aqh-item-ms";
      w.textContent = "等待中…";
      head.appendChild(w);
    } else if (typeof it.ms === "number") {
      const t = document.createElement("span");
      t.className = "aqh-item-ms";
      t.textContent = (it.ms / 1000).toFixed(1) + "s";
      head.appendChild(t);
    }
    if (minority) {
      const flag = document.createElement("span");
      flag.className = "aqh-item-flag";
      flag.textContent = "少数";
      head.appendChild(flag);
    }
    wrap.appendChild(head);

    if (pending) return wrap;

    if (it.ok === false) {
      const err = document.createElement("div");
      err.className = "aqh-err";
      err.textContent = it.error || "未知错误";
      wrap.appendChild(err);
      return wrap;
    }

    const { answer, reasoning } = unwrapResult(it.answer, it.reasoning);
    if (answer) {
      const block = document.createElement("div");
      block.className = "aqh-answer-block";
      block.textContent = answer;
      wrap.appendChild(block);
    }
    if (mode !== "answer" && reasoning && reasoning !== answer) {
      const d = document.createElement("details");
      d.className = "aqh-item-reason";
      const s = document.createElement("summary");
      s.textContent = "解析";
      const pre = document.createElement("div");
      pre.className = "aqh-reasoning-block";
      pre.textContent = reasoning;
      d.appendChild(s);
      d.appendChild(pre);
      wrap.appendChild(d);
    }
    if (!answer && !reasoning && it.raw) {
      const pre = document.createElement("div");
      pre.className = "aqh-pre";
      pre.textContent = it.raw;
      wrap.appendChild(pre);
    }
    return wrap;
  }

  function toggleFab() {
    const existing = q("aqh-fab");
    if (existing) {
      existing.remove();
      fabEl = null;
      stopHealingIfIdle();
      return false;
    }
    ensureFab();
    return true;
  }

  function renderFab(expanded) {
    if (!fabEl) return;
    fabExpanded = !!expanded;
    if (expanded) {
      fabEl.classList.add("aqh-fab-expanded");
      fabEl.innerHTML =
        '<span class="aqh-fab-btn" data-act="fab-run" data-k="selection">选区</span>' +
        '<span class="aqh-fab-btn" data-act="fab-run" data-k="visible">截图</span>' +
        '<span class="aqh-fab-btn" data-act="fab-run" data-k="page">整页</span>' +
        '<span class="aqh-fab-btn" data-act="fab-run" data-k="toggle">气泡</span>';
    } else {
      fabEl.classList.remove("aqh-fab-expanded");
      fabEl.textContent = "王";
    }
  }

  function ensureFab() {
    if (!IS_TOP_FRAME) return null;
    ensureRoot();
    if (fabEl && fabEl.isConnected) return fabEl;
    fabEl = q("aqh-fab");
    if (fabEl) return fabEl;
    fabEl = document.createElement("button");
    fabEl.id = "aqh-fab";
    fabEl.title = "QuizKing · 答题王";
    fabEl.setAttribute("data-act", "fab-toggle");
    shadowEl.appendChild(fabEl);
    fabEl.addEventListener("mouseenter", () => { clearTimeout(fabCollapseTimer); renderFab(true); });
    fabEl.addEventListener("mouseleave", () => {
      clearTimeout(fabCollapseTimer);
      fabCollapseTimer = setTimeout(() => renderFab(false), 350);
    });
    renderFab(false);
    startHealing();
    return fabEl;
  }

  async function handleTrigger(kind) {
    // Insurance: put the host back before drawing instead of waiting for the
    // next heal tick.
    ensureRoot();
    if (kind === "toggle") {
      // Toggle the 王字 FAB (default hidden, click to summon).
      toggleFab();
      return;
    }
    try {
      if (kind === "selection") {
        let text = getSelectionText();
        let fromFrame = false;
        if (!text) {
          // The question may live inside an iframe the top frame cannot read:
          // background asks every frame and hands back the longest selection.
          const r = await callBg("aqh/collect-frame-selection");
          if (r && r.ok && r.text) { text = r.text; fromFrame = true; }
        }
        if (!text) {
          renderBubble('<div class="aqh-err">未选中文本。</div>', { status: "请先在页面选中文字" });
          return;
        }
        await askAndShow({ mode: "text", text }, (fromFrame ? "[selection in frame]\n" : "[selection]\n") + text);
      } else if (kind === "visible") {
        const dataUrl = await chooseCropAndCapture();
        await askAndShow(
          { mode: "image", imageDataUrl: dataUrl, text: "请分析截图中题目并回答。" },
          "[visible screenshot]"
        );
      } else if (kind === "page") {
        const text = getPageText();
        if (!text) {
          renderBubble('<div class="aqh-err">页面文本为空。</div>', { status: "请尝试其他通道" });
          return;
        }
        await askAndShow({ mode: "text", text }, "[page text]\n" + text);
      }
    } catch (e) {
      renderBubble('<div class="aqh-err">捕获失败：' + escapeHtml(e && e.message || String(e)) + '</div>');
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    // A subframe only answers "do you have a selection?"; every UI trigger and
    // every render stays in the top frame.
    if (msg.type === "aqh/want-selection") {
      const text = getSelectionText();
      if (text) {
        try {
          chrome.runtime.sendMessage(
            { type: "aqh/selection-part", payload: { reqId: msg.payload && msg.payload.reqId, text } },
            () => { void chrome.runtime.lastError; }
          );
        } catch (e) { void e; }
      }
      return sendResponse({ ok: true, has: !!text });
    }
    if (msg.type === "aqh/capture" && !IS_TOP_FRAME) return sendResponse({ ok: false, reason: "not-top-frame" });
    if (msg.type === "aqh/close" && !IS_TOP_FRAME) return sendResponse({ ok: false, reason: "not-top-frame" });
    if (msg.type === "aqh/show-fab" && !IS_TOP_FRAME) return sendResponse({ ok: false, reason: "not-top-frame" });
    if (msg.type === "aqh/capture") {
      handleTrigger(msg.payload && msg.payload.kind || "selection");
      return sendResponse({ ok: true });
    }
    if (msg.type === "aqh/close") {
      closeBubble();
      return sendResponse({ ok: true });
    }
    if (msg.type === "aqh/show-fab") {
      const shown = toggleFab();
      return sendResponse({ ok: true, shown });
    }
    if (msg.type === "aqh/ping") {
      sendResponse({ ok: true });
    }
    // Incremental results: each provider lands on its own, then a final settle.
    if (msg.type === "aqh/ask-item") {
      const p = msg.payload || {};
      if (activeReq && p.reqId === activeReq.reqId && p.item) {
        activeReq.items[p.item.id] = p.item;
        if (activeReq.roster.length > 1) renderProgress();
      }
      return sendResponse({ ok: true });
    }
    if (msg.type === "aqh/ask-finish") {
      const p = msg.payload || {};
      if (activeReq && p.reqId === activeReq.reqId) {
        const st = activeReq;
        activeReq = null;
        const items = Array.isArray(p.items) ? p.items : [];
        if (st.roster.length <= 1) {
          // Single provider: plain layout (or a lone failure card).
          showAnswer({ items, promptMode: p.promptMode || st.promptMode });
        } else {
          const body = q("aqh-body");
          if (body) {
            body.innerHTML = "";
            renderMulti(body, items, p.promptMode || st.promptMode, st.label);
          }
        }
      }
      return sendResponse({ ok: true });
    }
  });

  // Live-apply opacity changes (e.g. saved from the options page) to any open bubble.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.bubbleOpacity) return;
    const v = Number(changes.bubbleOpacity.newValue);
    if (!Number.isFinite(v)) return;
    if (!cfg) cfg = {};
    cfg.bubbleOpacity = v;
    const bubble = q("aqh-bubble");
    if (bubble) bubble.style.setProperty("--aqh-o", String(getCssOpacity()));
  });

  (async () => {
    // Subframes carry no UI and no config worth fetching.
    if (!IS_TOP_FRAME) return;
    const res = (await callBg("aqh/get-config")) || {};
    cfg = res.cfg || null;
    incognito = !!res.incognito;
    if (cfg && cfg.promptMode) promptMode = cfg.promptMode;
    log("boot promptMode=", promptMode, "incognito=", incognito);
    // FAB is hidden by default; user summons it via popup / shortcut / right-click.
  })();
})();
