import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../test.sh", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/test-runner-env.mjs", import.meta.url));

test("test runner retains the ripgrep backend without inheriting credentials", { skip: process.platform === "win32" }, () => {
	const root = mkdtempSync(join(tmpdir(), "pi-test-runner-env-"));
	try {
		const bin = join(root, "bin");
		const home = join(root, "home");
		mkdirSync(bin);
		mkdirSync(home);
		const npm = join(bin, "npm");
		copyFileSync(fixture, npm);
		assert.deepEqual(readFileSync(npm), readFileSync(fixture));
		chmodSync(npm, 0o755);
		const result = spawnSync("bash", [runner], {
			encoding: "utf8",
			env: {
				PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
				HOME: home,
				TMPDIR: root,
				RG_REAL: process.execPath,
				ANTHROPIC_API_KEY: "test-only-key",
				TEST_RUNNER_SECRET: "test-only-secret",
			},
		});
		assert.equal(result.status, 0, result.stderr);
		const output = JSON.parse(result.stdout.trim().split("\n").at(-1));
		assert.equal(output.rgReal, process.execPath);
		assert.equal(output.anthropicKey, undefined);
		assert.equal(output.unlistedSecret, undefined);
		assert.notEqual(output.home, home);
		assert.equal(existsSync(output.home), false, "isolated home is removed after the runner exits");
		assert.equal(existsSync(home), true, "caller home remains untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
