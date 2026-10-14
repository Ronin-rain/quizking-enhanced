# tools/ — 无痕模式冒烟测试

这套脚本用来在本机真机验证「无痕 / 受限环境」相关改动，不依赖真实 LLM（抓题链路走本地 mock）。

## 为什么用 Edge 而不是 Chrome

Google Chrome 官方版从内核层拒绝了命令行加载未打包扩展：

```
--load-extension is not allowed in Google Chrome, ignoring.
```

所以自动化验证改用同内核的 Microsoft Edge（可直接用 CLI 加载扩展）。**手工验证仍建议用你日常的 Chrome**：`chrome://extensions` → 开发者模式 → 加载已解压 → 选 `src/`。

## 跑一遍

```powershell
# 1) 本地测试页 + 假 LLM
Start-Process python -ArgumentList '-m','http.server','8123','--bind','127.0.0.1','--directory','<本仓库>\_testpage' -WindowStyle Hidden
Start-Process node   -ArgumentList 'tools\mock-llm.mjs' -WindowStyle Hidden

# 2) 用 Edge 载入扩展（headless 亦可）
Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -ArgumentList `
  "--user-data-dir=$env:TEMP\quizking-ext","--load-extension=<本仓库>\src","--disable-extensions-except=<本仓库>\src",`
  "--remote-debugging-port=9334","--no-first-run","--headless=new","http://127.0.0.1:8123/"

# 3) 验证
node tools\verify-incognito.mjs http://127.0.0.1:9334 http://127.0.0.1:8123/ http://127.0.0.1:8135/v1
```

`verify-incognito.mjs` 覆盖：扩展 SW 启动、manifest 的 `incognito`/version、内容脚本注入、`aqh/get-config`
通道与 `incognito` 标记、`aqh/test`、`aqh/open-options` 两条分支（普通窗口 / 无痕分支）、气泡渲染、
抓题全链路（立即回执 → 增量推送 → 历史落盘）。

## 另外两个脚本

```powershell
# 「网页屏蔽扩展」的各种手法，逐条实测（会开一堆标签页，约 1 分钟）
node tools\probe-attacks.mjs http://127.0.0.1:9334 http://127.0.0.1:8123/attacks.html

# 题目在 iframe 里时，划词通道能否跨帧拿到选区
node tools\verify-frame.mjs http://127.0.0.1:9334 http://127.0.0.1:8123/frame.html
```

`probe-attacks.mjs` 会依次打开 `_testpage/attacks.html?atk=<每种手法>`，对每个页面检查四件事：
UI 是否渲染、是否可见、`elementFromPoint` 命中的是不是我们自己（有没有被盖住）、✕ 按钮是否点得动；
最后再从页面侧把宿主节点删掉一次，验证自愈能不能把它挂回来。

## 已知边界

真要压测「无痕标签页」本身，需要先由人在 `chrome://extensions` 里打开「允许在无痕模式下使用」——
这一步是浏览器安全设计，脚本无法代劳（改 profile 的 Secure Preferences 会破坏其 HMAC 校验）。
未开启时 `chrome.extension.isAllowedIncognitoAccess()` 返回 `false`，无痕窗口里不会注入内容脚本。

`atk=sweepbody`（持续清空 `<body>` 新增节点）是刻意保留的**必败**用例，用来标记已知上限，别把它当 bug 修。
