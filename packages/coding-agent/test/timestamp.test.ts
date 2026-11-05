import { type Component, rgbColor, Text, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ToolRenderers } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { TimestampComponent, TimestampGroupComponent } from "../src/modes/interactive/components/timestamp.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, type ThemeBg, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { assistantMsg } from "./utilities.ts";

const time = new Date(2026, 0, 2, 9, 7, 58, 123);
const timestamp = time.getTime();

function textAtWidth(component: Component, width: number): string {
	return stripAnsi(component.render(width).join("\n"));
}

function text(component: Component): string {
	return textAtWidth(component, 80);
}

function clock(value: string | number | undefined, label = "content"): TimestampComponent {
	const component = new TimestampComponent(value);
	component.addChild(new Text(label, 0, 0));
	return component;
}

beforeAll(() => initTheme("dark"));
afterEach(() => initTheme("dark"));

describe("transcript timestamps", () => {
	it("shows only consecutive minute changes on every render, including after resize", () => {
		const group = new TimestampGroupComponent();
		const start = new Date(2026, 0, 2, 9, 7).getTime();
		for (const offset of [0, 1_000, 2_000, 62_000, 70_000, 0]) group.addChild(clock(start + offset));
		for (const width of [80, 30, 80]) {
			expect(textAtWidth(group, width).match(/\d{2}:\d{2}/g)).toEqual(["09:07", "09:08", "09:07"]);
		}
		group.render(5);
		expect(text(group).match(/\d{2}:\d{2}/g)).toEqual(["09:07", "09:08", "09:07"]);
	});

	it("does not let hidden entries or nested repeated clocks consume the first visible clock", () => {
		const group = new TimestampGroupComponent();
		group.addChild(new TimestampComponent(timestamp));
		group.addChild(clock(undefined, "unstamped"));
		const parent = new TimestampComponent(timestamp);
		parent.addChild(clock(timestamp, "nested"));
		group.addChild(parent);
		group.addChild(clock(timestamp));
		expect(text(group).match(/09:07/g)).toHaveLength(1);
		expect(text(group)).toContain("nested");
	});

	it("treats the same clock minute on a different day as a new minute", () => {
		const group = new TimestampGroupComponent();
		group.addChild(clock(timestamp));
		const tomorrow = new Date(time);
		tomorrow.setDate(tomorrow.getDate() + 1);
		group.addChild(clock(tomorrow.getTime()));
		expect(text(group).match(/09:07/g)).toHaveLength(2);
	});

	it("keeps separate transcript renders independent, including after a renderer throws", () => {
		const first = new TimestampGroupComponent();
		first.addChild(clock(timestamp));
		first.addChild({
			render: () => {
				throw new Error("renderer failed");
			},
			invalidate: () => {},
		});
		expect(() => first.render(80)).toThrow("renderer failed");
		const second = new TimestampGroupComponent();
		second.addChild(clock(timestamp));
		expect(text(second)).toContain("09:07");
		expect(text(clock(timestamp))).toContain("09:07");
	});

	it("clears surrounding text attributes without losing the inherited background", async () => {
		const component = clock(timestamp);
		const terminal = new xterm.Terminal({ cols: 80, rows: 4, allowProposedApi: true });
		const line = component.render(80)[0];
		try {
			await new Promise<void>((resolve) =>
				terminal.write(
					`${theme.bg("toolPendingBg", `\x1b[1;3;4;7;9m${line}`)}\x1b[0m\r\n${theme.bg("toolPendingBg", "reference")}`,
					resolve,
				),
			);
			const body = terminal.buffer.active.getLine(0)!.getCell(0)!;
			const clockCell = terminal.buffer.active.getLine(0)!.getCell(75)!;
			const reference = terminal.buffer.active.getLine(1)!.getCell(0)!;
			expect(body.isItalic()).not.toBe(0);
			expect(body.isBold()).not.toBe(0);
			expect(clockCell.isItalic()).toBe(0);
			expect(clockCell.isBold()).toBe(0);
			expect(clockCell.isUnderline()).toBe(0);
			expect(clockCell.isInverse()).toBe(0);
			expect(clockCell.isStrikethrough()).toBe(0);
			expect(clockCell.getBgColorMode()).toBe(reference.getBgColorMode());
			expect(clockCell.getBgColor()).toBe(reference.getBgColor());
		} finally {
			terminal.dispose();
		}
	});

	it.each([time.toISOString(), timestamp])("puts local HH:mm on the content's first row: %s", (value) => {
		const component = new TimestampComponent(value);
		component.addChild(new Text("first row\nsecond row", 0, 0));
		const lines = component.render(30).map(stripAnsi);
		expect(lines).toEqual(["first row                09:07", "second row              "]);
	});

	it("keeps midnight in 24-hour format and leaves absent timestamps unchanged", () => {
		const midnight = new TimestampComponent(new Date(2026, 0, 2, 0, 0).getTime());
		midnight.addChild(new Text("content", 0, 0));
		expect(text(midnight)).toMatch(/^content\s+00:00$/);
		const absent = new TimestampComponent(undefined);
		absent.addChild(new Text("content", 0, 0));
		expect(text(absent).trimEnd()).toBe("content");
	});

	it("wraps content without losing text, and hides the clock when both cannot fit", () => {
		const component = new TimestampComponent(timestamp);
		component.addChild(new Text("abcdefghijklmnop", 0, 0));
		const lines = component.render(12).map(stripAnsi);
		expect(lines[0]).toMatch(/^abcdef 09:07$/);
		expect(
			lines
				.join("")
				.replace(/\s*09:07/, "")
				.replace(/\s/g, ""),
		).toBe("abcdefghijklmnop");
		for (const width of [1, 2, 4, 5, 6, 12, 20, 80]) {
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(component.render(5).join("")).not.toContain("09:07");
	});

	it("keeps the clock inset by the current padding", () => {
		const component = new TimestampComponent(timestamp, 1);
		component.addChild(new Text("content", 0, 0));
		expect(text(component)).toMatch(/^content\s+09:07 $/);
		component.setPadding(0);
		expect(text(component)).toMatch(/^content\s+09:07$/);
	});

	it("does not add a row to padded or compact user messages", () => {
		for (const padding of [0, 1] as const) {
			const plain = new UserMessageComponent("prompt", undefined, 1, [], padding);
			const clocked = new UserMessageComponent("prompt", undefined, 1, [], padding, undefined, time.toISOString());
			const rows = clocked.render(80).map(stripAnsi);
			expect(rows).toHaveLength(plain.render(80).length);
			expect(rows[padding]).toMatch(/^ prompt\s+09:07 $/);
			if (padding) expect(rows[0].trim()).toBe("");
		}
	});

	it("places the clock beside content supplied by a padded extension renderer", () => {
		const component = new TimestampComponent(timestamp);
		component.addChild(new Text("extension output", 1, 1));
		const rows = component.render(80).map(stripAnsi);
		expect(rows).toHaveLength(3);
		expect(rows[0].trim()).toBe("");
		expect(rows[1]).toMatch(/^ extension output\s+09:07$/);
		expect(rows[2].trim()).toBe("");
	});

	it.each([
		["user", () => new UserMessageComponent("prompt", undefined, 0, [], 0, undefined, time.toISOString())],
		["assistant", () => new AssistantMessageComponent({ ...assistantMsg("answer"), timestamp })],
		[
			"custom",
			() =>
				new CustomMessageComponent(
					{ role: "custom", customType: "notice", content: "notice", display: true, timestamp },
					() => new Text("extension output", 0, 0),
				),
		],
		[
			"custom entry",
			() =>
				new CustomEntryComponent(
					{ type: "custom", id: "entry", parentId: null, customType: "notice", timestamp: time.toISOString() },
					() => new Text("entry output", 0, 0),
				),
		],
		[
			"skill",
			() =>
				new SkillInvocationMessageComponent(
					{ name: "skill", location: "/skill.md", content: "instructions", userMessage: undefined },
					undefined,
					0,
					[],
					undefined,
					time.toISOString(),
				),
		],
		[
			"compaction",
			() =>
				new CompactionSummaryMessageComponent({
					role: "compactionSummary",
					summary: "summary",
					tokensBefore: 123,
					timestamp,
				}),
		],
		[
			"branch",
			() =>
				new BranchSummaryMessageComponent({
					role: "branchSummary",
					summary: "summary",
					fromId: "entry",
					timestamp,
				}),
		],
	] satisfies Array<[string, () => Component]>)(
		"shows a clock on %s without changing extension renderers",
		(_name, create) => {
			const component = create();
			expect(text(component).match(/09:07/g)).toHaveLength(1);
			const row = component
				.render(80)
				.map(stripAnsi)
				.find((line) => line.includes("09:07"))!;
			expect(row).toMatch(/\S.*\s09:07\s*$/);
			component.invalidate();
			expect(text(component).match(/09:07/g)).toHaveLength(1);
		},
	);

	it("keeps empty assistant and hidden custom entries invisible", () => {
		const assistant = new AssistantMessageComponent({ ...assistantMsg(""), timestamp });
		expect(assistant.render(80)).toEqual([]);
		const entry = new CustomEntryComponent(
			{ type: "custom", id: "entry", parentId: null, customType: "hidden", timestamp: time.toISOString() },
			() => undefined,
		);
		expect(entry.render(80)).toEqual([]);
	});

	it("replaces a running shell command clock with its recorded result clock", () => {
		const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
		const bash = new BashExecutionComponent("echo output", ui, false, 0, 0, timestamp);
		try {
			expect(text(bash)).toContain("09:07");
			bash.setTimestamp(new Date(2026, 0, 2, 9, 9).getTime());
			bash.setComplete(0, false);
			expect(text(bash)).toContain("09:09");
			expect(text(bash)).not.toContain("09:07");
		} finally {
			bash.setComplete(0, false);
			ui.stop();
		}
	});

	it.each(["dark", "light"] as const)("changes only the clock foreground on grey %s command panels", async (name) => {
		initTheme(name);
		const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
		const terminal = new xterm.Terminal({ cols: 80, rows: 12, allowProposedApi: true });
		const tool = new ToolExecutionComponent(
			"tool",
			"clock",
			{},
			{ timestamp, outputPadY: 0 },
			{
				renderCall: () => new Text("tool call", 0, 0),
			},
			ui,
			"/",
		);
		const states: Array<{ line: string; reference: string }> = [];
		const capture = (background: ThemeBg, foreground: "dim" | "black" | "white") => {
			const line = tool.render(80).find((line) => stripAnsi(line).includes("09:07"))!;
			states.push({
				line,
				reference: theme.style("reference", {
					fg: foreground === "dim" ? "dim" : foreground === "black" ? rgbColor(0, 0, 0) : rgbColor(255, 255, 255),
					bg: background,
				}),
			});
		};
		try {
			capture("toolPendingBg", name === "dark" ? "white" : "black");
			tool.updateResult({ content: [], isError: false });
			capture("toolSuccessBg", "dim");
			tool.updateResult({ content: [], isError: true });
			capture("toolErrorBg", "dim");
			await new Promise<void>((resolve) =>
				terminal.write(states.flatMap(({ line, reference }) => [line, reference]).join("\r\n"), resolve),
			);
			for (let index = 0; index < states.length; index++) {
				const line = terminal.buffer.active.getLine(index * 2)!;
				const clock = line.getCell(stripAnsi(states[index].line).indexOf("09:07"))!;
				const command = line.getCell(1)!;
				const tail = line.getCell(79)!;
				const reference = terminal.buffer.active.getLine(index * 2 + 1)!.getCell(0)!;
				expect(clock.getBgColorMode()).toBe(command.getBgColorMode());
				expect(clock.getBgColor()).toBe(command.getBgColor());
				expect(clock.getBgColor()).toBe(reference.getBgColor());
				expect(tail.getBgColorMode()).toBe(reference.getBgColorMode());
				expect(tail.getBgColor()).toBe(reference.getBgColor());
				expect(clock.getFgColorMode()).toBe(reference.getFgColorMode());
				expect(clock.getFgColor()).toBe(reference.getFgColor());
				expect(clock.isDim()).toBe(reference.isDim());
			}
		} finally {
			terminal.dispose();
			ui.stop();
		}
	});

	it.each(["dark", "light"] as const)("inherits the built-in edit renderer's grey %s panel", async (name) => {
		initTheme(name);
		const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
		const terminal = new xterm.Terminal({ cols: 80, rows: 12, allowProposedApi: true });
		const tool = new ToolExecutionComponent(
			"edit",
			"call",
			{ path: "sample.ts", edits: [{ oldText: "a", newText: "b" }] },
			{ timestamp, outputPadY: 0 },
			createEditToolDefinition("/tmp"),
			ui,
			"/tmp",
		);
		try {
			const lines = tool.render(80);
			const row = lines.findIndex((line) => stripAnsi(line).includes("09:07"));
			expect(stripAnsi(lines[row])).toMatch(/edit.*sample\.ts\s+09:07\s*$/);
			const reference = theme.style("reference", {
				bg: "toolPendingBg",
				fg: name === "dark" ? rgbColor(255, 255, 255) : rgbColor(0, 0, 0),
			});
			await new Promise<void>((resolve) => terminal.write([...lines, reference].join("\r\n"), resolve));
			const rendered = terminal.buffer.active.getLine(row)!;
			const clock = rendered.getCell(stripAnsi(lines[row]).indexOf("09:07"))!;
			const body = rendered.getCell(1)!;
			const tail = rendered.getCell(79)!;
			const expected = terminal.buffer.active.getLine(lines.length)!.getCell(0)!;
			for (const cell of [clock, body, tail]) {
				expect(cell.getBgColorMode()).toBe(expected.getBgColorMode());
				expect(cell.getBgColor()).toBe(expected.getBgColor());
			}
			expect(clock.getFgColorMode()).toBe(expected.getFgColorMode());
			expect(clock.getFgColor()).toBe(expected.getFgColor());
			expect(clock.isDim()).toBe(0);
		} finally {
			terminal.dispose();
			ui.stop();
		}
	});

	it.each(["default", "self"] as const)("keeps %s tool rendering and mouse coordinates intact", (renderShell) => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TuiMainScreen(terminal);
		let clicks = 0;
		const renderers: ToolRenderers = {
			renderShell,
			renderCall: () => ({
				render: () => ["tool call"],
				invalidate: () => {},
				handleMouse: (event) => {
					expect(event.y).toBe(0);
					expect(event.width).toBeLessThan(80);
					clicks++;
					return { handled: true };
				},
			}),
		};
		try {
			const tool = new ToolExecutionComponent("tool", "call", {}, { timestamp, outputPadY: 0 }, renderers, ui, "/");
			const lines = tool.render(80);
			expect(text(tool)).toMatch(/tool call\s+09:07/);
			const row = lines.findIndex((line) => stripAnsi(line).includes("tool call"));
			tool.handleMouse({
				type: "click",
				button: "left",
				x: 1,
				y: row,
				screenX: 1,
				screenY: row,
				width: 80,
				height: lines.length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			});
			expect(clicks).toBe(1);
		} finally {
			ui.stop();
		}
	});
});
