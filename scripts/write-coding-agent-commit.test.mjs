import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("records the source commit and clears stale metadata for source archives", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-commit-stamp-"));
	try {
		const scripts = join(directory, "scripts");
		const agent = join(directory, "packages/coding-agent");
		mkdirSync(scripts, { recursive: true });
		mkdirSync(join(agent, "src/utils"), { recursive: true });
		for (const path of ["scripts/write-coding-agent-commit.mjs", "packages/coding-agent/src/utils/build-commit.ts"]) {
			copyFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), join(directory, path));
		}
		// A minimal repository is enough for rev-parse: no project files or real user state change.
		mkdirSync(join(directory, ".git/objects"), { recursive: true });
		mkdirSync(join(directory, ".git/refs/heads"), { recursive: true });
		writeFileSync(join(directory, ".git/HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(directory, ".git/refs/heads/main"), "abcdef1234567890abcdef1234567890abcdef12\n");
		const run = () => {
			const result = spawnSync(process.execPath, [join(scripts, "write-coding-agent-commit.mjs")], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			return readFileSync(join(agent, "dist/commit"), "utf8");
		};
		assert.equal(run(), "abcdef12\n");
		rmSync(join(directory, ".git"), { recursive: true });
		assert.equal(run(), "\n");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
