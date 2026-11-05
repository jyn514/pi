import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getSourceCommit, readBuildCommit } from "../src/utils/build-commit.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

let directory: string | undefined;
afterEach(() => {
	vi.resetAllMocks();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

function createPackage(): string {
	directory = mkdtempSync(join(tmpdir(), "pi-build-commit-"));
	const packageDir = join(directory, "packages", "coding-agent");
	mkdirSync(join(packageDir, "dist"), { recursive: true });
	return packageDir;
}

describe("getSourceCommit", () => {
	test("uses the checkout rather than the current directory", () => {
		const packageDir = createPackage();
		mkdirSync(join(directory!, ".git"));
		vi.mocked(spawnSync).mockReturnValue({
			pid: 1,
			output: [],
			stdout: "abcdef12\n",
			stderr: "",
			status: 0,
			signal: null,
		});
		expect(getSourceCommit(packageDir)).toBe("abcdef12");
		expect(spawnSync).toHaveBeenCalledWith(
			"git",
			["-C", directory, "rev-parse", "--short=8", "HEAD"],
			expect.anything(),
		);
	});

	test("does not use a containing repository for an installed package", () => {
		expect(getSourceCommit(createPackage())).toBeUndefined();
		expect(spawnSync).not.toHaveBeenCalled();
	});

	test("falls back when Git fails or emits invalid output", () => {
		const packageDir = createPackage();
		mkdirSync(join(directory!, ".git"));
		for (const [status, stdout] of [
			[1, "abcdef12"],
			[0, "HEAD"],
			[0, ""],
		] as const) {
			vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], stdout, stderr: "", status, signal: null });
			expect(getSourceCommit(packageDir)).toBeUndefined();
		}
	});
});

describe("readBuildCommit", () => {
	test("reads a replacement stamp without Git or a release bump", () => {
		const packageDir = createPackage();
		writeFileSync(join(packageDir, "dist", "commit"), "abcdef12\n");
		expect(readBuildCommit(packageDir)).toBe("abcdef12");
		writeFileSync(join(packageDir, "dist", "commit"), "12345678\n");
		expect(readBuildCommit(packageDir)).toBe("12345678");
		expect(spawnSync).not.toHaveBeenCalled();
	});

	test("supports builds without commit metadata", () => {
		const packageDir = createPackage();
		expect(readBuildCommit(packageDir)).toBeUndefined();
		writeFileSync(join(packageDir, "dist", "commit"), "\n");
		expect(readBuildCommit(packageDir)).toBeUndefined();
		writeFileSync(join(packageDir, "dist", "commit"), "not a commit\n");
		expect(readBuildCommit(packageDir)).toBeUndefined();
	});
});
