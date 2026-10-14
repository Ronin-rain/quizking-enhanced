/** @license MIT — QuizKing · 答题王 toolbar popup. */
document.addEventListener("DOMContentLoaded", async () => {
  document.querySelectorAll("[data-k]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const k = btn.getAttribute("data-k");
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      // show-fab is a direct message (no capture payload), the rest go through aqh/capture.
      const msg = (k === "show-fab")
        ? { type: "aqh/show-fab" }
        : { type: "aqh/capture", payload: { kind: k } };
      chrome.tabs.sendMessage(tab.id, msg, (res) => {
        if (chrome.runtime.lastError) { $("status").textContent = "当前页面不可用"; return; }
        if (k === "show-fab" && res && typeof res.shown === "boolean") {
          $("status").textContent = res.shown ? "已召唤 王字气泡" : "已收起 王字气泡";
        }
      });
      if (k !== "show-fab") $("status").textContent = "已发送：" + k;
    });
  });
  $("opts").addEventListener("click", openOptionsPageSafe);
  if ($("incogEnable")) {
    $("incogEnable").addEventListener("click", () => {
      chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id }, () => {
        void chrome.runtime.lastError;
      });
    });
  }

  // The popup knows which window it was opened from; the background knows
  // whether incognito access was granted. Together they decide the hint.
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const inIncognito = !!(active && active.incognito);
  if (inIncognito) $("status").textContent = "当前为无痕窗口。";

  chrome.runtime.sendMessage({ type: "aqh/test" }, (res) => {
    if (!res || !res.ok) {
      $("status").textContent = "插件暂未就绪";
      return;
    }
    const n = res.providerCount || 0;
    $("keyState").textContent = res.hasKey
      ? ("API Key ✓" + (n > 1 ? (" · " + n + " 个服务商") : ""))
      : "未配置 API Key";
    renderIncognitoHint(!!res.incognitoAccess, inIncognito);
  });
});

function renderIncognitoHint(allowed, inIncognito) {
  const box = $("incogBox");
  if (!box) return;
  if (!allowed) {
    $("incogText").textContent =
      "尚未允许在无痕模式下使用。打开扩展详情页勾选「允许在无痕模式下使用」，否则无痕窗口里抓题不会有反应。";
    $("incogEnable").style.display = "";
    box.style.display = "";
    return;
  }
  if (inIncognito) {
    $("incogText").textContent = "无痕权限已开启，本窗口可正常抓题。";
    $("incogEnable").style.display = "none";
    box.style.display = "";
  }
}

// Settings opened from an incognito window cannot be an incognito tab, so let
// background put it in a regular window instead of failing quietly.
function openOptionsPageSafe() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    chrome.runtime.sendMessage(
      { type: "aqh/open-options", payload: { incognito: !!(tab && tab.incognito) } },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          $("status").textContent = "打开设置失败，请到 chrome://extensions 打开选项页";
        }
      }
    );
  });
}

function $(id) { return document.getElementById(id); }
