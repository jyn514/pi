import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("tool preview settings", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;
	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-preview-settings-"));
		agentDir = join(testDir, "agent");
		projectDir = join(testDir, "project");
		mkdirSync(agentDir);
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});
	afterEach(() => rmSync(testDir, { recursive: true, force: true }));
	describe("tool preview lines", () => {
		it.each([
			{ value: undefined, expected: undefined },
			{ value: 0, expected: 0 },
			{ value: 2, expected: 2 },
			{ value: 40, expected: 40 },
			{ value: -1, expected: undefined },
			{ value: 1.5, expected: undefined },
			{ value: "2", expected: undefined },
			{ value: null, expected: undefined },
			{ value: Number.MAX_SAFE_INTEGER + 1, expected: undefined },
		])("resolves $value to $expected", ({ value, expected }) => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ toolPreviewLines: value }));
			expect(SettingsManager.create(projectDir, agentDir).getToolPreviewLines()).toBe(expected);
		});

		it("applies project overrides and reloads external edits", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ toolPreviewLines: 3 }));
			const projectSettings = join(projectDir, ".pi", "settings.json");
			writeFileSync(projectSettings, JSON.stringify({ toolPreviewLines: 0 }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getToolPreviewLines()).toBe(0);

			writeFileSync(projectSettings, JSON.stringify({ toolPreviewLines: 1 }));
			await manager.reload();
			expect(manager.getToolPreviewLines()).toBe(1);

			writeFileSync(projectSettings, "{}");
			await manager.reload();
			expect(manager.getToolPreviewLines()).toBe(3);
		});
	});
});
