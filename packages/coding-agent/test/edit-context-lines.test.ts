import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { TUI } from "@earendil-works/pi-tui";
import { Compile } from "typebox/compile";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";
import { createEditTool, createEditToolDefinition, type EditToolInput } from "../src/core/tools/edit.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// These tests allow diff formatting to change, but catch a count lost between settings,
// tool construction, preview generation and result generation (including after reload).
const lines = Array.from({ length: 61 }, (_, index) => `CONTEXT_${index}_END`);
const targets = [20, 40];
const edits = targets.map((index) => ({ oldText: lines[index], newText: `CHANGED_${index}_END` }));

function expectContext(text: string, count: number): void {
	for (const [index, line] of lines.entries()) {
		if (targets.includes(index)) continue;
		const visible = targets.some((target) => Math.abs(index - target) <= count);
		expect(text.includes(line), line).toBe(visible);
	}
	for (const target of targets) expect(text).toContain(`CHANGED_${target}_END`);
}

describe("edit context lines", () => {
	let dir: string;
	let agentDir: string;
	let session: AgentSession | undefined;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-edit-context-"));
		agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		mkdirSync(join(dir, ".pi"));
	});
	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	async function startSession() {
		const settingsManager = SettingsManager.create(dir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager });
		await resourceLoader.reload();
		({ session } = await createAgentSession({
			cwd: dir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(dir),
			resourceLoader,
		}));
		return session;
	}

	async function editWithPreview(activeSession: AgentSession, count: number) {
		const path = join(dir, "file.txt");
		writeFileSync(path, `${lines.join("\n")}\n`);
		const args: EditToolInput = { path: "file.txt", edits };
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"edit",
			"edit-context",
			args,
			{},
			activeSession.getToolDefinition("edit"),
			{ requestRender } as unknown as TUI,
			dir,
		);
		component.setArgsComplete();
		await vi.waitFor(() => expect(stripAnsi(component.render(160).join("\n"))).toContain("CHANGED_20_END"));
		const preview = stripAnsi(component.render(160).join("\n"));
		expectContext(preview, count);

		const tool = activeSession.agent.state.tools.find((tool) => tool.name === "edit")!;
		const result = await tool.execute("edit-context", args);
		component.updateResult({ ...result, isError: false }, false);
		const settled = stripAnsi(component.render(160).join("\n"));
		expectContext(settled, count);
		expect(settled).toBe(preview);
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 2 block(s) in file.txt." }]);
		const expectedLines = lines.map((line, index) => (targets.includes(index) ? `CHANGED_${index}_END` : line));
		expect(readFileSync(path, "utf8")).toBe(`${expectedLines.join("\n")}\n`);
		return result;
	}

	it.each([
		{ value: undefined, expected: 4 },
		{ value: 0, expected: 0 },
		{ value: 1, expected: 1 },
		{ value: 8, expected: 8 },
	])("uses $value for both previews and completed edits", async ({ value, expected }) => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ editContextLines: value }));
		await editWithPreview(await startSession(), expected);
	});

	it("applies project overrides and rebuilds both paths on reload without changing the patch", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ editContextLines: 8 }));
		const projectSettings = join(dir, ".pi", "settings.json");
		writeFileSync(projectSettings, JSON.stringify({ editContextLines: 0 }));
		const activeSession = await startSession();
		const zeroResult = await editWithPreview(activeSession, 0);

		writeFileSync(projectSettings, JSON.stringify({ editContextLines: 1 }));
		await activeSession.reload();
		const oneResult = await editWithPreview(activeSession, 1);

		writeFileSync(projectSettings, "{}");
		await activeSession.reload();
		const inheritedResult = await editWithPreview(activeSession, 8);
		expect(zeroResult.details).toMatchObject({ patch: expect.any(String), firstChangedLine: 21 });
		expect(oneResult.details).toMatchObject({ patch: zeroResult.details.patch, firstChangedLine: 21 });
		expect(inheritedResult.details).toMatchObject({ patch: zeroResult.details.patch, firstChangedLine: 21 });

		// Replaying a recorded result must not recompute its context from the current file or setting.
		rmSync(join(dir, "file.txt"));
		const replay = new ToolExecutionComponent(
			"edit",
			"recorded-edit",
			{ path: "file.txt", edits },
			{},
			activeSession.getToolDefinition("edit"),
			{ requestRender: () => {} } as unknown as TUI,
			dir,
		);
		replay.updateResult({ ...zeroResult, isError: false }, false);
		expectContext(stripAnsi(replay.render(160).join("\n")), 0);
	});

	it.each([-1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1])(
		"rejects %s in the schema and falls back to the default at runtime",
		(value) => {
			expect(Compile(SettingsSchema).Check({ editContextLines: value })).toBe(false);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ editContextLines: value }));
			expect(SettingsManager.create(dir, agentDir).getEditContextLines()).toBe(4);
		},
	);

	it.each([0, 1, 8, Number.MAX_SAFE_INTEGER])("accepts %s in the schema and settings", (editContextLines) => {
		expect(Compile(SettingsSchema).Check({ editContextLines })).toBe(true);
		expect(SettingsManager.inMemory({ editContextLines }).getEditContextLines()).toBe(editContextLines);
	});

	it.each([undefined, 0, 1, 8])(
		"lets SDK callers configure context %s without changing edit behavior",
		async (contextLines) => {
			writeFileSync(join(dir, "file.txt"), lines.join("\n"));
			const tool = createEditTool(dir, { contextLines });
			const result = await tool.execute("sdk-edit", { path: "file.txt", edits });
			expect(result.details).toMatchObject({ diff: expect.any(String) });
			const { diff } = result.details as { diff: string };
			expectContext(diff, contextLines ?? 4);
		},
	);

	it.each([-1, 0.5, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid SDK context %s before editing",
		(contextLines) => {
			expect(() => createEditToolDefinition(dir, { contextLines })).toThrow("non-negative safe integer");
		},
	);
});
