import { Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { TimestampComponent } from "./timestamp.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private outputPadY: 0 | 1;
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageId?: string;
	private timestamp?: string;
	private clockTimestamp: string | number | undefined;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		outputPadY: 0 | 1 = 1,
		messageId?: string,
		timestamp?: string,
		clockTimestamp: string | number | undefined = timestamp,
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.outputPadY = outputPadY;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.clockTimestamp = clockTimestamp;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	setOutputPadY(padding: 0 | 1): void {
		this.outputPadY = padding;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const content = new TimestampComponent(
			this.clockTimestamp,
			this.outputPad,
			(text) => theme.bg("userMessageBg", text),
			"userMessageBg",
		);
		this.addChild(content);
		// The Markdown pads and colors its own background: a Box around it would keep a second full-width copy of every
		// line, with identical output.
		content.addChild(
			new Markdown(
				this.text,
				this.outputPad,
				this.outputPadY,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
					bgColor: (content: string) => theme.bg("userMessageBg", content),
				},
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform(
						"user",
						() => false,
						this.markdownTransformers,
						this.messageId,
						this.timestamp,
					),
				},
			),
		);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
