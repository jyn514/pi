import { type Component, Container, MouseRegion, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeStyle, theme } from "../theme/theme.ts";
import { type TranscriptUnit, transcriptUnitPreview } from "../transcript-history.ts";

/** A cheap heading owns its optional body. Closing never discards an already constructed body. */
export class HistoricalEntryComponent extends Container {
	private expanded = false;
	private body: Component | undefined;
	private attempted = false;
	private readonly createBody: () => Component;
	private readonly onError: (error: unknown) => void;
	private readonly requestRender: () => void;
	private readonly heading: Component;
	private readonly prompt: boolean;

	constructor(
		unit: TranscriptUnit,
		createBody: () => Component,
		onError: (error: unknown) => void,
		requestRender: () => void,
	) {
		super();
		const plainLabel = transcriptUnitPreview(unit)
			.slice(0, 160)
			.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
		const failed = unit.failed;
		const prompt = unit.kind === "message" && (unit.message.role === "user" || unit.message.role === "assistant");
		let style: ThemeStyle = {};
		if (unit.kind === "tool") {
			style = {
				fg: "toolTitle",
				bg: failed ? "toolErrorBg" : unit.result ? "toolSuccessBg" : "toolPendingBg",
				bold: true,
			};
		} else if (unit.kind === "custom") {
			style = { fg: "customMessageLabel", bg: "customMessageBg", bold: true };
		} else if (unit.kind === "usage") {
			style = { fg: "dim" };
		} else {
			switch (unit.message.role) {
				case "user":
					style = { fg: "userMessageText", bg: "userMessageBg" };
					break;
				case "assistant":
					if (!unit.message.content.some((block) => block.type === "text" && block.text.trim()))
						style = { fg: "thinkingText", italic: true };
					break;
				case "bashExecution":
					style = { fg: unit.message.excludeFromContext ? "dim" : "bashMode", bold: true };
					break;
				case "custom":
				case "compactionSummary":
				case "branchSummary":
					style = { fg: "customMessageLabel", bg: "customMessageBg", bold: true };
					break;
			}
		}
		if (failed) style.fg = "error";
		this.prompt = prompt;
		this.createBody = createBody;
		this.onError = onError;
		this.requestRender = requestRender;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		this.heading = new MouseRegion(
			{
				render: (width) => {
					if (cachedLines && cachedWidth === width) return cachedLines;
					let text = truncateToWidth(
						` ${this.expanded ? "▾" : "▸"} ${failed ? "[failed/aborted] " : ""}${plainLabel}`,
						width,
					);
					if (style.bg) text += " ".repeat(Math.max(0, width - visibleWidth(text)));
					cachedWidth = width;
					cachedLines = [
						(prompt ? "\x1b]133;A\x07" : "") +
							theme.style(text, style) +
							(prompt ? "\x1b]133;B\x07\x1b]133;C\x07" : ""),
					];
					return cachedLines;
				},
				invalidate: () => {
					cachedWidth = undefined;
					cachedLines = undefined;
				},
			},
			(event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			},
		);
		this.addChild(this.heading);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.prompt && this.expanded) {
			// The heading owns this entry's prompt markers; its normal body must not add another stop.
			for (let row = 1; row < lines.length; row++) {
				lines[row] = lines[row]!.replace(/^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/, "");
			}
		}
		return lines;
	}

	setExpanded(expanded: boolean): void {
		if (expanded === this.expanded) return;
		this.expanded = expanded;
		this.heading.invalidate();
		if (expanded && !this.attempted) {
			this.attempted = true;
			try {
				this.body = this.createBody();
			} catch (error) {
				this.onError(error);
			}
		}
		this.clear();
		this.addChild(this.heading);
		if (expanded && this.body) this.addChild(this.body);
		this.requestRender();
	}
}
