import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Run against a staged native binary, including its normal runtime assets.
const binary = process.env.PI_TEST_BINARY && resolve(process.env.PI_TEST_BINARY);
test("standalone binary loads extensions, assets and its embedded image worker outside the checkout", {
	skip: !binary,
}, () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-binary-"));
	try {
		const extension = join(directory, "extension.mjs");
		copyFileSync(new URL("./fixtures/bun-binary-extension.mjs", import.meta.url), extension);
		const env = {
			PATH: process.env.PATH, HOME: directory, USERPROFILE: directory,
			PI_CODING_AGENT_DIR: join(directory, "agent"), PI_OFFLINE: "1",
		};
		const version = spawnSync(binary, ["--version"], { cwd: directory, env, encoding: "utf8", timeout: 30000 });
		assert.equal(version.status, 0, version.stderr);
		assert.match(version.stdout, /^\d+\.\d+\.\d+/);
		const result = spawnSync(binary, ["--no-session", "--mode", "rpc", "-e", extension], {
			cwd: directory, env, encoding: "utf8", timeout: 30000,
			input: `${JSON.stringify({ type: "get_state", id: "smoke" })}\n`,
		});
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
		assert.match(result.stdout, /PI_BINARY_SMOKE_OK/);
		assert.match(result.stdout, /"id":"smoke".*"success":true/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
