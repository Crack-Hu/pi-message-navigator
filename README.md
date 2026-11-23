# pi-message-navigator

给 Pi 全屏模式（`tuiMode: "fullscreen"`，默认值）加两个跳转胶囊，并用**可见标签**标出可跳转的位置：

```
   ↓ Jump to latest message · ctrl+end        ← 内置的"跳到底部"胶囊

   ▌ user message:                            ← 用户消息开头（可跳转）

   （用户消息）

   （灰色 thinking / 工具输出...）

   ▌ assistant message:                       ← 白色正文开头（可跳转）

   （模型真正对你说的话，白色正文）

   ↑ Prev · ctrl+up     ↓ Next · ctrl+down     ↓ Latest · ctrl+end
> 输入框                                       ← 三个按钮同一行，向上滚动时出现
```

| 操作 | 落点 |
|---|---|
| `ctrl+up` 或点 `↑ Prev` | 上一条标签（用户消息或 assistant 白色正文，不区分） |
| `ctrl+down` 或点 `↓ Next` | 下一条标签 |
| `ctrl+end` 或点 `↓ Latest` | 跳到底部并恢复跟随 |

### 落点高度

- 块（从标签到下一条标签）高度能放进视口下方 2/3 时，标签落在**视口 1/3**处，上方留出上一段内容作为呼吸空间；
- 块太长放不下时**顶格**（标签在视口顶部）；
- 视口本身很小时（1/3 不足 6 行，手机/小窗口）也**顶格**。

常量在文件顶部：`CONTEXT_FRACTION = 1 / 3`、`MIN_CONTEXT_ROWS = 6`。

标签统一处理：不管上一条是用户消息还是 assistant 正文，向上/向下都只按"上一个/下一个块"移动。
三个按钮在同一行；内置的 "↓ Jump to latest message" 胶囊被隐藏并由这一行的 `Latest` 取代。

标签就是跳转锚点：能看见、能被搜索、能被复制，没有隐藏字符（唯一的不可见序列是 Pi 自己就在写的 `OSC 133;A`）。

---

## 标签放在哪里

- **user**：在 `UserMessageComponent.render` 里把 `▌ user message:` + 一条空行插到消息顶部 padding 行之前（padding 行本身也还在）；
- **assistant**：在 `AssistantMessageComponent.render` 里找到第一个 **`kind === "text"` 的 Markdown 块**（白色正文），在它前面插入 `▌ assistant message:`。

关键点：

- thinking 块（`kind === "thinking"`，灰色/斜体）和隐藏 thinking 的 `Text` 行都不会被标记；
- 只带 thinking + tool call、没有正文的 assistant 消息不会出现标签；
- 标签上下**各一条空行**；user 标签让 transcript 多两行（plain 空行 + 原有 padding），assistant 标签多两行；
- 标签用 `theme.fg("accent", ...) + bold` 着色（主题切换会自动跟随）；
- 用户消息的标签行保留 Pi 的 `OSC 133;A` 标记。

因此上下跳转不会再落到灰色 thinking 或工具输出上，而是落在"模型开始对你说正文"的那一行（或用户消息开头）。

## 为什么上一版会跑到工具调用/thinking

Pi 核心只在这两类消息上写 OSC 133 标记：

- `UserMessageComponent`：每条用户消息；
- `AssistantMessageComponent`：**不含 tool call** 的 assistant 消息。

一轮回复里，带 tool call 的 assistant 消息没有标记，只有最后的纯文本消息有；而 assistant 组件开头还可能是 thinking（灰色）。
所以原生 `scrollToPrompt(-1)` 的落点既可能是"工具调用之后的文本"，也可能包含 thinking，和"白色正文开头"并不一致。

本扩展直接把可见标签放在正文块首行，并用包装后的 `TuiAltScreen.scrollToPrompt` 在新标签中查找；找不到标签时退回原生行为。

## 调研结论（API 现状）

