import {
	type Component,
	Container,
	colorToOkhsl,
	colorToRgb,
	getActiveBackgroundAnsi,
	getBackgroundAtColumn,
	rgbColor,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { terminalAppearance } from "../theme/system-theme.ts";
import { type ThemeBg, type ThemeStyle, theme } from "../theme/theme.ts";

interface TimestampGroup {
	minute?: number;
}

// Component.render() has no context parameter. Keep the transcript's cursor scoped to its synchronous render.
let activeGroup: TimestampGroup | undefined;

/** Render a transcript with a clock only when its visible entries change minute. */
export class TimestampGroupComponent extends Container {
	override render(width: number): string[] {
		const previous = activeGroup;
		activeGroup = {};
		try {
			return super.render(width);
		} finally {
			activeGroup = previous;
		}
	}
}

/** Adds a local HH:mm clock at the top right of its content, without adding a row. */
export class TimestampComponent extends Container {
	private time: string | undefined;
	private minute: number | undefined;
	private clockVisible = true;
	private padding: number;
	private background?: (text: string) => string;
	private backgroundColor?: ThemeBg;
	private cache?: { width: number; content: string[]; lines: string[] };

	constructor(
		timestamp: string | number | undefined,
		padding = 0,
		background?: (text: string) => string,
		backgroundColor?: ThemeBg,
	) {
		super();
		this.padding = padding;
		this.background = background;
		this.backgroundColor = backgroundColor;
		this.setTimestamp(timestamp);
	}

	setTimestamp(timestamp: string | number | undefined): void {
		this.cache = undefined;
		this.time = undefined;
		this.minute = undefined;
		if (timestamp !== undefined) {
			const date = new Date(timestamp);
			this.minute = Math.floor(date.getTime() / 60_000);
			this.time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		}
	}

	/** Describe the host's inherited background without changing it. */
	setBackgroundColor(backgroundColor: ThemeBg | undefined): void {
		if (this.backgroundColor === backgroundColor) return;
		this.backgroundColor = backgroundColor;
		this.cache = undefined;
	}

	setPadding(padding: number): void {
		this.padding = padding;
		this.cache = undefined;
	}

	override invalidate(): void {
		super.invalidate();
		this.cache = undefined;
	}

	private contentWidth(width: number): number {
		const gutter = 5 + Math.max(1, this.padding);
		// At tiny widths, keep the content readable rather than showing a partial clock.
		return !this.clockVisible || this.time === undefined || width <= gutter ? width : width - gutter;
	}

	override render(width: number): string[] {
		const group = activeGroup;
		const previousMinute = group?.minute;
		this.clockVisible = this.minute !== undefined && this.minute !== previousMinute;
		const contentWidth = this.contentWidth(width);
		if (group && contentWidth !== width) group.minute = this.minute;
		let content: string[];
		try {
			content = super.render(contentWidth);
		} catch (error) {
			if (group) group.minute = previousMinute;
			throw error;
		}
		if (content.length === 0) {
			if (group) group.minute = previousMinute;
			return content;
		}
		if (contentWidth === width) return content;
		const cache = this.cache;
		if (
			cache?.width === width &&
			cache.content.length === content.length &&
			content.every((line, index) => line === cache.content[index])
		) {
			return cache.lines;
		}

		const row = Math.max(
			0,
			content.findIndex((line) => stripAnsi(line).trim()),
		);
		const first = content[row];
		const inheritedBackground = this.backgroundColor
			? { ansi: theme.getBgAnsi(this.backgroundColor), color: theme.colors[this.backgroundColor] }
			: getBackgroundAtColumn(first, visibleWidth(first) - 1);
		let foreground: ThemeStyle["fg"] = "dim";
		if (inheritedBackground) {
			const color = inheritedBackground.color;
			const { l, s } = colorToOkhsl(color);
			// Near-neutral panels need contrast; keep the subdued clock on black, white, and colored surfaces.
			if (s < 0.1 && l > 0.05 && l < 0.95) {
				foreground = terminalAppearance(colorToRgb(color)) === "dark" ? rgbColor(255, 255, 255) : rgbColor(0, 0, 0);
			}
		}

		const lines = [...content];
		lines[row] =
			first +
			(inheritedBackground?.ansi ?? "") +
			" ".repeat(Math.max(0, width - this.padding - 5 - visibleWidth(first))) +
			// Clear text attributes only: a reset-all would also discard the inherited background.
			"\x1b[22;23;24;25;27;28;29m" +
			theme.style(this.time!, { fg: foreground }) +
			" ".repeat(this.padding) +
			// Keep host backgrounds active through outer padding; self-rendered rows retain their original final state.
			(inheritedBackground && !this.backgroundColor ? getActiveBackgroundAnsi(first) || "\x1b[49m" : "");
		const background = this.background;
		const result = background
			? lines.map((line) => background(line + " ".repeat(Math.max(0, width - visibleWidth(line)))))
			: lines;
		this.cache = { width, content, lines: result };
		return result;
	}

	override getChildRow(child: Component, width: number): number | undefined {
		return super.getChildRow(child, this.contentWidth(width));
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const width = this.contentWidth(event.width);
		if (event.x >= width) return undefined;
		return super.handleMouse({ ...event, width });
	}
}
