/**
 * Message navigation for the Pi fullscreen transcript.
 *
 * Pi 1.6 keeps the rendered lines of every `Container` child, so user and
 * assistant messages can be located by component identity and row offset
 * directly. No labels, markers or other bytes are injected into the transcript.
 *
 * - `ctrl+up` / `↓ Prev`  jump to the previous message anchor
 * - `ctrl+down` / `↓ Next` jump to the next message anchor
 * - `ctrl+end` / `↓ Latest` jump to the bottom
 *
 * An anchor is the first text row of a user message or the first white (text)
 * block of an assistant message. Large viewports put it one third down; small
 * viewports leave max(2, viewport/8) rows above it. Message length is ignored.
 *
 * Compact mode follows `hideThinkingBlock` (ctrl+t): a thinking run plus the
 * tool calls of the same assistant message form one group. While the thinking
 * is hidden the group collapses to a single preview line taken from the
 * thinking text (truncated with an ellipsis), and the group's tool components
 * disappear. Clicking the preview expands the full thinking and the tools;
 * tool results keep ctrl+o's native preview / expand behavior.
 */

import {
	AssistantMessageComponent,
	InteractiveMode,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	TuiAltScreen,
	getKeybindings,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const WIDGET_KEY = "message-navigator";
const WIDGET_PLACEMENT = "aboveEditor" as const;

/** Large viewports: anchor lands this fraction down the viewport. */
const CONTEXT_FRACTION = 1 / 3;
/** 1/3 of the viewport must be at least this many rows to count as "large". */
const MIN_CONTEXT_ROWS = 6;
/** Small viewports: leading rows are viewportHeight / this. */
const SMALL_CONTEXT_DIVISOR = 8;
/** Small viewports never hug the top edge (looks cramped). */
const MIN_SMALL_CONTEXT_ROWS = 2;

// ---------------------------------------------------------------------------
// Shared state (survives /reload: the prototypes stay patched in-process)
// ---------------------------------------------------------------------------

/** `scrollToPrompt` and `compositeScrollToEndIndicator` are TS-private in pi-tui. */
type ScrollToPromptFn = (this: TuiAltScreen, direction: number) => void;
type CompositeIndicatorFn = (this: TuiAltScreen, screen: string[], layout: unknown, width: number) => string[];
const altScreenProto = TuiAltScreen.prototype as unknown as {
	scrollToPrompt: ScrollToPromptFn;
	compositeScrollToEndIndicator: CompositeIndicatorFn;
};

/** `updateThinkingBlockVisibility` is TS-private on InteractiveMode. */
type UpdateThinkingVisibilityFn = (this: { hideThinkingBlock?: boolean }) => void;
const interactiveProto = InteractiveMode.prototype as unknown as {
	updateThinkingBlockVisibility: UpdateThinkingVisibilityFn;
};

type AssistantHandleMouseFn = (
	this: AssistantMessageComponent,
	event: TuiMouseEvent,
) => TuiMouseEventResult | undefined;
const assistantProto = AssistantMessageComponent.prototype as unknown as {
	render: (this: AssistantMessageComponent, width: number) => string[];
	handleMouse?: AssistantHandleMouseFn;
};

/** Tool rendering hook: group members hide while their thinking is collapsed. */
interface ToolRuntime {
	toolCallId?: string;
	expanded?: boolean;
	result?: { isError?: boolean };
	contentBox?: { children?: unknown[]; removeChild(component: unknown): void };
	hasRendererDefinition?: () => boolean;
	getRenderShell?: () => string;
	/** Last compact/group state, used to rebuild the tool lazily. */
	compactState?: boolean;
	inGroup?: boolean;
	groupHidden?: boolean;
}
type ToolRenderFn = (this: ToolRuntime, width: number) => string[];
type ToolUpdateDisplayFn = (this: ToolRuntime) => void;
const toolProto = ToolExecutionComponent.prototype as unknown as {
	render: ToolRenderFn;
	updateDisplay: ToolUpdateDisplayFn;
};

interface ThinkingGroup {
	assistant: AssistantRuntime;
	runIndex: number;
}

/** A jump target: transcript row, owning component and its line inside it. */
interface Anchor {
	row: number;
	component: unknown;
	offset: number;
}

interface PatchState {
	patched: boolean;
	/** Stable TUI proxy, used to pin the viewport after a thinking toggle. */
	tui?: unknown;
	/** True while thinking blocks are hidden; thinking+tool groups collapse. */
	compactThinking: boolean;
	/** toolCallId -> thinking group that owns it. */
	groups: Map<string, ThinkingGroup>;
	/** Stable theme proxy from ctx.ui.theme; used for the preview line. */
	theme?: Theme;
	/** Transient flash on the row an anchor jump landed on. */
	focus?: { component: unknown; offset: number; visible: boolean };
	/** Index of the anchor the last jump landed on, for Prev/Next chaining. */
	anchorIndex?: number;
	/** scrollTop right after that jump; a manual scroll invalidates the index. */
	anchorScrollTop?: number;
	focusTimer?: ReturnType<typeof setTimeout>;
	originals?: {
		userRender: typeof UserMessageComponent.prototype.render;
		assistantRender: typeof AssistantMessageComponent.prototype.render;
		assistantHandleMouse?: AssistantHandleMouseFn;
		scrollToPrompt: ScrollToPromptFn;
		compositeIndicator: CompositeIndicatorFn;
		updateThinkingVisibility: UpdateThinkingVisibilityFn;
		toolRender: ToolRenderFn;
		toolUpdateDisplay: ToolUpdateDisplayFn;
	};
}

const STATE_KEY = Symbol.for("pi.message-navigator.state");

function getState(): PatchState {
	const holder = globalThis as unknown as Record<symbol, PatchState | undefined>;
	let state = holder[STATE_KEY];
	if (!state) {
		state = { patched: false, compactThinking: false, groups: new Map() };
		holder[STATE_KEY] = state;
	}
	return state;
}

// ---------------------------------------------------------------------------
// Assistant runtime (duck-typed: fields are private in the component)
// ---------------------------------------------------------------------------

interface MarkdownChild {
	render(width: number): string[];
}

interface AssistantRuntime {
	markdownSlots?: Array<{ kind?: string; markdown?: MarkdownChild }>;
	contentContainer?: { children?: MarkdownChild[] };
	lastMessage?: { content?: Array<{ type?: string; text?: string; thinking?: string; id?: string }> };
	hideThinkingBlock?: boolean;
	thinkingVisibilityOverrides?: Map<number, boolean>;
	hiddenThinkingLabel?: string;
	outputPad?: number;
}

/** Text of the first contiguous thinking run in an assistant message. */
function firstThinkingRun(content: Array<{ type?: string; thinking?: string }>): string {
	let text = "";
	let started = false;
	for (const block of content) {
		if (block?.type === "thinking") {
			started = true;
			const value = typeof block.thinking === "string" ? block.thinking.trim() : "";
			if (value) text += (text ? " " : "") + value;
			continue;
		}
		if (started) break;
	}
	return text;
}

function isThinkingHidden(component: AssistantRuntime, runIndex: number): boolean {
	const override = component.thinkingVisibilityOverrides?.get(runIndex);
	return override ?? component.hideThinkingBlock === true;
}

/** One-line group header: "▸ <first N columns of the thinking>…". */
function buildThinkingPreview(component: AssistantRuntime, thinking: string, width: number, state: PatchState): string {
	const plain = thinking.replace(/\s+/g, " ").trim();
	const indent = " ".repeat(Math.max(0, component.outputPad ?? 0));
	const available = Math.max(12, width - indent.length - 2);
	const preview = truncateToWidth(plain, available, "…");
	const theme = state.theme;
	const marker = theme ? theme.fg("accent", "▌") : "▌";
	const body = theme ? theme.fg("muted", preview) : preview;
	return `${indent}${marker} ${body}`;
}

function replaceThinkingLabel(lines: string[], label: string, replacement: string): void {
	const target = label.trim();
	if (!target) return;
	for (let i = 0; i < lines.length; i++) {
		if (stripTerminalSequences(lines[i] ?? "").trim() === target) {
			lines[i] = replacement;
			return;
		}
	}
}

/**
 * Rendered line offset of the first assistant *text* block (white text).
 * Thinking blocks and the hidden-thinking label have kind "thinking" or are
 * plain Text children, so they are skipped.
 */
function firstTextLineOffset(component: AssistantRuntime, width: number): number | undefined {
	const slots = component.markdownSlots;
	const children = component.contentContainer?.children;
	if (!slots || !children) return undefined;
	const firstText = slots.find((slot) => slot.kind === "text")?.markdown;
	if (!firstText) return undefined;
	let offset = 0;
	for (const child of children) {
		if (child === firstText) return offset;
		offset += child.render(width).length;
	}
	return undefined;
}

/**
 * A thinking run and the tool calls that follow it are one group. While the
 * thinking is hidden, the group's tool components disappear and the native
 * "Thinking..." line becomes a truncated preview of the run. Clicking that
 * line toggles the thinking run, which shows the tools again.
 */
function registerThinkingGroup(
	state: PatchState,
	component: AssistantRuntime,
	content: Array<{ type?: string; thinking?: string; id?: string }>,
	lines: string[],
	width: number,
): void {
	const toolCalls = content.filter((block) => block?.type === "toolCall" && typeof block.id === "string");
	if (toolCalls.length === 0) return;
	const thinking = firstThinkingRun(content);
	if (!thinking) return;
	const runIndex = 0;
	for (const call of toolCalls) state.groups.set(call.id as string, { assistant: component, runIndex });
	if (!isThinkingHidden(component, runIndex)) return;
	replaceThinkingLabel(lines, component.hiddenThinkingLabel ?? "", buildThinkingPreview(component, thinking, width, state));
}

/**
 * No-thinking tools have no group header. In compact mode keep their one-line
 * call block and drop the result; clicking the call block expands it again.
 */
function collapseCompactResult(component: ToolRuntime): void {
	if (!component.result) return;
	if (!component.hasRendererDefinition?.() || component.getRenderShell?.() === "self") return;
	const box = component.contentBox;
	const children = box?.children;
	if (!box || !children || children.length < 2) return;
	// Children are [call, result]; keep the call row.
	box.removeChild(children[children.length - 1]);
}

// ---------------------------------------------------------------------------
// Transcript access
// ---------------------------------------------------------------------------

interface ChildLines {
	width?: number;
	children?: readonly unknown[];
	parts?: readonly string[][];
}

interface TranscriptView {
	scrollView: {
		scrollTop: number;
		scrollTo(row: number, options?: { disableFollow?: boolean }): void;
		scrollToEnd?: () => void;
		readonly viewportHeight?: number;
	};
	lines: string[];
	document?: { childLines?: ChildLines };
}

function findTranscript(tui: unknown): TranscriptView | undefined {
	const anyTui = tui as Record<string, any>;
	const frame = anyTui.currentLayout;
	if (!frame?.root) return undefined;
	const scrollView = frame.primaryScrollView ?? anyTui.getPrimaryScrollView?.();
	if (!scrollView) return undefined;
	const stack: any[] = [frame.root];
	while (stack.length > 0) {
		const box = stack.pop();
		if (!box) continue;
		if (box.scrollView === scrollView && Array.isArray(box.scrollContentLines)) {
			const document = (box.children?.[0]?.component ?? scrollView.child) as TranscriptView["document"];
			return { scrollView, lines: box.scrollContentLines, document };
		}
		if (Array.isArray(box.children)) stack.push(...box.children);
	}
	return undefined;
}

/**
 * Rendered rows of every user message (first text row) and assistant message
 * (first white text row), in document order.
 *
 * `Container.childLines` keeps the rendered lines of each direct child, so the
 * offsets are exact without injecting anything into the transcript.
 */
function collectAnchors(transcript: TranscriptView): Anchor[] {
	const anchors: Anchor[] = [];
	const visit = (container: unknown, baseRow: number): void => {
		const layout = (container as { childLines?: ChildLines } | undefined)?.childLines;
		if (!layout?.children || !Array.isArray(layout.parts)) return;
		const width = typeof layout.width === "number" ? layout.width : 0;
		let row = baseRow;
		for (let i = 0; i < layout.children.length; i++) {
			const child = layout.children[i];
			const height = layout.parts[i]?.length ?? 0;
			if (child instanceof UserMessageComponent) {
				// The message starts with one row of Markdown top padding.
				anchors.push({ row: row + 1, component: child, offset: 1 });
			} else if (child instanceof AssistantMessageComponent) {
				const offset = firstTextLineOffset(child as unknown as AssistantRuntime, width);
				if (offset !== undefined) anchors.push({ row: row + offset, component: child, offset });
			} else if ((child as { childLines?: ChildLines })?.childLines) {
				visit(child, row);
			}
			row += height;
		}
	};
	if (transcript.document) visit(transcript.document, 0);
	return anchors;
}

/**
 * Landing row for a jump. Only the viewport size matters: large screens get one
 * third of the viewport as context, small screens leave max(2, height/8) rows.
 * A long message is still anchored the same way; the user can scroll.
 */
function landingRow(scrollView: TranscriptView["scrollView"], row: number): number {
	const viewportHeight = typeof scrollView.viewportHeight === "number" ? scrollView.viewportHeight : 0;
	const third = Math.floor(viewportHeight * CONTEXT_FRACTION);
	const offset =
		third >= MIN_CONTEXT_ROWS ? third : Math.max(MIN_SMALL_CONTEXT_ROWS, Math.floor(viewportHeight / SMALL_CONTEXT_DIVISOR));
	return Math.max(0, row - offset);
}

function jumpToAnchor(tui: unknown, direction: -1 | 1): boolean {
	const state = getState();
	const transcript = findTranscript(tui);
	if (!transcript) return false;
	const anchors = collectAnchors(transcript);
	if (anchors.length === 0) return false;
	const top = transcript.scrollView.scrollTop;
	const stored = state.anchorIndex;
	const storedValid =
		stored !== undefined && stored >= 0 && stored < anchors.length && state.anchorScrollTop === top;

	let targetIndex: number | undefined;
	if (storedValid) {
		// Chained navigation: use the anchor itself, not the viewport top. The
		// landing offset puts the viewport above the current anchor, so looking
		// only at rows < top would skip the message that was just reached.
		targetIndex = direction < 0 ? stored - 1 : stored + 1;
		if (targetIndex < 0 || targetIndex >= anchors.length) return false;
	} else if (direction < 0) {
		for (let i = anchors.length - 1; i >= 0; i--) {
			const anchor = anchors[i];
			if (anchor && anchor.row < top) {
				targetIndex = i;
				break;
			}
		}
	} else {
		for (let i = 0; i < anchors.length; i++) {
			const anchor = anchors[i];
			if (anchor && anchor.row > top) {
				targetIndex = i;
				break;
			}
		}
	}

	if (targetIndex === undefined) return false;
	const target = anchors[targetIndex];
	if (!target) return false;
	// Browsing: never re-enter follow mode just because the target is the last
	// row. The chip row stays visible and new output does not yank the viewport.
	transcript.scrollView.scrollTo(landingRow(transcript.scrollView, target.row), {
		disableFollow: true,
	});
	state.anchorIndex = targetIndex;
	state.anchorScrollTop = transcript.scrollView.scrollTop;
	startAnchorFlash(state, target);
	(tui as { requestRender?: () => void }).requestRender?.();
	return true;
}

// ---------------------------------------------------------------------------
// Focus flash
// ---------------------------------------------------------------------------

/** Red band over the landing row for a short moment. */
function flashAnchorLine(lines: string[], offset: number, width: number, state: PatchState): void {
	if (offset < 0 || offset >= lines.length) return;
	const line = lines[offset] ?? "";
	if (line.includes("\x1b_G") || line.includes("\x1b]1337;File=")) return;
	const plain = truncateToWidth(stripTerminalSequences(line), width, "");
	const padded = plain + " ".repeat(Math.max(0, width - visibleWidth(plain)));
	const theme = state.theme;
	try {
		// `error` is a foreground token; `bg("error")` throws. Use the concrete
		// color in a style so it works in either slot.
		lines[offset] = theme ? theme.style(padded, { bg: theme.colors.error, fg: "text" }) : padded;
	} catch {
		lines[offset] = padded;
	}
}

function clearAnchorFlash(state: PatchState): void {
	if (state.focusTimer) clearTimeout(state.focusTimer);
	state.focusTimer = undefined;
	state.focus = undefined;
}

function startAnchorFlash(state: PatchState, anchor: Anchor): void {
	clearAnchorFlash(state);
	const focus = { component: anchor.component, offset: anchor.offset, visible: true };
	state.focus = focus;
	const render = () => (state.tui as { requestRender?: () => void } | undefined)?.requestRender?.();
	// Two pulses: on -> off -> on -> off.
	const steps: Array<{ visible: boolean; ms: number }> = [
		{ visible: true, ms: 170 },
		{ visible: false, ms: 130 },
		{ visible: true, ms: 170 },
		{ visible: false, ms: 0 },
	];
	let index = 0;
	const tick = (): void => {
		if (state.focus !== focus) return; // cleared or replaced by a newer jump
		const step = steps[index++];
		if (!step) {
			state.focus = undefined;
			state.focusTimer = undefined;
			render();
			return;
		}
		focus.visible = step.visible;
		render();
		if (step.ms > 0) {
			state.focusTimer = setTimeout(tick, step.ms);
			state.focusTimer.unref?.();
		} else {
			state.focus = undefined;
			state.focusTimer = undefined;
			render();
		}
	};
	tick();
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

function installPatches(state: PatchState): void {
	if (state.patched) return;

	const userRender = UserMessageComponent.prototype.render;
	UserMessageComponent.prototype.render = function (this: UserMessageComponent, width: number): string[] {
		const original = userRender.call(this, width);
		if (state.focus?.component !== this || !state.focus.visible) return original;
		const lines = [...original];
		flashAnchorLine(lines, state.focus.offset, width, state);
		return lines;
	};

	const assistantRender = assistantProto.render;
	assistantProto.render = function (this: AssistantMessageComponent, width: number): string[] {
		const runtime = this as unknown as AssistantRuntime;
		state.compactThinking = runtime.hideThinkingBlock === true;
		const original = assistantRender.call(this, width);
		const focused = state.focus?.component === this && state.focus.visible;
		if (!focused && (!state.compactThinking || !runtime.lastMessage?.content)) return original;
		// Container.render reuses its array across frames; copy before modifying.
		const lines = [...original];
		if (state.compactThinking && runtime.lastMessage?.content) {
			registerThinkingGroup(state, runtime, runtime.lastMessage.content, lines, width);
		}
		if (focused) flashAnchorLine(lines, state.focus?.offset ?? 0, width, state);
		return lines;
	};

	// Expanding a thinking group grows the transcript. If the viewport was
	// following the end, the ScrollView would snap to the new bottom and show
	// the end of the thinking. Pinning scrollTop with follow disabled keeps the
	// preview row in place so the expanded text starts where it was clicked.
	const assistantHandleMouse = assistantProto.handleMouse;
	assistantProto.handleMouse = function (this: AssistantMessageComponent, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const result = assistantHandleMouse?.call(this, event);
		if (result?.handled && state.compactThinking && state.tui) {
			const transcript = findTranscript(state.tui);
			if (transcript) transcript.scrollView.scrollTo(transcript.scrollView.scrollTop, { disableFollow: true });
		}
		return result;
	};

	// Retarget Pi's prompt jumping at message anchors instead of OSC markers.
	const scrollToPrompt = altScreenProto.scrollToPrompt;
	altScreenProto.scrollToPrompt = function (this: TuiAltScreen, direction: number): void {
		if ((direction === -1 || direction === 1) && jumpToAnchor(this, direction)) return;
		scrollToPrompt.call(this, direction);
	};

	// Hide the built-in "↓ Jump to latest message" chip; the chip row renders
	// its own "Latest" button on the same line as Prev/Next.
	const compositeIndicator = altScreenProto.compositeScrollToEndIndicator;
	altScreenProto.compositeScrollToEndIndicator = function (this: TuiAltScreen, screen: string[]): string[] {
		(this as unknown as { scrollToEndIndicatorRect?: unknown }).scrollToEndIndicatorRect = undefined;
		return screen;
	};

	// ctrl+t toggles Pi's hideThinkingBlock; mirror it so groups can collapse.
	const updateThinkingVisibility = interactiveProto.updateThinkingBlockVisibility;
	interactiveProto.updateThinkingBlockVisibility = function (this: { hideThinkingBlock?: boolean }): void {
		state.compactThinking = this.hideThinkingBlock === true;
		updateThinkingVisibility.call(this);
	};

	// Group members vanish while their thinking run is collapsed. The group
	// header is the native thinking label line, so clicking it expands both the
	// thinking and the tools (results still follow ctrl+o once visible).
	// Tools without a thinking group compact to their call row (result hidden).
	// Group members keep native display; the render wrapper below hides them
	// entirely while their thinking is collapsed.
	const toolUpdateDisplay = toolProto.updateDisplay;
	toolProto.updateDisplay = function (this: ToolRuntime): void {
		toolUpdateDisplay.call(this);
		if (!state.compactThinking) return;
		const group = this.toolCallId ? state.groups.get(this.toolCallId) : undefined;
		if (group) return;
		if (!this.expanded) collapseCompactResult(this);
	};

	const toolRender = toolProto.render;
	toolProto.render = function (this: ToolRuntime, width: number): string[] {
		const group = this.toolCallId ? state.groups.get(this.toolCallId) : undefined;
		const inGroup = Boolean(group);
		const groupHidden = Boolean(group && isThinkingHidden(group.assistant, group.runIndex));
		if (this.compactState !== state.compactThinking || this.inGroup !== inGroup || this.groupHidden !== groupHidden) {
			const enteringCompact = state.compactThinking && this.compactState !== true;
			this.compactState = state.compactThinking;
			this.inGroup = inGroup;
			this.groupHidden = groupHidden;
			// ctrl+t folds no-thinking tools even if ctrl+o had expanded them.
			if (enteringCompact && !inGroup) this.expanded = false;
			toolProto.updateDisplay.call(this);
		}
		if (state.compactThinking && groupHidden) return [];
		return toolRender.call(this, width);
	};

	state.originals = {
		userRender,
		assistantRender,
		assistantHandleMouse,
		scrollToPrompt,
		compositeIndicator,
		updateThinkingVisibility,
		toolRender,
		toolUpdateDisplay,
	};
	state.patched = true;
}

function removePatches(state: PatchState): void {
	const originals = state.originals;
	if (!state.patched || !originals) return;
	UserMessageComponent.prototype.render = originals.userRender;
	assistantProto.render = originals.assistantRender;
	if (originals.assistantHandleMouse) assistantProto.handleMouse = originals.assistantHandleMouse;
	else delete assistantProto.handleMouse;
	altScreenProto.scrollToPrompt = originals.scrollToPrompt;
	altScreenProto.compositeScrollToEndIndicator = originals.compositeIndicator;
	interactiveProto.updateThinkingBlockVisibility = originals.updateThinkingVisibility;
	toolProto.render = originals.toolRender;
	toolProto.updateDisplay = originals.toolUpdateDisplay;
	state.originals = undefined;
	state.patched = false;
	state.compactThinking = false;
	state.groups.clear();
	clearAnchorFlash(state);
	state.anchorIndex = undefined;
	state.anchorScrollTop = undefined;
}

// ---------------------------------------------------------------------------
// Chip row
// ---------------------------------------------------------------------------

function shortcutFor(keybinding: "tui.altScreen.previousPrompt" | "tui.altScreen.nextPrompt" | "tui.altScreen.bottom"): string[] {
	try {
		return getKeybindings().getKeys(keybinding);
	} catch {
		return [];
	}
}

interface ChipHit {
	start: number;
	end: number;
	action: () => void;
}

class NavigationChips implements Component {
	private cachedWidth: number | undefined;
	private cachedLine: string | undefined;
	private hits: ChipHit[] = [];

	constructor(
		private readonly tui: unknown,
		private readonly theme: Theme,
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLine = undefined;
	}

	render(width: number): string[] {
		if (!this.shouldShow()) {
			this.hits = [];
			this.cachedLine = undefined;
			return [];
		}
		if (this.cachedLine !== undefined && this.cachedWidth === width) return [this.cachedLine];

		const buttons = [
			{
				label: ` ↑ Prev${this.keyHint("tui.altScreen.previousPrompt", "ctrl+up")} `,
				action: () => jumpToAnchor(this.tui, -1),
			},
			{
				label: ` ↓ Next${this.keyHint("tui.altScreen.nextPrompt", "ctrl+down")} `,
				action: () => jumpToAnchor(this.tui, 1),
			},
			{
				label: ` ↓ Latest${this.keyHint("tui.altScreen.bottom", "ctrl+end")} `,
				action: () => this.jumpToLatest(),
			},
		];

		const gap = "   ";
		const widths = buttons.map((button) => visibleWidth(button.label));
		const total = widths.reduce((sum, w) => sum + w, gap.length * (buttons.length - 1));
		const start = Math.max(Math.floor((width - total) / 2), 0);

		const parts: string[] = [];
		const hits: ChipHit[] = [];
		let x = start;
		buttons.forEach((button, index) => {
			if (index > 0) x += gap.length;
			hits.push({ start: x, end: x + (widths[index] ?? 0), action: button.action });
			parts.push(this.theme.bg("selectedBg", this.theme.fg("text", button.label)));
			x += widths[index] ?? 0;
		});

		this.cachedWidth = width;
		this.cachedLine = truncateToWidth(" ".repeat(start) + parts.join(gap), width, "");
		this.hits = hits;
		return [this.cachedLine];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (this.cachedLine === undefined) return undefined;
		const hit = this.hits.find(({ start, end }) => event.x >= start && event.x < end);
		if (!hit) return undefined;
		hit.action();
		return { handled: true };
	}

	private keyHint(keybinding: "tui.altScreen.previousPrompt" | "tui.altScreen.nextPrompt" | "tui.altScreen.bottom", preferred: string): string {
		const keys = shortcutFor(keybinding);
		if (keys.length === 0) return "";
		const key = keys.includes(preferred) ? preferred : (keys[keys.length - 1] ?? "");
		return key ? ` · ${key}` : "";
	}

	private jumpToLatest(): void {
		const anyTui = this.tui as { scrollToBottom?: () => void; requestRender?: () => void };
		if (typeof anyTui.scrollToBottom === "function") {
			anyTui.scrollToBottom();
			return;
		}
		const transcript = findTranscript(this.tui);
		transcript?.scrollView.scrollToEnd?.();
		anyTui.requestRender?.();
	}

	/** Hidden while the transcript follows new output. */
	private shouldShow(): boolean {
		const view = this.tui as { mode?: string; isFollowingOutput?: boolean; currentLayout?: unknown };
		if (view.mode !== "fullscreen") return false;
		if (!view.currentLayout) return false; // before the first layout pass
		return view.isFollowingOutput === false;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function messageNavigatorExtension(pi: ExtensionAPI) {
	const state = getState();
	installPatches(state);

	// Unpatch before /reload so removing the extension really removes its
	// behavior; the reloaded instance patches again when it is still installed.
	pi.on("session_shutdown", () => removePatches(state));

	pi.on("session_start", (_event, ctx) => {
		state.groups.clear();
		state.compactThinking = false;
		clearAnchorFlash(state);
		state.anchorIndex = undefined;
		state.anchorScrollTop = undefined;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		// Stable proxy: reflects later /theme changes automatically.
		state.theme = ctx.ui.theme;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				state.tui = tui;
				return new NavigationChips(tui, theme);
			},
			{ placement: WIDGET_PLACEMENT },
		);
	});
}
