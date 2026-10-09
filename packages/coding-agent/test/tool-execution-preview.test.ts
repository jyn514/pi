import { Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("configured tool results", () => {
	beforeAll(() => initTheme("dark"));
	test.each(["write", "edit"])("does not change %s call previews", (name) => {
		const args =
			name === "write"
				? { path: "notes.txt", content: "CALL_FIRST\nCALL_SECOND\nCALL_THIRD" }
				: { path: "notes.txt" };
		const result = {
			content: [],
			details: name === "edit" ? { diff: "+1 CALL_FIRST\n+2 CALL_SECOND\n+3 CALL_THIRD" } : undefined,
			isError: false,
		};
		const rendered = [undefined, 0, 1].map((toolPreviewLines) => {
			const component = new ToolExecutionComponent(
				name,
				"call-preview",
				args,
				{ toolPreviewLines },
				withBuiltInRenderers(name, undefined),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(result);
			return stripAnsi(component.render(120).join("\n"));
		});
		expect(rendered[0]).toContain("CALL_THIRD");
		expect(rendered[1]).toBe(rendered[0]);
		expect(rendered[2]).toBe(rendered[0]);
	});

	// Configured previews must also work without a renderer and after a renderer fails.
	// Expansion may change the component's framing, but must never discard the stored result.
	test.each(["missing definition", "missing renderer", "throwing renderer"])(
		"configures fallback output for a %s",
		(mode) => {
			const definition = mode === "missing definition" ? undefined : createBaseToolDefinition();
			if (definition && mode === "throwing renderer") {
				definition.renderResult = () => {
					throw new Error("renderer failure");
				};
			}
			const output = "preview-first\npreview-second\npreview-third";
			for (const toolPreviewLines of [0, 1, 2, 40]) {
				const component = new ToolExecutionComponent(
					"custom_tool",
					"tool-configured-fallback",
					{},
					{ toolPreviewLines },
					definition,
					createFakeTui(),
					process.cwd(),
				);
				for (const isPartial of [true, false]) {
					component.updateResult({ content: [{ type: "text", text: output }], isError: false }, isPartial);
					const collapsed = stripAnsi(component.render(120).join("\n"));
					expect(collapsed).toContain("custom_tool");
					for (const [index, line] of output.split("\n").entries()) {
						if (index < toolPreviewLines) expect(collapsed).toContain(line);
						else expect(collapsed).not.toContain(line);
					}
					if (toolPreviewLines < 3) expect(collapsed).toContain("to expand");
				}
				component.setExpanded(true);
				const expanded = stripAnsi(component.render(120).join("\n"));
				for (const line of output.split("\n")) expect(expanded).toContain(line);
				component.setExpanded(false);
				if (toolPreviewLines === 0)
					expect(stripAnsi(component.render(120).join("\n"))).not.toContain("preview-first");
			}
		},
	);

	test("passes the preview setting to custom renderers without clipping their output", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: (_result, options) =>
				new Text(`result preview=${options.toolPreviewLines}\ncustom output`, 0, 0),
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-custom-preview",
			{},
			{ toolPreviewLines: 0 },
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "stored output" }], isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("result preview=0");
		expect(rendered).toContain("custom output");
	});
});
