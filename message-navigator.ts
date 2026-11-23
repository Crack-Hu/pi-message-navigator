/**
 * Previous-message navigation for Pi fullscreen mode.
 *
 * Pi's transcript marks user prompts and *final* assistant messages with OSC 133
 * prompt markers. Assistant messages that call tools have no marker, so
 * `tui.altScreen.previousPrompt` lands at the end of the tool-call section
 * instead of at the start of the text the model actually wrote.
 *
 * This extension renders visible label lines as scroll anchors:
 *
 *   ▌ user message:        before every user message
 *   ▌ assistant message:   before the first white text block of every
 *                          assistant message (thinking and tool output are
 *                          grey and get no label)
 *
 * Each label is a colored header line preceded by one blank row. Labels are
 * display-only: no message, session entry, or model context is touched.
 *
 * The extension retargets Pi's own `previousPrompt` / `nextPrompt` transcript
 * scrolling to those labels, so ctrl+up / ctrl+down walk block by block
 * regardless of whether the block belongs to the user or the assistant, and
 * adds two clickable chips above the editor ("Prev" and "Next").
 *
 * Fullscreen only: in regular mode the terminal owns the scrollback.
 */

import {
	AssistantMessageComponent,
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

/** The marker Pi prepends to user messages and marker-enabled assistant messages. */
const PROMPT_START = "\x1b]133;A\x07";
/** Visible anchors rendered at block starts. Change the text here if you like. */
const LABEL_PROMPT = "▌ user message:";
const LABEL_REPLY = "▌ assistant message:";

type LineMatcher = (line: string) => boolean;

/**
 * The label text is wrapped in theme ANSI codes, so compare after stripping
 * terminal sequences. The cheap `includes` check rejects most lines first.
 */
function startsWithLabel(line: string, label: string): boolean {
	if (!line.includes(label)) return false;
	return stripTerminalSequences(line).startsWith(label);
}

const isReplyStart: LineMatcher = (line) => startsWithLabel(line, LABEL_REPLY);
const isPromptStart: LineMatcher = (line) => startsWithLabel(line, LABEL_PROMPT);
const isBlockStart: LineMatcher = (line) => isReplyStart(line) || isPromptStart(line);

// ---------------------------------------------------------------------------
// Shared state (survives /reload: the prototypes stay patched in-process)
// ---------------------------------------------------------------------------

/** `scrollToPrompt` is TS-private in pi-tui but a normal prototype method at runtime. */
type ScrollToPromptFn = (this: TuiAltScreen, direction: number) => void;
const altScreenProto = TuiAltScreen.prototype as unknown as { scrollToPrompt: ScrollToPromptFn };

interface PatchState {
	patched: boolean;
	/** Stable theme proxy from ctx.ui.theme; used to color the labels. */
	theme?: Theme;
	originals?: {
		userRender: typeof UserMessageComponent.prototype.render;
		assistantRender: typeof AssistantMessageComponent.prototype.render;
		scrollToPrompt: ScrollToPromptFn;
	};
}

const STATE_KEY = Symbol.for("pi.message-navigator.state");

function getState(): PatchState {
	const holder = globalThis as unknown as Record<symbol, PatchState | undefined>;
	let state = holder[STATE_KEY];
	if (!state) {
		state = { patched: false };
		holder[STATE_KEY] = state;
	}
	return state;
}

// ---------------------------------------------------------------------------
// Transcript access (duck-typed: TuiAltScreen keeps these private in TS)
// ---------------------------------------------------------------------------

interface TranscriptView {
	scrollView: { scrollTop: number; scrollTo(row: number): void };
	lines: string[];
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
			return { scrollView, lines: box.scrollContentLines };
		}
		if (Array.isArray(box.children)) stack.push(...box.children);
	}
	return undefined;
}

