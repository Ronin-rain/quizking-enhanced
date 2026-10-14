# FAQ

常见问题。Issue 之前先扫一遍这里。

## 安装 / 卸载

**Q: 安装后图标不出现？**
A: 检查 `chrome://extensions/` 是否有红色错误条。最常见：`src/_locales/zh_CN/messages.json` 缺失或 `manifest.json` JSON 损坏。重新加载一次即可。

**Q: 卸载后我的数据还在吗？**
A: 卸载扩展会清掉 `chrome.storage.sync` 里的配置（服务商列表 endpoint / key / model、prompt 等）。`chrome.storage.local` 里的历史记录也会清（Chrome 卸载扩展的默认行为）。备份靠你自己导出。

## 配置

**Q: 我可以接 DeepSeek / 火山方舟 / Ollama 吗？**
A: 任何 OpenAI 兼容的 `/v1/chat/completions` endpoint 都可以。Endpoint 填 base URL，**不要**带 `/chat/completions` 后缀，代码自动拼。

**Q: 能同时用多个 API 对比答案吗？**
A: 能。选项页「LLM 连接」→「＋ 添加服务商」，每个服务商填自己的 Endpoint / Key / Model 并勾选「启用」。抓题时会**同时**发给所有启用的服务商（真并发，总耗时约等于最慢的那个），气泡里并列展示各自答案并标记是否一致。想临时停用某个，取消它的「启用」勾选即可（不必删除配置）。

**Q: 多服务商里有一个报错，会连累其他吗？**
A: 不会。失败的那个显示为红色卡片并附原因（如 `HTTP 401`），其余答案照常展示。全部失败时气泡只显示错误卡片。

**Q: 图片题发给不支持视觉的模型会怎样？**
A: 截图/图片会发给**所有**启用的服务商。不支持视觉的模型会返回错误，显示为该服务商的失败卡片。若不想浪费调用，可只为视觉模型单独建一个服务商，做题时按需勾选启用。

**Q: 截图通道要什么模型？**
A: 多模态模型。OpenAI `gpt-4o-mini` / `gpt-4o`、DeepSeek 暂无视觉、火山 `doubao-1.5-vision`、阿里 `qwen-vl-max`、本地 Ollama `llava` 都可以。

**Q: 提示词可以自定义吗？**
A: 选项页 → Prompt 模式 → 「自定义」单选，下方出现 system prompt 编辑框，点保存。改后立刻生效。

**Q: 「只要答案」和「答案 + 解析」会冲突吗？**
A: 不会。两个模式都要求模型回 JSON `{answer, ...}`，只是 reasoning 字段是否渲染。

## 使用

**Q: 划词没反应？**
A: 检查是否有 `getSelection().toString()` 文本。有些页面（如 PDF reader、Shadow DOM）`window.getSelection` 拿不到。试试「整页 DOM 文本」或「截图」通道。

**Q: 截图框选一闪就退出？**
A: 把「划段文字 → Ctrl+Shift+E」改成至少拖 3 像素再松手。1 px 内的 click 算作取消。`Ctrl+Shift+H` 是隐藏气泡（不是框选）。

**Q: 截图发给 LLM 安全吗？**
A: 截图经 `canvas` 重画后 base64 → POST 到你填的 endpoint。中间**不**经过我们任何服务器。endpoint 是你自己配置的（OpenAI / DeepSeek / 自建）。

**Q: 气泡一直不消失？**
A: `Ctrl+Shift+H` 切换。或点气泡右上角 `—`（最小化）/ `✕`（关闭，**会清空内容**）。

## 无痕 / 受限环境

**Q: 无痕窗口里抓题没反应、快捷键也没用？**
A: 先看 `chrome://extensions` → QuizKing「详情」→「允许在无痕模式下使用」是否打开。没打开时 Chrome 既不执行扩展动作，也不会把快捷键回退给浏览器默认行为——所以表现为“按了完全没反应”。打开后无需重装，快捷键立即生效。

**Q: 无痕窗口里点「设置」打不开？**
A: 这是 Chrome 的限制，不是 bug：默认 `"incognito": "spanning"` 模式下扩展不能把自己的页面加载进无痕标签页。插件会检测到并改在**普通窗口**打开设置页；若连普通窗口也没弹出，手动打开 `chrome://extensions` → 详情 → 扩展选项。

**Q: 无痕窗口里问的题会存进历史吗？**
A: 默认**不会**。`chrome.storage.local` 是普通窗口和无痕窗口共用的，所以无痕会话默认不落盘，避免私密会话留痕。需要留档时在选项页勾选「无痕会话也保存历史记录」。

