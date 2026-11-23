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
 * block of an assistant message. Short targets land one third down the
 * viewport; long targets and small viewports keep the anchor at the top.
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

/** When a block fits, its anchor lands this fraction down the viewport. */
const CONTEXT_FRACTION = 1 / 3;
/** Below this many rows of breathing room, top-align instead (small windows/phones). */
const MIN_CONTEXT_ROWS = 6;

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

/** Tool rendering hook: group members hide while their thinking is collapsed. */
interface ToolRuntime {
	toolCallId?: string;
}
type ToolRenderFn = (this: ToolRuntime, width: number) => string[];

interface ThinkingGroup {
	assistant: AssistantRuntime;
	runIndex: number;
}

interface PatchState {
	patched: boolean;
	/** True while thinking blocks are hidden; thinking+tool groups collapse. */
	compactThinking: boolean;
	/** toolCallId -> thinking group that owns it. */
	groups: Map<string, ThinkingGroup>;
	/** Stable theme proxy from ctx.ui.theme; used for the preview line. */
	theme?: Theme;
	originals?: {
		assistantRender: typeof AssistantMessageComponent.prototype.render;
		scrollToPrompt: ScrollToPromptFn;
		compositeIndicator: CompositeIndicatorFn;
		updateThinkingVisibility: UpdateThinkingVisibilityFn;
		toolRender: ToolRenderFn;
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
	const prefix = "▸ ";
	const indent = " ".repeat(Math.max(0, component.outputPad ?? 0));
	const available = Math.max(12, width - indent.length - prefix.length);
	const preview = truncateToWidth(plain, available, "…");
	const text = `${prefix}${preview}`;
	const styled = state.theme ? state.theme.italic(state.theme.fg("thinkingText", text)) : text;
	return indent + styled;
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
		scrollTo(row: number): void;
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
function collectAnchors(transcript: TranscriptView): number[] {
	const anchors: number[] = [];
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
				anchors.push(row + 1);
			} else if (child instanceof AssistantMessageComponent) {
				const offset = firstTextLineOffset(child as unknown as AssistantRuntime, width);
				if (offset !== undefined) anchors.push(row + offset);
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
 * Landing row for a jump. Short blocks get one third of the viewport of
 * context above them; long blocks and small viewports keep the anchor on top.
 */
function landingRow(scrollView: TranscriptView["scrollView"], lines: string[], anchors: number[], row: number): number {
	const viewportHeight = typeof scrollView.viewportHeight === "number" ? scrollView.viewportHeight : 0;
	const contextRows = Math.floor(viewportHeight * CONTEXT_FRACTION);
	if (contextRows < MIN_CONTEXT_ROWS) return row;
	const next = anchors.find((anchor) => anchor > row) ?? lines.length;
	const blockHeight = next - row;
	if (blockHeight > viewportHeight - contextRows) return row;
	return Math.max(0, row - contextRows);
}

function jumpToAnchor(tui: unknown, direction: -1 | 1): boolean {
	const transcript = findTranscript(tui);
	if (!transcript) return false;
	const anchors = collectAnchors(transcript);
	if (anchors.length === 0) return false;
	const top = transcript.scrollView.scrollTop;
	let row: number | undefined;
	if (direction < 0) {
		for (let i = anchors.length - 1; i >= 0; i--) {
			if ((anchors[i] ?? 0) < top) {
				row = anchors[i];
				break;
			}
		}
	} else {
		for (const anchor of anchors) {
			if (anchor > top) {
				row = anchor;
				break;
			}
		}
	}
	if (row === undefined) return false;
	transcript.scrollView.scrollTo(landingRow(transcript.scrollView, transcript.lines, anchors, row));
	(tui as { requestRender?: () => void }).requestRender?.();
	return true;
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

function installPatches(state: PatchState): void {
	if (state.patched) return;

	const assistantRender = AssistantMessageComponent.prototype.render;
	AssistantMessageComponent.prototype.render = function (this: AssistantMessageComponent, width: number): string[] {
		const runtime = this as unknown as AssistantRuntime;
		state.compactThinking = runtime.hideThinkingBlock === true;
		const original = assistantRender.call(this, width);
		if (!state.compactThinking || !runtime.lastMessage?.content) return original;
		// Container.render reuses its array across frames; copy before replacing
		// the thinking label with the group preview.
		const lines = [...original];
		registerThinkingGroup(state, runtime, runtime.lastMessage.content, lines, width);
		return lines;
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
	const toolRender = ToolExecutionComponent.prototype.render as ToolRenderFn;
	const toolProto = ToolExecutionComponent.prototype as unknown as { render: ToolRenderFn };
	toolProto.render = function (this: ToolRuntime, width: number): string[] {
		if (state.compactThinking && this.toolCallId) {
			const group = state.groups.get(this.toolCallId);
			if (group && isThinkingHidden(group.assistant, group.runIndex)) return [];
		}
		return toolRender.call(this, width);
	};

	state.originals = {
		assistantRender,
		scrollToPrompt,
		compositeIndicator,
		updateThinkingVisibility,
		toolRender,
	};
	state.patched = true;
}

function removePatches(state: PatchState): void {
	const originals = state.originals;
	if (!state.patched || !originals) return;
	AssistantMessageComponent.prototype.render = originals.assistantRender;
	altScreenProto.scrollToPrompt = originals.scrollToPrompt;
	altScreenProto.compositeScrollToEndIndicator = originals.compositeIndicator;
	interactiveProto.updateThinkingBlockVisibility = originals.updateThinkingVisibility;
	(ToolExecutionComponent.prototype as unknown as { render: ToolRenderFn }).render = originals.toolRender;
	state.originals = undefined;
	state.patched = false;
	state.compactThinking = false;
	state.groups.clear();
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
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		// Stable proxy: reflects later /theme changes automatically.
		state.theme = ctx.ui.theme;
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new NavigationChips(tui, theme), { placement: WIDGET_PLACEMENT });
	});
}