- 内置 keybinding 已存在：`tui.altScreen.previousPrompt` / `nextPrompt`（默认 `ctrl+shift+up`、`ctrl+up`）。
- 内置的 "↓ Jump to latest message" 由 Pi 在 `dist/modes/interactive/tui-renderer.js` 里通过
  `scrollToEndIndicator` 传给 renderer，由 `compositeScrollToEndIndicator()` 直接叠加在 transcript
  最后一行；扩展没有"再画一个"的钩子，所以本扩展把这一行隐藏，改由自己的按钮行提供 `Latest`。
- 公开的 `TUI` 接口没有任何 transcript 滚动方法；`TuiAltScreen` 上有 `scrollToTop` / `scrollToBottom` /
  `scrollBy`（公开）和 `scrollToPrompt`（TS `private`，运行时存在）。
- 扩展拿到的 `tui` 是 InteractiveMode 的稳定 Proxy，会转发到当前 renderer；transcript 的完整渲染行可以通过
  `tui.currentLayout` 里的 scroll box（`scrollContentLines`）读到。
- widget + `handleMouse` 是全屏模式下唯一可用的"可点击 UI"入口（布局里的 `Container` 会按行转发鼠标事件）。

所以：能做，但要 monkey-patch 三个原生方法（user render、assistant render、`scrollToPrompt`）。
这些是运行时包装，不写盘；`session_shutdown` 时会还原。

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

## ctrl+t 的紧凑模式

Pi 原生只有两个开关：

| 开关 | 作用 |
|---|---|
| `ctrl+t` | 折叠 thinking（只作用于 #2） |
| `ctrl+o` | 切换工具结果（#4）的预览/完整输出 |

本扩展把「一段 thinking + 紧随其后的工具调用（和结果）」视为**一个整体块**：

- `ctrl+t` 隐藏 thinking 时，整块折叠成一行：`▸ 这段思考的前 N 列…`（超出宽度自动加省略号）；
- **点击这一行** → 展开完整 thinking + 工具调用/结果；再点收起；
- 折叠时该组的工具组件完全不渲染；
- `ctrl+o` 仍然只控制展开后工具结果的预览/完整输出；
- 没有 thinking 的独立工具调用不参与分组，按原生行为显示；
- `edit` 展开后按原样显示（含 diff 预览）。

预览行就是 Pi 原生 thinking 标签的位置，所以点击复用原生逻辑；分组状态只存在于渲染层，不写会话文件、不进模型上下文。

紧凑模式跟着 `hideThinkingBlock` 走，所以在 `~/.pi/agent/settings.json` 里设置
`"hideThinkingBlock": true` 也会直接进入这个模式；`ctrl+t` 只是同一个开关的快捷键。

## 对 Pi 数据/上下文的影响

只影响渲染层：

- 不改 `message.content`、session JSONL、token 统计、压缩、`/copy`（无选区时走 `getLastAssistantText`）；
- 标签会进入终端输出、全屏搜索（`ctrl+shift+f`）和**选区复制**的文本；
- 多出的 `OSC 133;A` 只是终端 prompt 标记，不参与模型上下文。

## 限制

- **仅全屏模式**。普通模式下滚动条归终端，没有可操作的视口。
- **仅鼠标点击**；键盘用内置的 `ctrl+up` / `ctrl+down`（现在跳到上一个/下一个标签）。
- 依赖几个非公开实现细节（`AssistantMessageComponent.render` / `markdownSlots`、`UserMessageComponent.render`、
  `TuiAltScreen.scrollToPrompt`、`TuiAltScreen.compositeScrollToEndIndicator`、布局里的 `scrollContentLines`）。Pi 升级后可能需要跟着改；
  找不到结构时会退回原生 `scrollToPrompt` 行为。
- 标签文本和颜色在 `LABEL_PROMPT` / `LABEL_REPLY` / `styledLabel()` 里，可以直接改。
- 一条 assistant 消息里如果有多段正文，只标第一段；正常对话里通常一段。
- 标签和它上下的空行都会出现在终端输出里，transcript 会比原生多出这些行；选区复制也会带上它们。
- 扩展卸载后 `/reload` 会还原原型方法；已渲染出来的标签会在下一次重绘时消失。

## 文件

- `message-navigator.ts` — 扩展本体（可见标签 + 跳转 + 胶囊）
- `package.json` — 本地 Pi 包清单
