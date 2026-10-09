import { type Component, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { createAllToolRenderers, withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { truncateTail } from "../src/core/tools/truncate.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const renderers = createAllToolRenderers();
const output = Array.from({ length: 30 }, (_, index) => `BODY_${String(index + 1).padStart(2, "0")}`).join("\n");

function context(expanded = false): ToolRenderContext<Record<string, unknown>> {
	return {
		args: { path: "notes.txt", pattern: "needle", command: "generate" },
		toolCallId: "preview-test",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		outputPadY: 0,
		outputPad: 0,
		isError: false,
		durationMs: 4200,
	};
}

function plain(component: Component, width = 160): string {
	return stripAnsi(component.render(width).join("\n"));
}

// Expected defaults are existing user-facing behavior; overrides come from the setting contract.
const cases = [
	{ name: "bash", defaultCount: 5, tail: true },
	{ name: "powershell", defaultCount: 5, tail: true },
	{ name: "grep", defaultCount: 15, tail: false },
	{ name: "find", defaultCount: 20, tail: false },
	{ name: "ls", defaultCount: 20, tail: false },
	{ name: "read", defaultCount: 10, tail: false },
] as const;

function preview(
	name: (typeof cases)[number]["name"],
	ctx: ToolRenderContext<Record<string, unknown>>,
	toolPreviewLines?: number,
): Component {
	return renderers[name].renderResult!(
		{ content: [{ type: "text", text: output }], details: undefined },
		{ expanded: ctx.expanded, isPartial: ctx.isPartial, toolPreviewLines },
		theme,
		ctx,
	);
}

beforeAll(() => initTheme("dark"));

describe.each(cases)("$name result preview budget", ({ name, defaultCount, tail }) => {
	test.each([undefined, 0, 1, 3, 40, Number.MAX_SAFE_INTEGER])("collapsed setting %s", (limit) => {
		const ctx = context();
		// Successful reads are hidden by default; the legacy ten-line budget is for errors.
		ctx.isError = name === "read";
		const rendered = plain(preview(name, ctx, limit));
		const count = Math.min(limit ?? defaultCount, 30);
		const expected = Array.from(
			{ length: count },
			(_, index) => `BODY_${String(tail ? 31 - count + index : index + 1).padStart(2, "0")}`,
		);
		expect(rendered.match(/BODY_\d+/g) ?? []).toEqual(expected);
		if (count < 30) expect(rendered).toContain("to expand");
		else expect(rendered).not.toContain("to expand");
	});

	test.each([undefined, 0, 1, 40])("expanded ignores setting %s", (limit) => {
		const rendered = plain(preview(name, context(true), limit));
		expect(rendered.match(/BODY_\d+/g)).toHaveLength(30);
		expect(rendered).not.toContain("to expand");
	});
});

test.each(["notes.txt", "notes.ts", ".pi/AGENTS.md", "example/SKILL.md"])(
	"successful read of %s preserves compact default but accepts an explicit preview",
	(path) => {
		for (const limit of [undefined, 0, 2]) {
			const ctx = context();
			ctx.args = { path };
			const rendered = plain(preview("read", ctx, limit));
			expect(rendered.match(/BODY_\d+/g) ?? []).toEqual(limit === 2 ? ["BODY_01", "BODY_02"] : []);
			if (limit !== undefined) expect(rendered).toContain("to expand");
		}
	},
);

test.each(cases)("$name keeps truncation warnings at zero", ({ name }) => {
	const ctx = context();
	const result = {
		content: [{ type: "text" as const, text: output }],
		details: {
			truncation: truncateTail(output, { maxLines: 20 }),
			fullOutputPath: "/tmp/full-output.log",
			matchLimitReached: 30,
			resultLimitReached: 30,
			entryLimitReached: 30,
			linesTruncated: true,
		},
	};
	const rendered = plain(
		renderers[name].renderResult!(result, { expanded: false, isPartial: false, toolPreviewLines: 0 }, theme, ctx),
	);
	expect(rendered).not.toContain("BODY_");
	expect(rendered).toContain("Truncated:");
	expect(rendered).toContain("to expand");
	if (name === "bash" || name === "powershell") {
		expect(rendered).toContain("Full output: /tmp/full-output.log");
		expect(rendered).toContain("Took 4.2s");
	}
});

test.each(["bash", "powershell"] as const)("%s limits visual lines and hides wrapped output at zero", (name) => {
	const text = `HEAD ${"word ".repeat(30)}TAIL`;
	const ctx = context();
	const result = { content: [{ type: "text" as const, text }], details: undefined };
	const renderer = renderers[name].renderResult!;
	const component = renderer(result, { expanded: false, isPartial: true, toolPreviewLines: 2 }, theme, ctx);
	const narrow = plain(component, 20);
	expect(narrow).toContain("TAIL");
	expect(narrow).not.toContain("HEAD");
	expect(component.render(20)).toHaveLength(3); // Two body rows plus expansion hint.
	ctx.lastComponent = component;
	for (const isPartial of [true, false]) {
		const hidden = renderer(result, { expanded: false, isPartial, toolPreviewLines: 0 }, theme, ctx);
		for (const width of [20, 160, 20]) {
			const rendered = plain(hidden, width);
			expect(rendered).not.toContain("word");
			expect(rendered).not.toContain("TAIL");
			expect(rendered).not.toContain("HEAD");
		}
	}
});

test("custom renderer slots are not clipped or replaced by built-in preview policy", () => {
	const custom = {
		renderCall: () => new Text(output, 0, 0),
		renderResult: () => new Text(output, 0, 0),
	};
	const merged = withBuiltInRenderers("bash", custom)!;
	const ctx = context();
	expect(plain(merged.renderCall!(ctx.args, theme, ctx))).toContain("BODY_30");
	expect(
		plain(
			merged.renderResult!(
				{ content: [], details: undefined },
				{ expanded: false, isPartial: false, toolPreviewLines: 0 },
				theme,
				ctx,
			),
		),
	).toContain("BODY_30");
});
