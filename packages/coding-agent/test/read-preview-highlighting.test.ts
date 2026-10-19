import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Component, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { readRenderers } from "../src/core/tools/renderers/read.ts";
import { highlightCode, initTheme, Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function render(
	output: string | (TextContent | ImageContent)[],
	path: string,
	expanded: boolean,
	settings: { toolPreviewLines?: number; isError?: boolean; showImages?: boolean } = { toolPreviewLines: 3 },
): Component {
	const context: ToolRenderContext<Record<string, unknown>> = {
		args: { path },
		toolCallId: "read-preview-highlighting",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: settings.showImages ?? false,
		outputPadY: 0,
		outputPad: 0,
		isError: settings.isError ?? false,
		durationMs: undefined,
	};
	return readRenderers.renderResult!(
		{ content: typeof output === "string" ? [{ type: "text", text: output }] : output, details: undefined },
		{ expanded, isPartial: false, toolPreviewLines: settings.toolPreviewLines },
		theme,
		context,
	);
}

beforeAll(() => initTheme("dark"));
afterEach(() => {
	vi.restoreAllMocks();
	resetCapabilitiesCache();
});

describe.each([
	{ path: "example.js", language: "javascript" },
	{ path: "example.ts", language: "typescript" },
])("read preview syntax context for $path", ({ path, language }) => {
	test.each([0, 20])("hidden colon after %s blank lines still colors the visible property", (blankLines) => {
		// A valid object property may put its colon arbitrarily far beyond the preview boundary.
		// Prefix-only highlighting loses this lookahead, even when multiline lexical state is kept.
		const prefix = "const obj = {\n  before: 0,\n  answer";
		const output = `${prefix}\n${"\n".repeat(blankLines)}: 42\n};`;
		const property = theme.fg("syntaxVariable", "answer");
		expect(highlightCode(output, language)[2]).toContain(property);
		expect(highlightCode(prefix, language)[2]).not.toContain(property);

		const collapsed = render(output, path, false).render(120).join("\n");
		expect(collapsed).toContain(property);
		expect(stripAnsi(collapsed)).toContain(`(${blankLines + 2} more lines,`);
		expect(stripAnsi(collapsed)).not.toContain(": 42");

		const expanded = render(output, path, true).render(120).join("\n");
		expect(expanded).toContain(property);
		expect(stripAnsi(expanded)).toContain(": 42");
		expect(stripAnsi(expanded)).toContain("};");
		expect(stripAnsi(expanded)).not.toContain("more lines");
	});
});

test("collapsed multiline strings format only visible lines, and expansion formats the hidden tail", () => {
	const output = '"""\nvisible <&>\n\nHIDDEN_TAIL\n"""';
	const fg = vi.spyOn(Theme.prototype, "fg");
	const collapsed = render(output, "example.py", false).render(120).join("\n");
	expect(collapsed).toContain(theme.fg("syntaxString", "visible <&>"));
	expect(stripAnsi(collapsed)).toContain("(2 more lines,");
	expect(fg.mock.calls.some(([token, text]) => token === "syntaxString" && text.includes("HIDDEN_TAIL"))).toBe(false);

	fg.mockClear();
	const expanded = render(output, "example.py", true).render(120).join("\n");
	expect(fg.mock.calls.some(([token, text]) => token === "syntaxString" && text.includes("HIDDEN_TAIL"))).toBe(true);
	expect(expanded).toContain(theme.fg("syntaxString", "HIDDEN_TAIL"));
	expect(stripAnsi(expanded)).not.toContain("more lines");
});

test.each([0, 1, 3, 10])("preview budget %s excludes trailing empty lines from hidden count", (budget) => {
	const output = "const first = 1;\n\nconst last = 2;\n\n";
	const collapsed = render(output, "example.ts", false, { toolPreviewLines: budget }).render(120).join("\n");
	const plain = stripAnsi(collapsed);
	if (budget < 3) expect(plain).toContain(`(${3 - budget} more lines,`);
	else expect(plain).not.toContain("more lines");
	expect(plain.includes("const first")).toBe(budget > 0);
	expect(plain.includes("const last")).toBe(budget >= 3);
});

test.each(["", "\n\n"])("empty output %j remains hidden even with a preview budget", (output) => {
	expect(render(output, "example.ts", false).render(120)).toEqual([]);
});

test("default successful reads stay hidden, zero does no syntax formatting, and errors remain plain", () => {
	const output = Array.from({ length: 12 }, (_, index) => `const line${index} = ${index};`).join("\n");
	const fg = vi.spyOn(Theme.prototype, "fg");
	expect(render(output, "example.ts", false, {}).render(120)).toEqual([]);
	const zero = render(output, "example.ts", false, { toolPreviewLines: 0 }).render(120).join("\n");
	expect(stripAnsi(zero)).toContain("(12 more lines,");
	expect(fg.mock.calls.some(([token]) => token.startsWith("syntax"))).toBe(false);

	const error = render(output, "example.ts", false, { isError: true }).render(120).join("\n");
	expect(error).toContain(theme.fg("toolOutput", "const line0 = 0;"));
	expect(stripAnsi(error)).toContain("(2 more lines,");
	expect(stripAnsi(error)).not.toContain("const line10");
	expect(fg.mock.calls.some(([token]) => token.startsWith("syntax"))).toBe(false);
});

test.each([false, true])("image fallback participates in preview counts when showImages is %s", (showImages) => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	const content: (TextContent | ImageContent)[] = [
		{ type: "text", text: "const value = 1;" },
		{ type: "image", mimeType: "image/png", data: "" },
	];
	const collapsed = stripAnsi(
		render(content, "example.ts", false, { toolPreviewLines: 1, showImages }).render(120).join("\n"),
	);
	expect(collapsed).toContain("const value = 1;");
	expect(collapsed).not.toContain("[Image:");
	expect(collapsed.includes("(1 more lines,")).toBe(!showImages);
	const expanded = stripAnsi(render(content, "example.ts", true, { showImages }).render(120).join("\n"));
	expect(expanded.includes("[Image: [image/png]]")).toBe(!showImages);
	expect(expanded).not.toContain("more lines");
});

test("unsupported-language fallback retains its existing colored trailing blanks", () => {
	const output = "first\n\nlast\n\n";
	const fallbackLines = highlightCode(output, "toml");
	// The fallback colors even empty lines, unlike registered grammars. Those lines historically
	// count toward the preview and must not disappear merely because counting now precedes coloring.
	expect(fallbackLines.at(-1)).not.toBe("");
	const collapsed = stripAnsi(render(output, "example.toml", false, { toolPreviewLines: 3 }).render(120).join("\n"));
	expect(collapsed).toContain("(2 more lines,");
});
