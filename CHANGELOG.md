# 更新日志

本仓库是 [ops120/quizking](https://github.com/ops120/quizking) 的增强分支。上游 `v0.3.0` 之后的变化记录在这里。
版本号沿用上游的 `主.次.修订`；`0.4.1` 为当前版本。

## [0.4.1] — 轻量化与痕迹收敛

### 变更

- 配置改为**首次抓题时才拉取**：页面加载期不再建节点、不起定时器、不发消息，也不再为每个页面唤醒 service worker
- 气泡关闭 / FAB 收起后，宿主节点**整体从页面摘除**；不使用时页面里没有任何扩展节点
- 自愈心跳在标签页隐藏时跳过；子框架只保留「上报选区」的最小监听（点击委托、自愈、配置监听只在顶层框架注册）
- 宿主样式由内联 `!important` 改为 shadow root 内的 `:host { … !important }`（利用「内层树的 important 声明优先」这条级联规则），宿主节点不再带 `style` 属性
- 移除 manifest 中从未被使用的 `scripting`、`notifications` 权限

### 新增

- `tools/probe-detectability.mjs`：站在网站脚本的视角测量「能检测到什么」（未使用 / 气泡中 / 关闭后三种状态）
- README 增加「网站能检测到什么（实测）」「轻量化」两节

## [0.4.0] — 抗页面屏蔽加固

### 变更

- 气泡与 FAB 整体迁入 Shadow DOM；宿主用 popover API 进入浏览器顶层，页面无法用 z-index 覆盖
- 新增自愈：宿主被页面删除后自动挂回，已渲染的内容不丢失；每次抓题前也会补挂一次
- 所有 UI 点击改为捕获期事件委托；内容脚本 `run_at` 改为 `document_start`，注册早于页面脚本
- 内容脚本改为 `all_frames: true` + `match_about_blank`；抓选区时跨帧收集，取最长的一段回顶层渲染
- UI 触发消息限定顶层框架（`frameId: 0`），避免多框架重复渲染
- 宿主优先挂在 `<body>`；若 body 链上存在会破坏 fixed 定位的 `transform` / `filter` / `contain` 等，自动回退挂到 `<html>`
- 气泡样式内联进 shadow root，`src/bubble.css` 随之移除

### 新增

- `tools/probe-attacks.mjs`、`tools/verify-frame.mjs` 与 `_testpage/attacks.*`：8 种屏蔽手法的实测矩阵
- README「网页能怎么弄坏插件，以及现在的对策」、FAQ「网页把插件弄坏时」

## [0.3.1] — 无痕模式可用

### 新增

- `manifest.json` 显式声明 `"incognito": "spanning"`
- 无痕感知：`aqh/get-config`、`aqh/ask`、`aqh/test` 的回执带无痕标记，气泡标题在无痕窗口显示「无痕」角标
- 新路由 `aqh/open-options`：无痕窗口里点 ⚙ 时自动改在普通窗口打开设置页
- 选项页「无痕模式 / 受限环境」区块：显示无痕权限状态、一键跳扩展详情页、开关「无痕会话也保存历史记录」
- popup：未开启无痕权限时给出提示与跳转按钮；页面不可用时按 URL 给出具体原因

### 变更

- 无痕会话默认不写入共享历史（`chrome.storage.local` 在普通窗口与无痕窗口之间共用）

## [0.3.0] — 上游基线

上游 [ops120/quizking](https://github.com/ops120/quizking) 在此版本提供多 API 并行对比、结果增量返回、三通道采集、气泡透明度联动、popup / 快捷键 / 右键菜单触发等全部原始功能。本仓库从这一版开始改动。
