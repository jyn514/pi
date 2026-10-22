import { Container, Spacer } from "@earendil-works/pi-tui";
import { ThemedText } from "./themed-text.ts";

/** Retains completed cache diagnostics while hidden, including their optional leading gap. */
export class CacheNoticeComponent extends Container {
	private readonly spacer: Spacer;
	private readonly isVisible: () => boolean;

	constructor(isVisible: () => boolean, build: () => string, outputPadY: 0 | 1 = 1) {
		super();
		this.isVisible = isVisible;
		this.spacer = new Spacer(outputPadY);
		this.addChild(this.spacer);
		this.addChild(new ThemedText(build, 1, 0));
	}

	setOutputPadY(outputPadY: 0 | 1): void {
		this.spacer.setLines(outputPadY);
	}

	override render(width: number): string[] {
		return this.isVisible() ? super.render(width) : [];
	}
}
