import assert from "node:assert";
import { describe, it } from "node:test";
import {
	AltScreenSearchComponent,
	AltScreenSearchIndex,
	type AltScreenSearchSource,
	type AltScreenSearchSourceUnit,
	findAltScreenSearchMatches,
} from "../src/alt-screen-search.ts";
import { HStack } from "../src/components/h-stack.ts";
import { Image } from "../src/components/image.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { SelectList } from "../src/components/select-list.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import {
	encodeKitty,
	hyperlink,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import { Container, renderFakeCursor, type TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";

class InputOverlay {
	focused = false;
	inputs: string[] = [];

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): string[] {
		return ["overlay"];
	}

	invalidate(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	readonly events: Array<{ type: "write"; data: string } | { type: "start" } | { type: "stop" }> = [];

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.events.push({ type: "start" });
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.events.push({ type: "write", data });
		super.write(data);
	}

	override stop(): void {
		this.events.push({ type: "stop" });
		super.stop();
	}
}

describe("TuiAltScreen", () => {
	it("renders a terminal-height viewport and preserves manual scroll position", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const text = new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "line 9", "line 10"],
		);
		assert.strictEqual(tui.isFollowingOutput, true);

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "line 9"],
		);
		assert.strictEqual(tui.viewportTop, 5);
		assert.strictEqual(tui.isFollowingOutput, false);

		text.setText(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "line 9"],
		);

		tui.stop();
	});

	it("shows a clickable jump-to-end indicator on the transcript's last row while scrolled up", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: () => "\x1b[7m ↓ Jump to end \x1b[27m",
		});
		const transcript = new ScrollView(
			new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: new Text("editor\nfooter", 0, 0), basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("Jump to end")));

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);
		assert.strictEqual(terminal.getViewport()[3], "line 7  ↓ Jump to end         ");
		assert.strictEqual(terminal.getViewport()[4]?.trimEnd(), "editor");

		// Pressing next to the label starts a selection instead of jumping.
		terminal.sendInput("\x1b[<0;2;4M");
		terminal.sendInput("\x1b[<0;2;4m");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);

		terminal.sendInput("\x1b[<0;15;4M");
		terminal.sendInput("\x1b[<0;15;4m");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, true);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "editor", "footer"],
		);
		tui.stop();
	});

	it("keeps the jump-to-end indicator centered as the auto scrollbar hides and reappears", async () => {
		// Regression test for #9136: auto scrollbar visibility must not move the indicator.
		const terminal = new VirtualTerminal(80, 6);
		const label = " ↓ Jump to latest message · End ";
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: () => label,
		});
		const transcript = new ScrollView(
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true, scrollbar: "auto", scrollbarHideDelayMs: 0 },
		);
		tui.setLayoutRoot(transcript);
		tui.start();
		try {
			await terminal.waitForRender();

			// Scrolling over the track keeps the scrollbar visible until the pointer leaves.
			terminal.sendInput("\x1b[<64;80;1M");
			await terminal.waitForRender();
			assert.strictEqual(transcript.isScrollbarVisible, true);
			assert.strictEqual(transcript.isFollowingEnd, false);
			const scrollTop = transcript.scrollTop;
			const visibleColumn = terminal.getViewport()[5].indexOf(label);

			// Leaving the track lets the auto-hide timer expire without changing the content.
			terminal.sendInput("\x1b[<35;79;1M");
			await terminal.waitForRender();
			assert.strictEqual(transcript.isScrollbarVisible, false);
			assert.strictEqual(transcript.scrollTop, scrollTop);
			const hiddenColumn = terminal.getViewport()[5].indexOf(label);

			terminal.sendInput("\x1b[<35;80;1M");
			await terminal.waitForRender();
			assert.strictEqual(transcript.isScrollbarVisible, true);
			assert.strictEqual(transcript.scrollTop, scrollTop);
			const revealedColumn = terminal.getViewport()[5].indexOf(label);

			assert.deepStrictEqual([visibleColumn, hiddenColumn, revealedColumn], [24, 24, 24]);
		} finally {
			tui.stop();
		}
	});

	it("leaves the scrollbar visible and clickable when the jump-to-end indicator spans the transcript", async () => {
		// Regression coverage for #9136: centering must not paint or capture clicks over the scrollbar.
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: () => "↓".repeat(30),
		});
		const transcript = new ScrollView(
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true, scrollbar: "always" },
		);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: new Text("editor\nfooter", 0, 0), basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);

		// The indicator must not intercept a press on the scrollbar's last column.
		assert.strictEqual(terminal.getViewport()[3], `${"↓".repeat(29)}┃`);
		terminal.sendInput("\x1b[<0;30;4M");
		terminal.sendInput("\x1b[<0;30;4m");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);
		tui.stop();
	});

	it("never shows the jump-to-end indicator for a primary scroll view without follow-end", async () => {
		const terminal = new VirtualTerminal(30, 3);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: () => " ↓ Jump to end ",
		});
		const transcript = new ScrollView(new Text("one\ntwo\nthree\nfour\nfive", 0, 0), { primary: true });
		tui.setLayoutRoot(transcript);
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(transcript.isFollowingEnd, false);
		assert.ok(!terminal.getViewport().some((line) => line.includes("Jump to end")));
		tui.stop();
	});

	it("keeps an explicit dock fixed while the transcript scrolls", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const transcriptText = new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const dock = new VStack([new Text("editor", 0, 0), new Text("footer", 0, 0)]);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "editor", "footer"],
		);

		// Wheel over the dock falls back to the primary transcript scroll view.
		terminal.sendInput("\x1b[<64;1;6M");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 4", "line 5", "line 6", "line 7", "editor", "footer"],
		);
		assert.strictEqual(transcript.isFollowingEnd, false);

		transcriptText.setText(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 4", "line 5", "line 6", "line 7", "editor", "footer"],
		);

		tui.scrollToBottom();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "line 9", "line 10", "editor", "footer"],
		);
		tui.stop();
	});

	it("invalidates overlays with an explicit layout root", () => {
		const tui = new TuiAltScreen(new VirtualTerminal());
		const overlay = new Text("overlay", 0, 0);
		let invalidated = false;
		overlay.invalidate = () => {
			invalidated = true;
		};
		tui.setLayoutRoot(new Text("root", 0, 0));
		tui.showOverlay(overlay);

		tui.invalidate();

		assert.strictEqual(invalidated, true);
		tui.stop();
	});

	it("routes wheel input to the scroll view under the pointer", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const left = new ScrollView(new Text("a1\na2\na3\na4\na5\na6\na7", 0, 0), {
			follow: "end",
			primary: true,
		});
		const right = new ScrollView(new Text("b1\nb2\nb3\nb4\nb5\nb6\nb7", 0, 0), { follow: "end" });
		tui.setLayoutRoot(
			new HStack([
				{ component: left, basis: 10, shrink: 0 },
				{ component: right, basis: 10, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;15;1M");
		await terminal.waitForRender();
		assert.strictEqual(left.scrollTop, 3);
		assert.strictEqual(right.scrollTop, 2);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["a4        b3", "a5        b4", "a6        b5", "a7        b6"],
		);
		tui.stop();
	});

	it("scrolls faster while Alt is held during wheel input", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const text = new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 8);

		// Alt modifier sets bit 8 on the wheel button (72 = 64 + 8).
		terminal.sendInput("\x1b[<72;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 3);
		tui.stop();
	});

	it("does not vertically redispatch misses through horizontal layout containers", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		let selections = 0;
		const list = new SelectList(
			[
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
			2,
			{
				selectedPrefix: (text) => text,
				selectedText: (text) => text,
				description: (text) => text,
				scrollInfo: (text) => text,
				noMatch: (text) => text,
			},
		);
		list.onSelect = () => {
			selections += 1;
		};
		tui.setLayoutRoot(
			new HStack([
				{ component: list, basis: 10 },
				{ component: new Text("plain", 0, 0), basis: 10 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;15;1M");
		terminal.sendInput("\x1b[<0;15;1m");
		await terminal.waitForRender();
		assert.strictEqual(selections, 0);
		tui.stop();
	});

	it("uses button-motion tracking inside terminal multiplexers", () => {
		const environmentKeys = ["TMUX", "ZELLIJ", "STY", "TERM"] as const;
		const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
		try {
			for (const key of environmentKeys) delete process.env[key];
			process.env.TERM = "xterm-256color";
			const directTerminal = new RecordingTerminal();
			const directTui = new TuiAltScreen(directTerminal);
			directTui.start();
			const directWrites = directTerminal.events
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(directWrites.includes("\x1b[?1003h"));
			directTui.stop();

			const multiplexers = [
				{ name: "tmux environment", environment: { TMUX: "/tmp/tmux/default,1,0" } },
				{ name: "tmux TERM", environment: { TERM: "tmux-256color" } },
				{ name: "Zellij environment", environment: { ZELLIJ: "0" } },
				{ name: "Screen environment", environment: { STY: "123.session" } },
				{ name: "Screen TERM", environment: { TERM: "screen-256color" } },
			];
			for (const { name, environment } of multiplexers) {
				for (const key of environmentKeys) delete process.env[key];
				for (const [key, value] of Object.entries(environment)) process.env[key] = value;
				const terminal = new RecordingTerminal();
				const tui = new TuiAltScreen(terminal);
				tui.start();
				const writes = terminal.events
					.filter((event): event is { type: "write"; data: string } => event.type === "write")
					.map((event) => event.data)
					.join("");
				assert.ok(writes.includes("\x1b[?1002h"), `${name} should enable button-motion tracking`);
				assert.ok(!writes.includes("\x1b[?1003h"), `${name} should not enable all-motion tracking`);
				assert.ok(writes.includes("\x1b[?1006h"), `${name} should enable SGR mouse encoding`);
				tui.stop();
			}
		} finally {
			for (const key of environmentKeys) {
				const value = previousEnvironment.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("invokes the right-click paste handler only on Windows outside VS Code", () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const termProgram = process.env.TERM_PROGRAM;
		assert.ok(platformDescriptor);
		const terminal = new VirtualTerminal();
		let pasteCount = 0;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onRightClickPaste: () => {
				pasteCount += 1;
			},
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			delete process.env.TERM_PROGRAM;
			tui.start();
			terminal.sendInput("\x1b[<2;1;1M");
			terminal.sendInput("\x1b[<2;1;1m");
			assert.strictEqual(pasteCount, 1);

			process.env.TERM_PROGRAM = "vscode";
			terminal.sendInput("\x1b[<2;1;1M");
			assert.strictEqual(pasteCount, 1);

			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			delete process.env.TERM_PROGRAM;
			terminal.sendInput("\x1b[<2;1;1M");
			assert.strictEqual(pasteCount, 1);
		} finally {
			tui.stop();
			Object.defineProperty(process, "platform", platformDescriptor);
			if (termProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = termProgram;
		}
	});

	it("reveals an auto scrollbar when the pointer enters its hidden track", async () => {
		const terminal = new RecordingTerminal(10, 5);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "auto", scrollbarHideDelayMs: 20 },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, false);

		terminal.sendInput("\x1b[<35;10;3M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, true);
		assert.strictEqual(scrollView.isScrollbarActive, true);
		assert.ok(terminal.getViewport().some((line) => /[│█]/.test(line)));

		terminal.sendInput("\x1b[<35;9;3M");
		await new Promise((resolve) => setTimeout(resolve, 40));
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, false);
		tui.stop();
	});

	it("jumps to a scrollbar track position and continues dragging from there", async () => {
		const terminal = new RecordingTerminal(10, 10);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "always" },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 0);

		terminal.sendInput("\x1b[<0;10;6M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 20);

		terminal.sendInput("\x1b[<32;10;10M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 40);

		terminal.sendInput("\x1b[<0;10;10m");
		await terminal.waitForRender();
		assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")));
		tui.stop();
	});

	// #9758: wheel line counts can change at runtime; Alt keeps its multiplier.
	it("applies runtime wheel line count updates", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });
		const deltas: Array<number | undefined> = [];
		tui.addChild(
			new MouseRegion(new Text("wheel target", 0, 0), (event) => {
				if (event.type !== "wheel") return undefined;
				deltas.push(event.wheelDelta);
				return { handled: true };
			}),
		);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<64;1;1M");
			tui.setWheelScrollLines(2);
			terminal.sendInput("\x1b[<65;1;1M");
			terminal.sendInput("\x1b[<72;1;1M");
			assert.deepStrictEqual(deltas, [-3, 2, -10]);
		} finally {
			tui.stop();
		}
	});

	it("chains unused wheel delta to an outer scroll view", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });
		const inner = new ScrollView(new Text("i1\ni2\ni3\ni4\ni5\ni6", 0, 0));
		const outer = new ScrollView(
			new VStack([{ component: inner, basis: 2 }, new Text("tail1\ntail2\ntail3\ntail4\ntail5", 0, 0)]),
			{ primary: true },
		);
		tui.setLayoutRoot(outer);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(inner.scrollTop, 3);
		assert.strictEqual(outer.scrollTop, 0);

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(inner.scrollTop, 4);
		assert.strictEqual(outer.scrollTop, 2);
		tui.stop();
	});

	it("supports configurable keyboard viewport navigation with four rows of page overlap", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[57421u");
		terminal.sendInput("\x1b[57421;1:3u");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
		);

		terminal.sendInput("\x1b[57422u");
		terminal.sendInput("\x1b[57422;1:3u");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
		);

		terminal.sendInput("\x1b[7^");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
		);

		terminal.sendInput("\x1b[8^");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
		);

		tui.stop();
	});

	it("searches normalized rendered transcript text across rows", () => {
		assert.deepStrictEqual(findAltScreenSearchMatches(["alpha QUICK", "brown fox"], "quick brown"), [
			{
				segments: [
					{ row: 0, startCol: 6, endCol: 11 },
					{ row: 1, startCol: 0, endCol: 5 },
				],
			},
		]);
	});

	it("maps normalized ASCII and Unicode search matches back to rendered columns", () => {
		assert.deepStrictEqual(findAltScreenSearchMatches(["\x1b[31mfoo  bar\x1b[0m", "A界🙂éZ"], "oo   bar\nA界🙂é"), [
			{
				segments: [
					{ row: 0, startCol: 1, endCol: 3 },
					{ row: 0, startCol: 5, endCol: 8 },
					{ row: 1, startCol: 0, endCol: 6 },
				],
			},
		]);
	});

	it("reuses indexed transcript matches until the query or rendered lines change", () => {
		const index = new AltScreenSearchIndex();
		const initial = index.search(["alpha needle", "omega"], "needle");
		assert.strictEqual(initial.changed, true);
		assert.strictEqual(initial.matches.length, 1);

		const cached = index.search(["alpha needle", "omega"], "needle");
		assert.strictEqual(cached.changed, false);
		assert.strictEqual(cached.matches, initial.matches);

		const changedQuery = index.search(["alpha needle", "omega"], "omega");
		assert.strictEqual(changedQuery.changed, true);
		assert.notStrictEqual(changedQuery.matches, initial.matches);
		assert.deepStrictEqual(changedQuery.matches[0]?.segments, [{ row: 1, startCol: 0, endCol: 5 }]);

		const changedLines = index.search(["alpha needle", "no match"], "omega");
		assert.strictEqual(changedLines.changed, true);
		assert.deepStrictEqual(changedLines.matches, []);
	});

	it("renders transcript search with a muted placeholder and right-aligned controls", () => {
		const component = new AltScreenSearchComponent(() => {});
		const rendered = component.render(48);
		const lines = rendered.map((line) => stripTerminalSequences(line));

		assert.strictEqual(lines.length, 3);
		assert.ok(lines.every((line) => visibleWidth(line) === 48));
		assert.match(lines[0] ?? "", /^┌─+┐$/);
		assert.match(lines[1] ?? "", /^│ Find in transcript +│$/);
		assert.ok(rendered[1]?.includes("\x1b[2m"));
		assert.match(lines[2] ?? "", /^└─+ ↑ Shift\+Enter · ↓ Enter ─┘$/);
		const controls = lines[2] ?? "";
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("↑")), -1);
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("Shift+Enter") + 5), -1);
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("·")), undefined);
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("↓")), 1);
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.lastIndexOf("Enter") + 2), 1);

		component.handleInput("n");
		component.setResult(0, 2);
		const populatedRender = component.render(48);
		const populated = populatedRender.map((line) => stripTerminalSequences(line));
		assert.ok(populated[1]?.includes("n"));
		assert.ok(populated[1]?.includes("1/2"));
		assert.ok(populatedRender[1]?.includes("\x1b[2m 1/2 \x1b[22m"));
		assert.ok(!populated.some((line) => line.includes("Find in transcript")));
	});

	it("navigates transcript search with hoverable arrow buttons and toggles it with its shortcut", async () => {
		const terminal = new RecordingTerminal(120, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			searchNavigationButtonStyle: (text, hovered) => `${hovered ? "\x1b[45m" : "\x1b[44m"}${text}\x1b[49m`,
		});
		tui.addChild(new Text("needle one\nmiddle\nneedle two\nend", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("1/2")));
		assert.ok(viewport.some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));

		let arrowRow = viewport.findIndex((line) => line.includes("↑") && line.includes("↓"));
		let arrowColumn = viewport[arrowRow]?.lastIndexOf("Enter") ?? -1;
		assert.ok(arrowRow >= 0 && arrowColumn >= 0);
		const hoverEventCount = terminal.events.length;
		terminal.sendInput(`\x1b[<35;${arrowColumn + 1};${arrowRow + 1}M`);
		await terminal.waitForRender();
		assert.ok(
			terminal.events
				.slice(hoverEventCount)
				.some((event) => event.type === "write" && event.data.includes("\x1b[45m↓ Enter\x1b[49m")),
		);
		terminal.sendInput(`\x1b[<0;${arrowColumn + 1};${arrowRow + 1}M`);
		await terminal.waitForRender();
		viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("2/2")));
		assert.ok(viewport.some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));

		arrowRow = viewport.findIndex((line) => line.includes("↑") && line.includes("↓"));
		arrowColumn = (viewport[arrowRow]?.indexOf("Shift+Enter") ?? -3) + 3;
		assert.ok(arrowRow >= 0 && arrowColumn >= 0);
		terminal.sendInput(`\x1b[<0;${arrowColumn + 1};${arrowRow + 1}M`);
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("1/2")));
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));

		terminal.sendInput("\x1b[102;6u");
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));
		tui.stop();
	});

	it("does not treat transcript box drawing as search navigation buttons", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(
			new Text(
				[
					"needle one",
					"middle",
					"needle two",
					"filler",
					"┌────────────────────────────────────────┐",
					"│ box                                    │",
					"└────────────────────────────────────────┘",
					"end",
				].join("\n"),
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("1/2")));
		assert.ok(!viewport.some((line) => line.includes("2/2")));

		const boxBottomRow = viewport.findIndex((line) => line.startsWith("└"));
		assert.ok(boxBottomRow >= 0);
		terminal.sendInput(`\x1b[<0;24;${boxBottomRow + 1}M`);
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("1/2")));
		assert.ok(!viewport.some((line) => line.includes("2/2")));
		tui.stop();
	});

	it("uses configured styles for current and non-current search matches", async () => {
		const terminal = new RecordingTerminal(60, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			searchMatchStyle: (text) => `\x1b[41m${text}\x1b[49m`,
			searchCurrentMatchStyle: (text) => `\x1b[42m${text}\x1b[49m`,
		});
		tui.addChild(new Text("needle first\nmiddle\nneedle second\nend", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();

		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[42mneedle\x1b[49m")),
		);
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[41mneedle\x1b[49m")),
		);
		tui.stop();
	});

	it("searches the transcript with Ctrl+Shift+F and restores editor focus on close", async () => {
		const terminal = new RecordingTerminal(60, 8);
		const tui = new TuiAltScreen(terminal);
		const transcriptText = new Text(
			Array.from({ length: 12 }, (_, index) => {
				if (index === 4) return "line 5 needle one";
				if (index === 9) return "line 10 needle two";
				return `line ${index + 1}`;
			}).join("\n"),
			0,
			0,
		);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const editorInputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => editorInputs.push(data),
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);
		assert.ok(terminal.getViewport().some((line) => line.includes("2/2")));
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));
		assert.ok(terminal.getViewport().some((line) => line.includes("line 10 needle two")));
		assert.deepStrictEqual(editorInputs, []);
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[1;7mneedle\x1b[22;27m")),
		);

		for (let index = 0; index < 6; index++) terminal.sendInput("\x1b[<64;1;4M");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);
		assert.ok(terminal.getViewport().some((line) => line.includes("needle") && line.includes("2/2")));

		terminal.sendInput("\x07");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("1/2")));
		assert.ok(terminal.getViewport().some((line) => line.includes("line 5 needle one")));

		terminal.sendInput("\x1b[103;6u");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("2/2")));
		assert.ok(terminal.getViewport().some((line) => line.includes("line 10 needle two")));

		terminal.sendInput("\x1b");
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));
		assert.deepStrictEqual(editorInputs, ["x"]);

		tui.stop();
	});

	it("scrolls the transcript by half a page with custom bindings", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.halfPageUp": "ctrl+u",
				"tui.altScreen.halfPageDown": "ctrl+d",
			}),
		);
		try {
			tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);

			terminal.sendInput("\x15");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 15);

			terminal.sendInput("\x04");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);
		} finally {
			tui.stop();
			setKeybindings(originalKeybindings);
		}
	});

	it("scrolls the transcript by one line with custom bindings", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.lineUp": "ctrl+y",
				"tui.altScreen.lineDown": "ctrl+e",
			}),
		);
		try {
			tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);

			terminal.sendInput("\x19");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 19);

			terminal.sendInput("\x05");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);
		} finally {
			tui.stop();
			setKeybindings(originalKeybindings);
		}
	});

	it("routes Home and End to the focused component and Ctrl+Home/End to the transcript", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		const editorInputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => editorInputs.push(data),
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		const bottom = transcript.scrollTop;
		assert.ok(bottom > 0);

		// #10314: unmodified Home/End belong to the editor in every UI mode.
		const editorKeys = ["\x1bOH", "\x1b[F", "\x1b[57423u", "\x1b[5;5~", "\x1b[6;5~"];
		for (const input of editorKeys) terminal.sendInput(input);
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, bottom);
		assert.deepStrictEqual(editorInputs, editorKeys);

		terminal.sendInput("\x1b[1;5H");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);

		terminal.sendInput("\x1b[1;5F");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, bottom);
		assert.strictEqual(transcript.isFollowingEnd, true);

		terminal.sendInput("\x1b[57423;5u");
		terminal.sendInput("\x1b[57423;5:3u");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);

		terminal.sendInput("\x1b[6~");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 1);
		assert.deepStrictEqual(editorInputs, editorKeys);

		tui.stop();
	});

	it("jumps between OSC 133 semantic prompt markers", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(
			new Text(
				[1, 2, 3, 4].flatMap((message) => [`${OSC133_ZONE_START}message ${message}`, "detail"]).join("\n"),
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 5);

		terminal.sendInput("\x1b[57419;6u");
		terminal.sendInput("\x1b[57419;6:3u");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3");

		terminal.sendInput("\x1b[1;6A");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 2);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 2");

		terminal.sendInput("\x1b[57420;6u");
		terminal.sendInput("\x1b[57420;6:3u");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3");

		terminal.sendInput("\x1b[1;6B");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 5);
		assert.strictEqual(terminal.getViewport()[1]?.trimEnd(), "message 4");
		assert.strictEqual(tui.isFollowingOutput, true);

		tui.stop();
	});

	it("does not emit Kitty graphics commands or OSC 133 zones in iTerm2", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 3);
			const tui = new TuiAltScreen(terminal);
			tui.addChild({
				render: () => ["\x1b]133;B\x07\x1b]133;C\x07\x1b]133;A\x07content"],
				invalidate: () => {},
			});
			tui.addChild(
				new Image(
					"AAAA",
					"image/png",
					{ fallbackColor: (value) => value },
					{ filename: "example.png" },
					{ widthPx: 10, heightPx: 10 },
				),
			);
			tui.start();
			await terminal.waitForRender();
			tui.stop();
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b_G")));
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]133;")));
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]1337;File=")));
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("[Image:")));
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("clears stale iTerm2 image placements when they leave the viewport", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 3);
			const tui = new TuiAltScreen(terminal);
			const imageLine = "\x1b]1337;File=inline=1;width=2;height=auto:AAAA\x07";
			tui.addChild({
				render: () => [imageLine, "", "", "after", "more", "end"],
				invalidate: () => {},
			});
			tui.start();
			await terminal.waitForRender();
			tui.scrollToTop();
			await terminal.waitForRender();
			const eventCount = terminal.events.length;

			tui.scrollBy(1);
			await terminal.waitForRender();
			assert.ok(
				terminal.events.slice(eventCount).some((event) => event.type === "write" && event.data.includes("\x1b[2J")),
			);
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("crops a Kitty image whose first line is above the viewport", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		const imageId = 123;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		tui.addChild({
			render: () => ["before", imageLine, "", "", "after", "end"],
			invalidate: () => {},
		});
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(tui.viewportTop, 3);
		assert.ok(
			terminal.events.some(
				(event) => event.type === "write" && event.data.includes("i=123") && event.data.includes("y=66,h=34,r=1"),
			),
		);

		tui.stop();
	});

	it("redraws WezTerm Kitty images after writes to covered rows", async () => {
		// Regression test for #10319: a scrollbar update below an unchanged image anchor erased its cells.
		const weztermPane = process.env.WEZTERM_PANE;
		let tui: TuiAltScreen | undefined;
		process.env.WEZTERM_PANE = "1";
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 4);
			const imageId = 10319;
			const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
			registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
			let coveredLine = "";
			tui = new TuiAltScreen(terminal);
			tui.setLayoutRoot({
				render: () => [imageLine, coveredLine, "", "after"],
				invalidate: () => {},
			});
			tui.start();
			await terminal.waitForRender();
			const eventCount = terminal.events.length;

			coveredLine = "changed";
			tui.requestRender();
			await terminal.waitForRender();
			const redrawWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			const placementIndex = redrawWrites.indexOf("\x1b_Ga=p,q=2");
			assert.ok(redrawWrites.includes("\x1b_Ga=d,d=a,q=2\x1b\\"));
			assert.ok(placementIndex > redrawWrites.indexOf("changed"));
			assert.ok(!redrawWrites.includes("\x1b_Ga=T"));
		} finally {
			tui?.stop();
			resetCapabilitiesCache();
			if (weztermPane === undefined) delete process.env.WEZTERM_PANE;
			else process.env.WEZTERM_PANE = weztermPane;
		}
	});

	it("reuses moved Kitty images without dropping HStack siblings", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 6);
			const tui = new TuiAltScreen(terminal);
			const label = new Text("left", 0, 0);
			const image = new Image(
				"A".repeat(8192),
				"image/png",
				{ fallbackColor: (value) => value },
				{},
				{ widthPx: 100, heightPx: 100 },
			);
			const header = new Text("header", 0, 0);
			const row = new HStack([
				{ component: label, basis: 10 },
				{ component: image, basis: 10 },
			]);
			tui.setLayoutRoot(
				new VStack([
					{ component: header, basis: "auto" },
					{ component: row, basis: 4 },
				]),
			);
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")));

			const eventCount = terminal.events.length;
			label.setText("changed");
			header.setText("header\nsecond");
			tui.requestRender();
			await terminal.waitForRender();
			const redrawWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			const placementIndex = redrawWrites.indexOf("\x1b_Ga=p,q=2");
			assert.ok(redrawWrites.includes("\x1b_Ga=d,d=a,q=2\x1b\\"));
			assert.ok(placementIndex > redrawWrites.indexOf("changed"));
			assert.ok(!redrawWrites.includes("\x1b_Ga=T"));
			assert.ok(redrawWrites.length < 2000, `expected placement-only redraw, got ${redrawWrites.length} bytes`);
			assert.ok(terminal.getViewport().some((line) => line.trimEnd() === "changed"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("retains recently offscreen Kitty images for placement-only reuse", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const imageId = 321;
			const imageLine = encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => [imageLine, "after"],
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")));

			const eventCount = terminal.events.length;
			tui.scrollBy(1);
			await terminal.waitForRender();
			tui.scrollBy(-1);
			await terminal.waitForRender();
			const reentryWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(reentryWrites.includes("\x1b_Ga=p,q=2"));
			assert.ok(!reentryWrites.includes("\x1b_Ga=T"));
			assert.ok(!reentryWrites.includes(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("evicts the least recently visible Kitty image when the cache is full", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const firstImageId = 500;
			const imageLines = Array.from({ length: 18 }, (_, index) => {
				const imageId = firstImageId + index;
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => imageLines,
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			for (let index = 1; index < imageLines.length; index++) {
				tui.scrollBy(1);
				await terminal.waitForRender();
			}
			assert.ok(
				terminal.events.some(
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			);

			const eventCount = terminal.events.length;
			tui.scrollToTop();
			await terminal.waitForRender();
			const reentryWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(reentryWrites.includes("\x1b_Ga=T"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("evicts offscreen Kitty images when decoded raster memory exceeds the cache quota", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const firstImageId = 600;
			const imageLines = Array.from({ length: 4 }, (_, index) => {
				const imageId = firstImageId + index;
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 3840, heightPx: 2160 });
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => imageLines,
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			for (let index = 1; index < imageLines.length; index++) {
				tui.scrollBy(1);
				await terminal.waitForRender();
			}
			assert.ok(
				terminal.events.some(
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			);
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("opens an OSC 8 hyperlink with specific or generic release codes, but not on drag", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const openedUrls: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			openUrl: (url) => openedUrls.push(url),
		});
		const url = "https://example.com/path?q=1";
		const belUrl = "https://example.com/bel";
		const emojiUrl = "https://example.com/emoji";
		tui.addChild(
			new Text(
				`${hyperlink("link", url)}\n\x1b]8;;${belUrl}\x07link\x1b]8;;\x07\n${hyperlink("🙂", emojiUrl)}`,
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<3;2;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url]);

		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl]);

		terminal.sendInput("\x1b[<0;2;3M");
		terminal.sendInput("\x1b[<0;2;3m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl, emojiUrl]);

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<0;4;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl, emojiUrl]);

		tui.stop();
	});

	it("selects visible text with the mouse and copies it with OSC 52 after a generic release", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("\x1b[1mal\x1b[0mpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<3;4;2m");
		await terminal.waitForRender();

		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from("alpha\nbeta").toString("base64")}\x07`;
		const clipboardWrites = terminal.events.filter(
			(event) => event.type === "write" && event.data.includes("\x1b]52;c;"),
		);
		assert.ok(
			clipboardWrites.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
			JSON.stringify(clipboardWrites),
		);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7m")));
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("al\x1b[0m\x1b[7mpha")),
			"selection inverse must be reapplied after a reset inside the selection",
		);
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		tui.stop();
	});

	it("keeps the selection highlight after a fake cursor cell", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(`> ${renderFakeCursor("a")}bcd`, 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;6;1M");
		terminal.sendInput("\x1b[<3;6;1m");
		await terminal.waitForRender();

		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[27m\x1b[7mbcd")),
			"selection inverse must be reapplied after the fake cursor ends",
		);

		tui.stop();
	});

	it("uses an injected copySelection handler instead of OSC 52 and reports success", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["alpha\nbeta"]);
		assert.ok(
			terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")),
			"must not emit OSC 52 when a copySelection handler is provided",
		);
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		tui.stop();
	});

	it("leaves selections visible without copying when copyOnSelect is disabled", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, []);
		assert.strictEqual(tui.hasActiveSelection(), true);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7m")));
		assert.ok(terminal.getViewport().every((line) => !line.includes("Copied!")));

		tui.stop();
	});

	it("copies an active selection programmatically", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(tui.hasActiveSelection(), false);
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), false);

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["alpha\nbeta"]);
		assert.strictEqual(tui.hasActiveSelection(), true);

		copied.length = 0;
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["alpha\nbeta"]);
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		tui.stop();
	});

	it("flashes an error when the injected copySelection handler fails", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async () => false,
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.ok(terminal.getViewport().some((line) => line.includes("Copy failed")));
		assert.ok(
			terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")),
			"must not emit OSC 52 when a copySelection handler is provided",
		);

		tui.stop();
	});

	it("flashes a specific error returned by the injected copySelection handler", async () => {
		// Regression test for #9618.
		const terminal = new RecordingTerminal(80, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			copySelection: async () => "Clipboard unavailable: install wl-clipboard",
		});
		let flashDuration: number | undefined;
		const flash = tui.flash.bind(tui);
		tui.flash = (message, durationMs) => {
			flashDuration = durationMs;
			flash(message, durationMs);
		};
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), false);
		await terminal.waitForRender();

		assert.ok(terminal.getViewport().some((line) => line.includes("Clipboard unavailable: install wl-clipboard")));
		assert.ok(terminal.getViewport().every((line) => !line.includes("Copy failed")));
		assert.strictEqual(flashDuration, 5000);
		tui.stop();
	});

	it("does not append whitespace to double-click word highlighting", async () => {
		const terminal = new RecordingTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("foo  bar", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;3;1M");
		await terminal.waitForRender();

		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("foo\x1b[27m")));
		tui.stop();
	});

	it("coalesces slash and hyphen separated segments for double-click word selection", async () => {
		for (const { line, needle } of [
			{ line: "extensions/starline/fixed-editor/compositor.ts", needle: "starline" },
			{ line: "earendil-works/pi-tui", needle: "works" },
		]) {
			const copied: string[] = [];
			const terminal = new RecordingTerminal(80, 1);
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			tui.addChild(new Text(line, 0, 0));
			tui.start();
			await terminal.waitForRender();

			const oneBasedClickColumn = line.indexOf(needle) + 1;
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1M`);
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1m`);
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1M`);
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1m`);
			await terminal.waitForRender();

			assert.deepStrictEqual(copied, [line]);
			tui.stop();
		}
	});

	it("highlights a complete whitespace segment during a word drag", async () => {
		const terminal = new RecordingTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("foo  bar", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		await terminal.waitForRender();

		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("foo  \x1b[27m")));
		tui.stop();
	});

	it("selects whole words on double click, extends word drags, and selects lines on triple click", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("zero alpha beta\ngamma delta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		// The second click lands on a different character in alpha.
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<0;6;1m");
		terminal.sendInput("\x1b[<0;10;1M");
		terminal.sendInput("\x1b[<0;10;1m");
		await terminal.waitForRender();
		const alpha = `\x1b]52;c;${Buffer.from("alpha").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(alpha)));

		// A double-click drag includes each word touched, rather than partial words.
		terminal.sendInput("\x1b[<0;12;1M");
		terminal.sendInput("\x1b[<0;12;1m");
		terminal.sendInput("\x1b[<0;14;1M");
		terminal.sendInput("\x1b[<32;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		await terminal.waitForRender();
		const words = `\x1b]52;c;${Buffer.from("beta\ngamma").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(words)));

		terminal.sendInput("\x1b[<0;7;2M");
		terminal.sendInput("\x1b[<0;7;2m");
		terminal.sendInput("\x1b[<0;9;2M");
		terminal.sendInput("\x1b[<0;9;2m");
		terminal.sendInput("\x1b[<0;11;2M");
		terminal.sendInput("\x1b[<0;11;2m");
		await terminal.waitForRender();
		const line = `\x1b]52;c;${Buffer.from("gamma delta").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(line)));

		tui.stop();
	});

	it("does not repaint idle or zero-width selections on focus loss", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const writeCount = () => terminal.events.filter((event) => event.type === "write").length;
		const clipboardWriteCount = () =>
			terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;")).length;

		const idleWriteCount = writeCount();
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		assert.strictEqual(writeCount(), idleWriteCount);

		// A completed click leaves a zero-width anchor, but later orphaned drag/release events must not extend it.
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(clipboardWriteCount(), 0);

		// Losing focus after a press without a drag cancels the press without repainting.
		terminal.sendInput("\x1b[<0;1;3M");
		await terminal.waitForRender();
		const pressedWriteCount = writeCount();
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		assert.strictEqual(writeCount(), pressedWriteCount);
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(clipboardWriteCount(), 0);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004h")));

		tui.stop();
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004l")));
	});

	it("clears an active visible selection on focus loss and ignores orphan events", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		await terminal.waitForRender();
		const focusLossEventCount = terminal.events.length;
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		const focusLossWrites = terminal.events
			.slice(focusLossEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(focusLossWrites.includes("alpha"));
		assert.ok(focusLossWrites.includes("beta"));
		assert.ok(!focusLossWrites.includes("\x1b[7m"));

		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")));
		tui.stop();
	});

	it("retains a completed visible selection across focus changes", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		const completedWriteCount = terminal.events.filter((event) => event.type === "write").length;
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		assert.strictEqual(terminal.events.filter((event) => event.type === "write").length, completedWriteCount);

		const redrawEventCount = terminal.events.length;
		tui.renderNow(true);
		const redrawWrites = terminal.events
			.slice(redrawEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(redrawWrites.includes("alpha"));
		assert.ok(redrawWrites.includes("beta"));
		assert.ok(redrawWrites.includes("\x1b[7m"));
		tui.stop();
	});

	it("stacks flash messages and collapses them as they expire", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("one\ntwo\nthree\nfour", 0, 0));
		tui.start();
		await terminal.waitForRender();

		tui.flash("First", 80);
		tui.flash("Second", 500);
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.endsWith(" First "));
		assert.ok(viewport[1]?.endsWith(" Second "));

		await new Promise((resolve) => setTimeout(resolve, 100));
		await terminal.waitForRender();
		viewport = terminal.getViewport();
		assert.ok(viewport[0]?.endsWith(" Second "));
		assert.ok(!viewport.some((line) => line.includes("First")));

		tui.stop();
	});

	it("auto-scrolls and extends a drag selection held at the viewport edge", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 6);

		terminal.sendInput("\x1b[<0;1;3M");
		terminal.sendInput("\x1b[<32;1;1M");
		await new Promise((resolve) => setTimeout(resolve, 130));
		await terminal.waitForRender();

		const selectionTop = tui.viewportTop;
		assert.ok(selectionTop < 6, `expected auto-scroll above row 6, got ${selectionTop}`);
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();

		const selectedLines = Array.from({ length: 8 - selectionTop }, (_, index) => `line ${selectionTop + index + 1}`);
		selectedLines.push("l");
		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from(selectedLines.join("\n")).toString("base64")}\x07`;
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
			JSON.stringify(terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;"))),
		);
		tui.stop();
	});

	it("snaps mouse selection to CJK, emoji, and combining grapheme boundaries", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("A界🙂éZ", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const wideSelection = `\x1b]52;c;${Buffer.from("界🙂").toString("base64")}\x07`;
		terminal.sendInput("\x1b[<0;3;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<0;4;1m");
		await terminal.waitForRender();
		assert.strictEqual(
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
			1,
		);

		terminal.sendInput("\x1b[<0;5;1M");
		terminal.sendInput("\x1b[<32;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		assert.strictEqual(
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
			2,
		);

		const combiningSelection = `\x1b]52;c;${Buffer.from("éZ").toString("base64")}\x07`;
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<32;7;1M");
		terminal.sendInput("\x1b[<0;7;1m");
		await terminal.waitForRender();
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(combiningSelection)));

		tui.stop();
	});

	it("ignores horizontal trackpad wheel events", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<66;1;1M");
		terminal.sendInput("\x1b[<67;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8"],
		);

		tui.stop();
	});

	it("dispatches clicks to nested mouse regions without breaking drag selection", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		let clicks = 0;
		tui.addChild(
			new MouseRegion(new Text("clickable\nselectable", 0, 0), (event) => {
				if (event.type !== "click") return undefined;
				clicks += 1;
				return { handled: true };
			}),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		assert.strictEqual(clicks, 1);

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(clicks, 1);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b]52;c;")));
		tui.stop();
	});

	// #10769
	it("scrolls the transcript on wheel input a focused overlay does not handle", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		const overlay = new InputOverlay();
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;
		tui.showOverlay(overlay, { anchor: "top-left", width: 10 });
		await terminal.waitForRender();
		assert.strictEqual(overlay.focused, true);

		terminal.sendInput("\x1b[<64;3;1M");
		await terminal.waitForRender();
		assert.ok(tui.viewportTop < topBefore);
		assert.deepStrictEqual(overlay.inputs, []);
		tui.stop();
	});

	it("focuses and captures drag gestures for mouse-aware components", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		const events: string[] = [];
		const component = {
			render: () => ["control"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				events.push(event.type);
				return event.type === "press" ? { handled: true, capture: true, focus: true } : { handled: true };
			},
		};
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;5;2M");
		terminal.sendInput("\x1b[<0;5;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(events, ["press", "drag", "release"]);
		assert.strictEqual(tui.getFocusedComponent(), component);
		tui.stop();
	});

	it("reports consecutive click counts to component-owned controls", async () => {
		const terminal = new VirtualTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		const clickCounts: number[] = [];
		tui.addChild({
			render: () => ["control"],
			invalidate: () => {},
			handleMouse: (event) => {
				if (event.type === "press") return { handled: true };
				if (event.type === "click") {
					clickCounts.push(event.clickCount ?? 0);
					return { handled: true };
				}
				return undefined;
			},
		});
		tui.start();
		await terminal.waitForRender();

		for (let count = 0; count < 3; count++) {
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<0;1;1m");
		}
		await terminal.waitForRender();
		assert.deepStrictEqual(clickCounts, [1, 2, 3]);
		tui.stop();
	});

	it("does not rerender for handled no-op pointer motion", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		let renderCount = 0;
		tui.addChild({
			render: () => {
				renderCount += 1;
				return ["hover target"];
			},
			invalidate: () => {},
			handleMouse: (event) => (event.type === "move" ? { handled: true } : undefined),
		});
		tui.start();
		await terminal.waitForRender();
		const renderedBeforeMotion = renderCount;
		const writesBeforeMotion = terminal.events.filter((event) => event.type === "write").length;

		terminal.sendInput("\x1b[<35;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(renderCount, renderedBeforeMotion);
		assert.strictEqual(terminal.events.filter((event) => event.type === "write").length, writesBeforeMotion);
		tui.stop();
	});

	it("lets mouse-aware components consume wheel events before viewport scrolling", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		let wheelEvents = 0;
		tui.addChild(
			new MouseRegion(
				new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
				(event) => {
					if (event.type !== "wheel") return undefined;
					wheelEvents += 1;
					return { handled: true };
				},
			),
		);
		tui.start();
		await terminal.waitForRender();
		const viewportTop = tui.viewportTop;

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(wheelEvents, 1);
		assert.strictEqual(tui.viewportTop, viewportTop);
		tui.stop();
	});

	it("restores keyboard state before leaving alt mode and prints the full document", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("first\nsecond\nthird\nfourth\nfifth\nsixth", 0, 0));
		tui.start();
		await terminal.waitForRender();
		tui.stop();

		const startIndex = terminal.events.findIndex((event) => event.type === "start");
		const altScreenEnterIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1049h"),
		);
		const stopIndex = terminal.events.findIndex((event) => event.type === "stop");
		const mouseDisableIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1006l"),
		);
		const mainScreenRestoreIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1049l"),
		);
		assert.ok(altScreenEnterIndex >= 0 && altScreenEnterIndex < startIndex);
		assert.ok(mouseDisableIndex >= 0 && mouseDisableIndex < stopIndex);
		assert.ok(mainScreenRestoreIndex > stopIndex);

		const restoreEvent = terminal.events[mainScreenRestoreIndex];
		assert.strictEqual(restoreEvent?.type, "write");
		if (restoreEvent?.type === "write") {
			assert.ok(restoreEvent.data.includes("first"));
			assert.ok(restoreEvent.data.includes("second"));
			assert.ok(restoreEvent.data.includes("third"));
			assert.ok(restoreEvent.data.includes("fourth"));
			assert.ok(restoreEvent.data.includes("fifth"));
			assert.ok(restoreEvent.data.includes("sixth"));
			assert.ok(restoreEvent.data.indexOf("first") < restoreEvent.data.indexOf("sixth"));
		}
	});

	it("gives viewport keys to a focused overlay", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		const overlay = new InputOverlay();
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;
		const handle = tui.showOverlay(overlay);
		await terminal.waitForRender();
		assert.strictEqual(overlay.focused, true);

		const keys = ["\x1b[5~", "\x1b[6~", "\x1bOH", "\x1bOF"];
		for (const key of keys) terminal.sendInput(key);
		await terminal.waitForRender();

		assert.deepStrictEqual(overlay.inputs, keys);
		assert.strictEqual(tui.viewportTop, topBefore);

		handle.hide();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		assert.ok(tui.viewportTop < topBefore);
		tui.stop();
	});

	it("keeps viewport scrolling when an overlay is not focused", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const editor = new InputOverlay();
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;

		const hidden = tui.showOverlay(new InputOverlay());
		hidden.setHidden(true);
		const nonCapturing = new InputOverlay();
		tui.showOverlay(nonCapturing, { nonCapturing: true });
		const unfocused = new InputOverlay();
		const unfocusedHandle = tui.showOverlay(unfocused);
		unfocusedHandle.unfocus();
		await terminal.waitForRender();
		assert.strictEqual(nonCapturing.focused, false);
		assert.strictEqual(unfocused.focused, false);

		terminal.sendInput("\x1b[5~");
		terminal.sendInput("\x1b[<64;10;3M");
		await terminal.waitForRender();
		assert.ok(tui.viewportTop < topBefore);
		assert.deepStrictEqual(nonCapturing.inputs, []);
		assert.deepStrictEqual(unfocused.inputs, []);
		tui.stop();
	});

	it("keeps viewport scrolling while transcript search is focused", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;

		terminal.sendInput("\x1b[102;6u");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ ↓")));

		terminal.sendInput("\x1b[5~");
		terminal.sendInput("\x1b[<64;1;4M");
		await terminal.waitForRender();
		assert.ok(tui.viewportTop < topBefore);
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ ↓")));
		tui.stop();
	});
});

describe("source-backed transcript search", () => {
	it("captures lazily, keeps an exclusive fixed snapshot, and releases focus and source state on replacement or stop", async () => {
		const terminal = new RecordingTerminal(80, 10);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			searchCurrentMatchStyle: (text) => `BODY-HIGHLIGHT${text}`,
		});
		const document = new Container();
		let rendering = false;
		document.addChild({
			render: () => {
				rendering = true;
				try {
					return ["render-only needle", ...Array.from({ length: 20 }, () => "closed heading")];
				} finally {
					rendering = false;
				}
			},
			invalidate: () => {},
		});
		const scroll = new ScrollView(document, { primary: true });
		let snapshots = 0;
		let anchors = 0;
		let units: readonly AltScreenSearchSourceUnit[] = [{ id: "one", fragments: ["needle first needle\x07\x1b[2J"] }];
		const source: AltScreenSearchSource = {
			snapshot: () => {
				assert.equal(rendering, false);
				snapshots++;
				return units;
			},
			getAnchorRow: () => {
				assert.equal(rendering, false);
				anchors++;
				return 15;
			},
		};
		scroll.searchSource = source;
		const editor = new InputOverlay();
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, grow: 1, basis: 0 },
				{ component: editor, basis: 1 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			await terminal.waitForRender();
			tui.requestRender();
			await terminal.waitForRender();
			assert.equal(snapshots, 0);
			assert.equal(anchors, 0);
			assert.equal(editor.focused, false);
			terminal.sendInput("   ");
			await terminal.waitForRender();
			assert.equal(snapshots, 0);
			terminal.sendInput("needle");
			await terminal.waitForRender();
			assert.equal(snapshots, 1);
			assert.ok(terminal.getViewport().some((line) => line.includes("1/2")));
			assert.ok(!terminal.events.some((event) => event.type === "write" && event.data.includes("BODY-HIGHLIGHT")));
			assert.ok(!tui.getScreenLines().some((line) => line.includes("\x07\x1b[2J")));

			units = [...units, { id: "two", fragments: ["needle new completion"] }];
			tui.requestRender();
			await terminal.waitForRender();
			terminal.sendInput("\r");
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().some((line) => line.includes("2/2")));
			// Render-only text is excluded even when the original source has no match.
			terminal.sendInput("\x15");
			terminal.sendInput("render-only");
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().some((line) => line.includes("No matches")));
			// A changed query and clearing/retyping the same query still use the captured source.
			terminal.sendInput("\x15");
			terminal.sendInput("first");
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().some((line) => line.includes("1/1")));
			terminal.sendInput("\x15");
			await terminal.waitForRender();
			terminal.sendInput("first");
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().some((line) => line.includes("1/1")));
			assert.equal(snapshots, 1);
			tui.closeSearch();
			assert.equal(editor.focused, true);
			terminal.sendInput("x");
			assert.deepEqual(editor.inputs, ["x"]);
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("needle");
			await terminal.waitForRender();
			assert.equal(snapshots, 2);
			assert.ok(terminal.getViewport().some((line) => line.includes("1/3")));

			// Replacing only the provider on an unchanged root must not retain old matches.
			scroll.searchSource = { snapshot: () => [], getAnchorRow: () => undefined };
			tui.requestRender();
			await terminal.waitForRender();
			assert.equal(tui.hasOverlay(), false);
			assert.equal(editor.focused, true);
			scroll.searchSource = source;
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("needle");
			await terminal.waitForRender();
			assert.equal(snapshots, 3);
			tui.stop({ preserveScreen: true });
			assert.equal(tui.hasOverlay(), false);
			assert.equal(editor.focused, true);
			tui.start();
			await terminal.waitForRender();
			assert.equal(tui.hasOverlay(), false);
			terminal.sendInput("\x1b[102;6u");
			await terminal.waitForRender();
			assert.equal(snapshots, 3);
			terminal.sendInput("needle");
			await terminal.waitForRender();
			assert.equal(snapshots, 4);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("uses same-frame nested measurements at content width, retaining occurrences as anchors move or disappear", async () => {
		const terminal = new VirtualTerminal(80, 9);
		const tui = new TuiAltScreen(terminal);
		const document = new Container();
		const resources = new Text("resources\nnotice\nspacer", 0, 0);
		const chat = new Container();
		const preceding = new Text(Array.from({ length: 12 }, () => "earlier").join("\n"), 0, 0);
		const history = new Container();
		const heading = new Text("target heading", 0, 0);
		history.addChild(heading);
		chat.addChild(preceding);
		chat.addChild(history);
		chat.addChild(new Text(Array.from({ length: 20 }, () => "later").join("\n"), 0, 0));
		document.addChild(resources);
		document.addChild(chat);
		const scroll = new ScrollView(document, { primary: true, scrollbar: "always" });
		let available = true;
		let snapshots = 0;
		const widths: number[] = [];
		scroll.searchSource = {
			snapshot: () => {
				snapshots++;
				return [{ id: "target", fragments: ["needle first", "needle second"] }];
			},
			getAnchorRow: (id, width) => {
				assert.equal(id, "target");
				widths.push(width);
				if (!available) return undefined;
				const rows = [
					document.getChildRow(chat, width),
					chat.getChildRow(history, width),
					history.getChildRow(heading, width),
				];
				assert.ok(rows.every((row) => row !== undefined));
				return rows.reduce<number>((sum, row) => sum + row!, 0);
			},
		};
		tui.setLayoutRoot(scroll);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("needle");
			await terminal.waitForRender();
			assert.equal(scroll.scrollTop, 12); // 3 resource rows + 12 earlier rows - 3 rows of context.
			assert.ok(widths.every((width) => width === terminal.columns - 1));
			assert.ok(terminal.getViewport().some((line) => line.includes("1/2")));
			terminal.sendInput("\r");
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().some((line) => line.includes("2/2")));
			assert.ok(terminal.getViewport().some((line) => line.includes("needle second")));

			preceding.setText(Array.from({ length: 24 }, () => "expanded").join("\n"));
			tui.requestRender();
			await terminal.waitForRender();
			assert.equal(scroll.scrollTop, 24);
			assert.ok(terminal.getViewport().some((line) => line.includes("2/2")));
			assert.ok(terminal.getViewport().some((line) => line.includes("target heading")));
			available = false;
			tui.scrollToTop();
			terminal.sendInput("\r");
			await terminal.waitForRender();
			assert.equal(scroll.scrollTop, 0); // Undefined anchor never falls back to the previous target.
			assert.ok(terminal.getViewport().some((line) => line.includes("1/2")));
			available = true;
			resources.setText("r".repeat(90)); // Reflows to four rows at the new content width.
			widths.length = 0;
			terminal.resize(28, 9);
			await terminal.waitForRender();
			assert.ok(widths.length > 0 && widths.every((width) => width === terminal.columns - 1));
			assert.equal(scroll.scrollTop, 25);
			assert.ok(terminal.getViewport().every((line) => visibleWidth(line) <= 28));
			// The excerpt adds a row: clicking the actual bottom-row arrow still navigates.
			let viewport = terminal.getViewport();
			const row = viewport.findIndex((line) => line.includes("↑") && line.includes("↓"));
			const column = viewport[row]!.indexOf("↓");
			assert.ok(row >= 0 && column >= 0);
			terminal.sendInput(`\x1b[<35;${column + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${column + 1};${row + 1}M`);
			await terminal.waitForRender();
			viewport = terminal.getViewport();
			assert.ok(viewport.some((line) => line.includes("2/2")));
			terminal.sendInput("\x1b[13;2u");
			await terminal.waitForRender();
			assert.ok(terminal.getViewport().some((line) => line.includes("1/2")));
			assert.equal(snapshots, 1);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("reads child starts only from an existing same-width render without changing mouse hit testing", () => {
		const container = new Container();
		let renders = 0;
		const clicks: number[] = [];
		const first = {
			render: () => {
				renders++;
				return ["a", "b"];
			},
			invalidate: () => {},
		};
		const second = {
			render: () => {
				renders++;
				return ["c"];
			},
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				clicks.push(event.y);
				return { handled: true };
			},
		};
		container.addChild(first);
		container.addChild(second);
		assert.equal(container.getChildRow(second, 20), undefined);
		assert.equal(renders, 0);
		container.render(20);
		assert.equal(container.getChildRow(first, 20), 0);
		assert.equal(container.getChildRow(second, 20), 2);
		assert.equal(container.getChildRow(second, 19), undefined);
		container.handleMouse({
			type: "click",
			button: "left",
			x: 0,
			y: 2,
			screenX: 0,
			screenY: 2,
			width: 20,
			height: 3,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.deepEqual(clicks, [0]);
		assert.equal(renders, 2);
		container.removeChild(second);
		assert.equal(container.getChildRow(second, 20), undefined);
		assert.equal(renders, 2);
		container.render(30);
		assert.equal(container.getChildRow(first, 20), undefined);
		assert.equal(container.getChildRow(first, 30), 0);
	});
});

describe("source search frame and overlay ownership", () => {
	it("reveals offscreen source matches using one document render per query or reflow", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const tui = new TuiAltScreen(terminal);
		let renders = 0;
		class Transcript extends Container {
			override render(width: number): string[] {
				renders++;
				return super.render(width);
			}
		}
		const document = new Transcript();
		const before = new Text("x".repeat(1500), 0, 0);
		const first = new Text("first heading", 0, 0);
		const between = new Text(Array.from({ length: 30 }, () => "between").join("\n"), 0, 0);
		const second = new Text("second heading", 0, 0);
		document.addChild(before);
		document.addChild(first);
		document.addChild(between);
		document.addChild(second);
		document.addChild(new Text(Array.from({ length: 30 }, () => "after").join("\n"), 0, 0));
		const scroll = new ScrollView(document, { primary: true, scrollbar: "always" });
		const headings = new Map([
			["first", first],
			["second", second],
		]);
		let snapshots = 0;
		scroll.searchSource = {
			snapshot: () => {
				snapshots++;
				return [...headings.keys()].map((id) => ({ id, fragments: [`${id}needle`] }));
			},
			getAnchorRow: (id, width) => document.getChildRow(headings.get(id)!, width),
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: new Text("header", 0, 0), basis: 1 },
				{ component: scroll, grow: 1, basis: 0 },
				{ component: new Text("footer", 0, 0), basis: 1 },
			]),
		);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			await terminal.waitForRender();
			const assertRevealed = (id: string): void => {
				const anchor = document.getChildRow(headings.get(id)!, scroll.getContentWidth(terminal.columns))!;
				const screenRow = 1 + anchor - scroll.scrollTop;
				assert.ok(screenRow >= 1 && screenRow < terminal.rows - 1);
				assert.ok(terminal.getViewport()[screenRow]!.startsWith(`${id} heading`));
				assert.equal(terminal.getViewport()[0]!.trimEnd(), "header");
				assert.equal(terminal.getViewport().at(-1)!.trimEnd(), "footer");
				assert.equal(renders, 1, "search reveal must reuse the measured document, without a queued extra frame");
			};
			for (const id of ["first", "second"]) {
				renders = 0;
				terminal.sendInput("\x15");
				terminal.sendInput(`${id}needle`);
				await terminal.waitForRender();
				assertRevealed(id);
			}
			terminal.sendInput("\x15");
			terminal.sendInput("needle");
			await terminal.waitForRender();
			for (const id of ["first", "second"]) {
				renders = 0;
				terminal.sendInput("\r"); // Wrap to the first occurrence, then navigate back to the second.
				await terminal.waitForRender();
				assertRevealed(id);
			}
			renders = 0;
			terminal.resize(60, 10); // Reflows the prefix, moving the selected anchor below the old viewport.
			await terminal.waitForRender();
			assertRevealed("second");
			assert.equal(snapshots, 1);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("releases source search only when its overlay is removed through generic dismissal", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const tui = new TuiAltScreen(terminal);
		const editor = new InputOverlay();
		const scroll = new ScrollView(new Text("heading", 0, 0), { primary: true });
		let snapshots = 0;
		let anchors = 0;
		scroll.searchSource = {
			snapshot: () => [{ id: "unit", fragments: [`needle completion ${++snapshots}`] }],
			getAnchorRow: () => {
				anchors++;
				return 0;
			},
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, grow: 1, basis: 0 },
				{ component: editor, basis: 1 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const openSearch = async (): Promise<void> => {
				terminal.sendInput("\x1b[102;6u");
				terminal.sendInput("needle");
				await terminal.waitForRender();
				assert.equal(tui.hasOverlay(), true);
				assert.ok(terminal.getViewport().some((line) => line.includes(`needle completion ${snapshots}`)));
			};
			await openSearch();
			const other = new InputOverlay();
			tui.showOverlay(other);
			await terminal.waitForRender();
			tui.hideOverlay(); // Remove another overlay, not the search beneath it.
			await terminal.waitForRender();
			assert.equal(tui.hasOverlay(), true);
			assert.equal(other.focused, false);
			assert.equal(editor.focused, false);
			assert.equal(snapshots, 1);
			assert.ok(terminal.getViewport().some((line) => line.includes("needle completion 1")));

			const anchorsBeforeDismissal = anchors;
			tui.hideOverlay();
			await terminal.waitForRender();
			assert.equal(tui.hasOverlay(), false);
			assert.equal(editor.focused, true);
			assert.equal(anchors, anchorsBeforeDismissal, "dismissed search must no longer resolve retained matches");
			await openSearch(); // One shortcut must reopen with a fresh completed-source snapshot.
			assert.equal(snapshots, 2);
			tui.closeSearch();
			await terminal.waitForRender();
			assert.equal(editor.focused, true);
			await openSearch();
			assert.equal(snapshots, 3);
			tui.stop({ preserveScreen: true });
			assert.equal(tui.hasOverlay(), false);
			assert.equal(editor.focused, true);
			tui.start();
			await terminal.waitForRender();
			await openSearch();
			assert.equal(snapshots, 4);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});
});
