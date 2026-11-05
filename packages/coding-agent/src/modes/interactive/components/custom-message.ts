import type { TextContent } from "@earendil-works/pi-ai";
import { Box, Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer, MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { TimestampComponent } from "./timestamp.ts";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageId?: string;
	private timestamp?: string;
	private outputPadY: 0 | 1;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
		outputPadY: 0 | 1 = 1,
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.outputPadY = outputPadY;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad !== outputPad) {
			this.outputPad = outputPad;
			this.rebuild();
		}
	}

	setOutputPadY(outputPadY: 0 | 1): void {
		if (this.outputPadY !== outputPadY) {
			this.outputPadY = outputPadY;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(this.outputPadY));

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: this._expanded, outputPad: this.outputPad, outputPadY: this.outputPadY, keyText, keyHint },
					theme,
				);
				if (component) {
					// Custom renderer provides its own styled component
					const content = new TimestampComponent(this.message.timestamp, this.outputPad);
					this.addChild(content);
					content.addChild(
						new MouseRegion(component, (event) => {
							if (event.type !== "click" || event.button !== "left") return undefined;
							this.setExpanded(!this._expanded);
							return { handled: true };
						}),
					);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering uses our box
		const box = new Box(this.outputPad, this.outputPadY, (text) => theme.bg("customMessageBg", text));
		this.addChild(box);

		const content = new TimestampComponent(this.message.timestamp, 0, undefined, "customMessageBg");
		box.addChild(content);

		// Default rendering: label + content
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		content.addChild(new Text(label, 0, 0));
		content.addChild(new Spacer(this.outputPadY));

		// Extract text content
		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		content.addChild(
			new Markdown(
				text,
				0,
				0,
				this.markdownTheme,
				{ color: (text: string) => theme.fg("customMessageText", text) },
				{
					transform: createMarkdownTransform(
						"custom",
						() => false,
						this.markdownTransformers,
						this.messageId,
						this.timestamp,
					),
				},
			),
		);
	}
}
