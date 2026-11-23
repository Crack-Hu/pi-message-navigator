# pi-message-navigator

给 Pi 全屏 transcript 加消息导航和 `ctrl+t` 紧凑模式。**不往 transcript 里注入任何字符、标签或额外行**：锚点直接从 Pi 1.6 的 `Container.childLines`（每个子组件渲染后的行区间）计算。

## 导航

| 操作 | 落点 |
|---|---|
| `ctrl+up` / 点 `↑ Prev` | 上一条**用户消息的第一行文本**，或上一条 **assistant 白色正文的第一行** |
| `ctrl+down` / 点 `↓ Next` | 下一条（同上） |
| `ctrl+end` / 点 `↓ Latest` | 跳到底部并恢复跟随 |

- 只把用户消息和 assistant 的白字正文作为锚点；thinking、工具调用/结果不参与。
- 短目标落在视口 **1/3** 处，上方留出上一段内容；长目标和很小的视口（1/3 不足 6 行）顶格。
- 三个按钮在同一行；跟随输出（在底部）时整行隐藏。
- 用 `Prev` / `Next` 跳转后会暂停"跟随输出"（即使落点就是最后一行），按钮保持可见；点 `Latest` 或手动滚到底部恢复跟随。
- 跳转后，落点那一行会**红底反色闪两下**（约 470ms），明确告诉你从哪里开始读。
- 常量在文件顶部：`CONTEXT_FRACTION = 1 / 3`、`MIN_CONTEXT_ROWS = 6`。

## 紧凑模式（`ctrl+t`）

Pi 原生只有两个开关：

| 开关 | 作用 |
|---|---|
| `ctrl+t` | 折叠 thinking |
| `ctrl+o` | 切换工具结果的预览/完整输出 |

本扩展把「一段 thinking + 紧随其后的工具调用（和结果）」视为**一个整体块**：

- `ctrl+t` 隐藏 thinking 时，整块折叠成一行：`▌ 这段思考的前 N 列…`（超出宽度自动加省略号）；
- **点击这一行** → 展开完整 thinking + 工具调用/结果；再点收起；
- 展开时会取消"跟随输出"并保持当前滚动位置，思考从原来的位置向下展开，不会跳到末尾；
- 折叠时该组的工具组件完全不渲染；
- `ctrl+o` 仍然只控制展开后工具结果的预览/完整输出；
- 没有 thinking 的独立工具调用不参与分组，按原生行为显示；
- `edit` 展开后按原样显示（含 diff 预览）。

预览行就是 Pi 原生 thinking 标签的位置，所以点击复用原生逻辑；分组状态只存在于渲染层，不写会话文件、不进模型上下文。

## 实现方式

Pi 1.6 的 `Container.render()` 会跨帧复用同一个 lines 数组，`Container.childLines` 记录了每个直接子组件的渲染结果（`children` + `parts`）。扩展据此：

1. 找到 transcript 的 document 容器，递归遍历 `childLines.children`；
2. 用 `instanceof UserMessageComponent` / `AssistantMessageComponent` 识别消息组件；
3. 用累计的 `parts[i].length` 得到每个消息在 transcript 里的起始行，assistant 再加上它第一个 `text` block 的偏移；
4. 把 `TuiAltScreen.scrollToPrompt` 重定向到这些锚点。

因此不需要可见标签，也不需要零宽字符。唯一的不可见序列仍然是 Pi 自己写的 `OSC 133`。

运行时包装的内部方法（`session_shutdown` 全部还原）：

- `UserMessageComponent.render` / `AssistantMessageComponent.render`：跳转后给锚点行加红底闪烁；`AssistantMessageComponent.render` 同时负责紧凑模式下的预览行；
- `AssistantMessageComponent.handleMouse`：点击 thinking 后固定滚动位置，避免自动跳到新的末尾；
- `ToolExecutionComponent.render`：折叠组内的工具不渲染；
- `TuiAltScreen.scrollToPrompt`：改为锚点跳转，找不到时回退原生行为；
- `TuiAltScreen.compositeScrollToEndIndicator`：隐藏内置的 "↓ Jump to latest message" 胶囊，由按钮行的 `Latest` 取代；
- `InteractiveMode.updateThinkingBlockVisibility`：同步紧凑状态。

## 安装

```bash
pi install git:github.com/Crack-Hu/pi-message-navigator
```

固定分支 / 标签 / commit：

```bash
pi install git:github.com/Crack-Hu/pi-message-navigator@main
```

安装后重启 pi（或 `/reload`）生效。日常管理：

```bash
pi list                                     # 查看已安装
pi update --extensions                      # 更新
pi remove git:github.com/Crack-Hu/pi-message-navigator
```

> 私有仓库需要先配置好 SSH key 或 git 凭据。

## 对 Pi 数据/上下文的影响

只影响渲染层：

- 不改 `message.content`、session JSONL、token 统计、压缩、`/copy`（无选区时走 `getLastAssistantText`）；
- 不往 transcript 注入任何字符或行；`ctrl+t` 的预览行替换的是 Pi 原生的 thinking 标签行；
- 依赖 1.6.0 的 `Container.childLines` 和几个 TS-private 方法；升级后如有变动会退回原生行为。

## 限制

- **仅全屏模式**（`tuiMode: "fullscreen"`）。
- 只能定位**已经渲染过至少一帧**的消息；首帧之前没有 `childLines`，跳转会回退到 Pi 原生的 OSC 标记。
- `ctrl+t` 的分组依赖「thinking + 同一条 assistant 消息里的 toolCall」；没有 thinking 的工具调用不分组。
- 一条 assistant 消息里有多段 thinking 时只处理第一段（正常对话通常一段）。
- `edit` 使用 self-render shell，展开后仍会显示 diff 预览。
- 闪烁颜色用的是主题的 `error`（偏橙红）；想更亮可以改成固定亮红。

## 文件

- `message-navigator.ts` — 扩展本体
- `package.json` — 本地 Pi 包清单