/** Nearest matching row strictly above/below the current viewport top. */
function jumpToMatchingRow(tui: unknown, direction: -1 | 1, matches: LineMatcher): boolean {
	const transcript = findTranscript(tui);
	if (!transcript) return false;
	const { scrollView, lines } = transcript;
	for (let row = scrollView.scrollTop + direction; row >= 0 && row < lines.length; row += direction) {
		if (matches(lines[row] ?? "")) {
			scrollView.scrollTo(row);
			(tui as { requestRender?: () => void }).requestRender?.();
			return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Visible labels
// ---------------------------------------------------------------------------

function isBlankLine(line: string): boolean {
	return stripTerminalSequences(line).trim().length === 0;
}

/** Colored header styling; falls back to plain text before the theme is known. */
function styledLabel(state: PatchState, label: string): string {
	const theme = state.theme;
	if (!theme) return label;
	try {
		return theme.bold(theme.fg("accent", label));
	} catch {
		return label;
	}
}

/**
 * Put the prompt label above the message's top padding row. The padding row
 * stays in place and serves as the blank line below the label.
 */
function labelUserMessage(lines: string[], state: PatchState): void {
	if (lines.length === 0) return;
	const first = lines[0] ?? "";
	// Never touch inline image protocol lines.
	if (first.includes("\x1b_G") || first.includes("\x1b]1337;File=")) return;
	const label = PROMPT_START + styledLabel(state, LABEL_PROMPT);
	if (isBlankLine(first)) {
		lines.unshift(label);
		return;
	}
	lines.unshift(label, "");
}

interface MarkdownChild {
	render(width: number): string[];
}

interface AssistantRuntime {
	markdownSlots?: Array<{ kind?: string; markdown?: MarkdownChild }>;
	contentContainer?: { children?: MarkdownChild[] };
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
 * Insert the reply label right before the text block with one blank row above
 * and one below, so the header stands alone between thinking/tool output and
 * the text.
 */
function labelAssistantText(lines: string[], offset: number, state: PatchState): void {
	if (offset < 0 || offset > lines.length) return;
	const at = lines[offset] ?? "";
	if (at.includes("\x1b_G") || at.includes("\x1b]1337;File=")) return;
	const label = PROMPT_START + styledLabel(state, LABEL_REPLY);
	const hasBlankBefore = offset > 0 && isBlankLine(lines[offset - 1] ?? "");
	lines.splice(offset, 0, ...(hasBlankBefore ? [label, ""] : ["", label, ""]));
}

function installPatches(state: PatchState): void {
	if (state.patched) return;

	const userRender = UserMessageComponent.prototype.render;
	UserMessageComponent.prototype.render = function (this: UserMessageComponent, width: number): string[] {
		const lines = userRender.call(this, width);
		labelUserMessage(lines, state);
		return lines;
	};

	const assistantRender = AssistantMessageComponent.prototype.render;
	AssistantMessageComponent.prototype.render = function (this: AssistantMessageComponent, width: number): string[] {
		const lines = assistantRender.call(this, width);
		const offset = firstTextLineOffset(this as unknown as AssistantRuntime, width);
		if (offset !== undefined) labelAssistantText(lines, offset, state);
		return lines;
	};

	// Retarget Pi's own prompt jumping at the visible labels instead of the OSC
	// markers that only exist on the last assistant message of a turn.
	const scrollToPrompt = altScreenProto.scrollToPrompt;
	altScreenProto.scrollToPrompt = function (this: TuiAltScreen, direction: number): void {
		if ((direction === -1 || direction === 1) && jumpToMatchingRow(this, direction, isBlockStart)) return;
		scrollToPrompt.call(this, direction);
	};

	state.originals = { userRender, assistantRender, scrollToPrompt };
	state.patched = true;
}

function removePatches(state: PatchState): void {
	const originals = state.originals;
	if (!state.patched || !originals) return;
	UserMessageComponent.prototype.render = originals.userRender;
	AssistantMessageComponent.prototype.render = originals.assistantRender;
	altScreenProto.scrollToPrompt = originals.scrollToPrompt;
	state.originals = undefined;
	state.patched = false;
}

// ---------------------------------------------------------------------------
// Chip row
// ---------------------------------------------------------------------------

/** Shortcut hint: prefer the plain binding, else the last configured one. */
function shortcutFor(keybinding: "tui.altScreen.previousPrompt" | "tui.altScreen.nextPrompt", preferred: string): string {
	try {
		const keys = getKeybindings().getKeys(keybinding);
		if (keys.length === 0) return "";
		return keys.find((key) => key === preferred) ?? keys[keys.length - 1] ?? "";
	} catch {
		return "";
	}
}

class NavigationChips implements Component {
	private cachedWidth: number | undefined;
	private cachedLine: string | undefined;
	private prevStart = 0;
	private prevEnd = 0;
	private nextStart = 0;
	private nextEnd = 0;

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
			this.resetHits();
			this.cachedLine = undefined;
			return [];
		}
		if (this.cachedLine !== undefined && this.cachedWidth === width) return [this.cachedLine];

		const prevKey = shortcutFor("tui.altScreen.previousPrompt", "ctrl+up");
		const nextKey = shortcutFor("tui.altScreen.nextPrompt", "ctrl+down");
		const prevLabel = ` ↑ Prev${prevKey ? ` · ${prevKey}` : ""} `;
		const nextLabel = ` ↓ Next${nextKey ? ` · ${nextKey}` : ""} `;
		const gap = "   ";
		const total = visibleWidth(prevLabel) + gap.length + visibleWidth(nextLabel);
		const start = Math.max(0, Math.floor((width - total) / 2));

		const prevAt = start;
		const nextAt = start + visibleWidth(prevLabel) + gap.length;
		const line = truncateToWidth(
			" ".repeat(start) +
				this.theme.bg("selectedBg", this.theme.fg("text", prevLabel)) +
				gap +
				this.theme.bg("selectedBg", this.theme.fg("text", nextLabel)),
			width,
			"",
		);

		this.cachedWidth = width;
		this.cachedLine = line;
		this.prevStart = prevAt;
		this.prevEnd = Math.min(width, prevAt + visibleWidth(prevLabel));
		this.nextStart = nextAt;
		this.nextEnd = Math.min(width, nextAt + visibleWidth(nextLabel));
		return [line];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (this.cachedLine === undefined) return undefined;
		const hit = (from: number, to: number) => event.x >= from && event.x < to;
		if (hit(this.prevStart, this.prevEnd)) {
			jumpToMatchingRow(this.tui, -1, isBlockStart);
			return { handled: true };
		}
		if (hit(this.nextStart, this.nextEnd)) {
			jumpToMatchingRow(this.tui, 1, isBlockStart);
			return { handled: true };
		}
		return undefined;
	}

	private resetHits(): void {
		this.prevStart = 0;
		this.prevEnd = 0;
		this.nextStart = 0;
		this.nextEnd = 0;
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

export default function previousMessageChipExtension(pi: ExtensionAPI) {
	const state = getState();
	installPatches(state);

	// Unpatch before /reload so removing the extension really removes its
	// behavior; the reloaded instance patches again when it is still installed.
	pi.on("session_shutdown", () => removePatches(state));

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		// Stable proxy: reflects later /theme changes automatically.
		state.theme = ctx.ui.theme;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => new NavigationChips(tui, theme),
			{ placement: WIDGET_PLACEMENT },
		);
	});
}