**Q: 考试用的 LockDown Browser / 受管 Chrome 里能用吗？**
A: 不能用，而且这不该由插件解决。那类环境的禁用是由管理员通过浏览器策略（或专用客户端）在外部下发的，扩展代码无法绕过；能绕过反而是安全漏洞。可用 `chrome://policy` 和 `chrome://extensions` 确认是否被策略接管。

**Q: 无痕窗口里我的 API Key 安全吗？**
A: Key 只存在 `chrome.storage.sync`，只有 background service worker 读得到，内容脚本永远拿不到（`sanitizeCfg` 逐条剥离）。无痕窗口不会把 Key 写进无痕会话的任何新位置。

## 网页把插件弄坏时

**Q: 某个网站里气泡死活不出现？**
A: 先确认是「站点手法」还是「浏览器限制」。浏览器限制页（`chrome://`、扩展商店、PDF 阅读器、其他扩展的页面）任何扩展都进不去，popup 会直接告诉你原因；`file://` 需要到扩展详情页打开「允许访问文件网址」。如果是站点手法，气泡被页面删掉后会在 1 秒内自动挂回，已显示的内容不丢。

**Q: 气泡被页面的弹窗/遮罩盖住了？**
A: 不会了。宿主元素通过 popover API 进入浏览器**顶层**，页面用多大的 z-index 都盖不住它。

**Q: 页面的样式把气泡改得面目全非？**
A: 不会了。UI 现在整个在 Shadow DOM 里，页面的 CSS（包括 `* { … }` 这种全局重置）够不到气泡内部；宿主元素自带 inline `!important`，页面的 `#aqh-root{display:none!important}` 之类也压不过它。

**Q: 页面上的按钮点不动？**
A: 所有按钮点击都由内容脚本在**捕获阶段**统一处理，而且脚本在 `document_start` 就注册好了，早于页面自己的脚本，所以页面「吞事件」的写法不再有效。

**Q: 题目在 iframe 里，划词能抓到吗？**
A: 能。抓选区时会向页面里所有帧收选区，取最长的那段回顶层渲染气泡（配置见 `manifest.json` 的 `all_frames`）。

**Q: 网站禁用了文字选择，划词没反应？**
A: 这类站点用 `user-select: none` 做复制保护，扩展不去破解，改用「抓取截图」通道（`Ctrl+Shift+E`）即可。

**Q: 有网站能把气泡彻底搞掉吗？**
A: 有一种：页面持续用 `MutationObserver` + 定时器把 `<body>` 里新增的节点全删掉。这种写法也会把它自己的弹窗一起删掉，现实里很少见；真遇到就没有办法。可复现样例见 `_testpage/attacks.html?atk=sweepbody`。

**Q: 能不能让插件对网站「隐身」，不被检测到？**
A: 不做，而且做了也没用——任何脚本走一遍 DOM 就能看到注入的宿主节点，伪装只会让代码更脆、更难维护。同理，绕开考试或受管环境的监考机制也不在本项目范围内。

## 故障排查

**Q: 状态栏「未配置 API Key」？**
A: 选项页添加服务商并填 key → 底部「保存」（不是「测试」）。看 status 出现「✓ 已保存」。注意：只填了 key 但没勾选「启用」的服务商不会被调用。

**Q: 状态栏「失败：HTTP 401」？**
A: API key 无效或被吊销。回选项页重新粘贴。

**Q: 状态栏「失败：HTTP 404」？**
A: Endpoint 路径写错。`https://api.openai.com/v1` 是对的（**不要**加 `/chat/completions`，代码自动拼）。

**Q: 状态栏「CORS / Failed to fetch」？**
A: 你的 endpoint 没开 CORS。**Ollama** 默认 `http://localhost:11434/v1` 在 Chrome 里**禁止**跨域，要自建反代或换用其他 endpoint。

**Q: 模型回了 reasoning 但气泡不显示？**
A: 检查选项页 Prompt 模式。如果是「只要答案」，UI 强制不显示 reasoning。切到「答案 + 解析」再试。

## 开发者

**Q: 怎么调试？**
A: 普通网页 F12 → console 找 `[aqh]` 日志。Service worker 日志在 `chrome://extensions/` → QuizKing → 「service worker」链接。

**Q: 离线自检路由？**
A: SW DevTools 跑：
```js
self.__AQH_SELFTEST__ = true;
chrome.runtime.sendMessage({ type: "aqh/selftest" }, console.log);
```
返回 `{ ok, cfg, routes, flags }` 表示消息通道正常，不依赖 LLM。

**Q: 我能 fork 后打包到 Chrome Web Store 吗？**
A: 欢迎。MIT 协议允许，**请保留原作者署名 + LICENSE 文件**。
