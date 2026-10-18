import { type Component, Container, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const message: CustomMessage = {
	role: "custom",
	customType: "test",
	content: "custom",
	display: true,
	timestamp: 0,
};

function createExpandableMessage(outputPadY: 0 | 1 = 1): CustomMessageComponent {
	return new CustomMessageComponent(
		message,
		(_message, { expanded, outputPad }) => new Text(expanded ? "preview\nhidden details" : "preview", outputPad, 0),
		undefined,
		1,
		outputPadY,
	);
}

function mouseEvent(component: CustomMessageComponent, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	const width = overrides.width ?? 40;
	const lines = component.render(width).map(stripAnsi);
	const y = lines.findIndex((line) => line.includes("preview"));
	return {
		type: "click",
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
		...overrides,
	};
}

describe("CustomMessageComponent", () => {
	beforeAll(() => initTheme("dark"));
	test("provides output padding to custom renderers and updates it", () => {
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1, 1);

		expect(optionsSeen).toEqual([{ expanded: false, outputPad: 1, outputPadY: 1 }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toEqual({ expanded: false, outputPad: 0, outputPadY: 1 });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);

		component.setOutputPadY(0);
		expect(optionsSeen.at(-1)).toEqual({ expanded: false, outputPad: 0, outputPadY: 0 });
		expect(component.render(40)).toHaveLength(1);
	});

	test.each([0, 1] as const)(
		"toggles details on clicks with vertical padding %s and resized content",
		(outputPadY) => {
			const component = createExpandableMessage(outputPadY);
			expect(stripAnsi(component.render(40).join("\n"))).not.toContain("hidden details");

			expect(component.handleMouse(mouseEvent(component))?.handled).toBe(true);
			expect(stripAnsi(component.render(40).join("\n"))).toContain("hidden details");

			expect(component.handleMouse(mouseEvent(component, { width: 20 }))?.handled).toBe(true);
			expect(stripAnsi(component.render(20).join("\n"))).not.toContain("hidden details");
		},
	);

	test("lets a renderer's child handle the click without toggling host expansion", () => {
		const onMouse = vi.fn(() => ({ handled: true, focus: true, capture: true, render: false }));
		const child: Component = {
			render: () => ["preview button"],
			invalidate: () => {},
			handleMouse: onMouse,
		};
		const renderer: MessageRenderer = (_message, { expanded }) => {
			const content = new Container();
			content.addChild(child);
			content.addChild(new Text(expanded ? "hidden details" : "summary", 0, 0));
			return content;
		};
		const component = new CustomMessageComponent(message, renderer);
		const result = component.handleMouse(mouseEvent(component));

		expect(onMouse).toHaveBeenCalledOnce();
		expect(stripAnsi(component.render(40).join("\n"))).not.toContain("hidden details");
		expect(result).toMatchObject({ handled: true, focus: true, capture: true, render: false });
		expect(result?.target.component).toBe(child);
		expect(result?.focusTarget).toBe(child);
	});

	test.each([
		{ type: "click", button: "right" },
		{ type: "click", button: "middle" },
		{ type: "press", button: "left" },
		{ type: "release", button: "left" },
		{ type: "move", button: "none" },
		{ type: "drag", button: "left" },
		{ type: "wheel", button: "none" },
	] as const)("does not toggle or consume an unhandled $button $type", (event) => {
		const component = createExpandableMessage();
		expect(component.handleMouse(mouseEvent(component, event))).toBeUndefined();
		expect(stripAnsi(component.render(40).join("\n"))).not.toContain("hidden details");
	});

	test("does not toggle when the outer spacer is clicked", () => {
		const component = createExpandableMessage();
		expect(component.handleMouse(mouseEvent(component, { y: 0, screenY: 0 }))).toBeUndefined();
		expect(stripAnsi(component.render(40).join("\n"))).not.toContain("hidden details");
	});

	test("shares expansion state between the setter and clicks across rebuilds", () => {
		const component = createExpandableMessage();
		component.setExpanded(true);
		expect(stripAnsi(component.render(40).join("\n"))).toContain("hidden details");
		component.handleMouse(mouseEvent(component));
		expect(stripAnsi(component.render(40).join("\n"))).not.toContain("hidden details");

		component.setExpanded(false);
		component.handleMouse(mouseEvent(component));
		component.setOutputPad(3);
		component.setOutputPadY(0);
		component.invalidate();
		expect(stripAnsi(component.render(40).join("\n"))).toContain("hidden details");

		component.setExpanded(false);
		expect(stripAnsi(component.render(40).join("\n"))).not.toContain("hidden details");
		component.handleMouse(mouseEvent(component));
		expect(stripAnsi(component.render(40).join("\n"))).toContain("hidden details");
	});

	test.each([
		{ name: "absent", renderer: undefined },
		{ name: "returning undefined", renderer: () => undefined },
		{
			name: "throwing",
			renderer: () => {
				throw new Error("renderer failed");
			},
		},
	])("keeps full Markdown fallback when the renderer is $name", ({ renderer }) => {
		const component = new CustomMessageComponent({ ...message, content: "preview\nhidden details" }, renderer);
		const before = component.render(40);
		expect(stripAnsi(before.join("\n"))).toContain("hidden details");
		expect(component.handleMouse(mouseEvent(component))).toBeUndefined();
		expect(component.render(40)).toEqual(before);
	});
});
