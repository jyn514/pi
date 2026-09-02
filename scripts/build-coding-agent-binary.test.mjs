import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./build-coding-agent-binary.mjs", import.meta.url));
const compilerPreload = fileURLToPath(new URL("./fixtures/bun-compiler-preload.mjs", import.meta.url));

test("rejects bytecode failure even when Bun exits zero, preserving the diagnostic", () => {
	const diagnostic = "error: Failed to generate bytecode for ./cli.js\n";
	const result = spawnSync(process.execPath, ["--import", compilerPreload, driver, "--outfile", "unused"], {
		encoding: "utf8", env: { ...process.env, PI_COMPILER_DIAGNOSTIC: diagnostic },
	});
	assert.equal(result.status, 1);
	assert.equal(result.stderr, diagnostic);
});

test("preserves ordinary compiler failures and accepts successful compilation", () => {
	for (const status of [0, 2]) {
		const result = spawnSync(process.execPath, ["--import", compilerPreload, driver, "--outfile", "unused"], {
			encoding: "utf8", env: { ...process.env, PI_COMPILER_STATUS: String(status) },
		});
		assert.equal(result.status, status, result.stderr);
	}
});

test("restores the environment before config evaluation and propagates startup errors", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-bootstrap-"));
	try {
		writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "bootstrap-restored" }));
		for (const fail of [false, true]) {
			const result = spawnSync(process.execPath, [
				"--import", fileURLToPath(new URL("./fixtures/bun-bootstrap-preload.mjs", import.meta.url)),
				fileURLToPath(new URL("../packages/coding-agent/src/bun/cli.ts", import.meta.url)),
				...(fail ? ["--fail"] : []),
			], {
				cwd: directory, encoding: "utf8", timeout: 30000,
				env: { ...process.env, PI_BOOTSTRAP_PACKAGE: directory },
			});
			assert.equal(result.status, fail ? 1 : 0, result.stderr);
			assert.equal(result.stdout.trim(), "bootstrap-restored");
			if (fail) assert.match(result.stderr, /startup failure propagated/);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
