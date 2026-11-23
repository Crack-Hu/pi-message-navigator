# pi-message-navigator

给 Pi 全屏模式（`tuiMode: "fullscreen"`，默认值）加两个跳转胶囊，并用**可见标签**标出可跳转的位置：

```
   ↓ Jump to latest message · ctrl+end        ← 内置的"跳到底部"胶囊

   ▌ user message:                            ← 用户消息开头（可跳转）

   （用户消息）

   （灰色 thinking / 工具输出...）

   ▌ assistant message:                       ← 白色正文开头（可跳转）

   （模型真正对你说的话，白色正文）

   ↑ Prev · ctrl+up     ↓ Next · ctrl+down    ← 向上滚动时出现的两个胶囊
> 输入框
```

| 操作 | 落点 |
|---|---|
| `ctrl+up` 或点 `↑ Prev` | 上一条标签（用户消息或 assistant 白色正文，不区分） |
| `ctrl+down` 或点 `↓ Next` | 下一条标签 |

标签统一处理：不管上一条是用户消息还是 assistant 正文，向上/向下都只按"上一个/下一个块"移动。

标签就是跳转锚点：能看见、能被搜索、能被复制，没有隐藏字符（唯一的不可见序列是 Pi 自己就在写的 `OSC 133;A`）。

---

## 标签放在哪里

- **user**：在 `UserMessageComponent.render` 里把 `▌ user message:` 插到消息顶部 padding 行之前（padding 行保留，作为标签下方的空行）；
- **assistant**：在 `AssistantMessageComponent.render` 里找到第一个 **`kind === "text"` 的 Markdown 块**（白色正文），在它前面插入 `▌ assistant message:`。

关键点：

- thinking 块（`kind === "thinking"`，灰色/斜体）和隐藏 thinking 的 `Text` 行都不会被标记；
- 只带 thinking + tool call、没有正文的 assistant 消息不会出现标签；
- 标签上下**各一条空行**；user 标签让 transcript 多一行，assistant 标签多两行；
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
  最后一行；扩展没有"再画一个"的钩子。
- 公开的 `TUI` 接口没有任何 transcript 滚动方法；`TuiAltScreen` 上有 `scrollToTop` / `scrollToBottom` /
  `scrollBy`（公开）和 `scrollToPrompt`（TS `private`，运行时存在）。
- 扩展拿到的 `tui` 是 InteractiveMode 的稳定 Proxy，会转发到当前 renderer；transcript 的完整渲染行可以通过
  `tui.currentLayout` 里的 scroll box（`scrollContentLines`）读到。
- widget + `handleMouse` 是全屏模式下唯一可用的"可点击 UI"入口（布局里的 `Container` 会按行转发鼠标事件）。

所以：能做，但要 monkey-patch 三个原生方法（user render、assistant render、`scrollToPrompt`）。
这些是运行时包装，不写盘；`session_shutdown` 时会还原。

## 安装 / 试用

当前项目里已经放在：

```
.pi/extensions/message-navigator.ts
```

在会话里执行 `/reload` 即可（新增项目扩展时可能弹一次项目信任确认）。
单独试用：

```bash
pi -e ./message-navigator.ts
```

永久安装（本地包）：

```bash
pi install .
```

## 对 Pi 数据/上下文的影响

只影响渲染层：

- 不改 `message.content`、session JSONL、token 统计、压缩、`/copy`（无选区时走 `getLastAssistantText`）；
- 标签会进入终端输出、全屏搜索（`ctrl+shift+f`）和**选区复制**的文本；
- 多出的 `OSC 133;A` 只是终端 prompt 标记，不参与模型上下文。

## 限制

- **仅全屏模式**。普通模式下滚动条归终端，没有可操作的视口。
- **仅鼠标点击**；键盘用内置的 `ctrl+up` / `ctrl+down`（现在跳到上一个/下一个标签）。
- 依赖几个非公开实现细节（`AssistantMessageComponent.render` / `markdownSlots`、`UserMessageComponent.render`、
  `TuiAltScreen.scrollToPrompt`、布局里的 `scrollContentLines`）。Pi 升级后可能需要跟着改；
  找不到结构时会退回原生 `scrollToPrompt` 行为。
- 标签文本和颜色在 `LABEL_PROMPT` / `LABEL_REPLY` / `styledLabel()` 里，可以直接改。
- 一条 assistant 消息里如果有多段正文，只标第一段；正常对话里通常一段。
- 标签和它上下的空行都会出现在终端输出里，transcript 会比原生多出这些行；选区复制也会带上它们。
- 扩展卸载后 `/reload` 会还原原型方法；已渲染出来的标签会在下一次重绘时消失。

## 文件

- `message-navigator.ts` — 扩展本体（可见标签 + 跳转 + 胶囊）
- `package.json` — 本地 Pi 包清单
