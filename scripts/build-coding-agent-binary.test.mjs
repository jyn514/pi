import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./build-coding-agent-binary.mjs", import.meta.url));
const compilerPreload = fileURLToPath(new URL("./fixtures/bun-compiler-preload.mjs", import.meta.url));

// Preserve cwd dotenv isolation when the bytecode driver replaces the build commands (#10473).
test("compiles import-only bytecode without loading cwd dotenv", (t) => {
	const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
	if (bun.error?.code === "ENOENT") return t.skip("Bun is required for the compiler regression");
	assert.equal(bun.status, 0, bun.stderr);
	const directory = mkdtempSync(join(tmpdir(), "pi-bytecode-"));
	try {
		const scripts = join(directory, "scripts");
		const agent = join(directory, "packages/coding-agent");
		for (const path of [scripts, join(agent, "dist/bun"), join(agent, "src/utils"), join(agent, "src/extensions/codemode"), join(agent, "node_modules/resolution-fixture")]) {
			mkdirSync(path, { recursive: true });
		}
		copyFileSync(driver, join(scripts, "build-coding-agent-binary.mjs"));
		writeFileSync(join(agent, "node_modules/resolution-fixture/package.json"), JSON.stringify({
			name: "resolution-fixture", type: "module", exports: { import: "./index.js" },
		}));
		writeFileSync(join(agent, "node_modules/resolution-fixture/index.js"), "export const value = 42;\n");
		writeFileSync(join(agent, "dist/bun/cli.js"), 'import { value } from "resolution-fixture";\nconsole.log(value, import.meta.resolve("node:fs"), process.env.PI_BYTECODE_TEST_DOTENV ?? "unset");\n');
		writeFileSync(join(directory, ".env"), "PI_BYTECODE_TEST_DOTENV=leaked\n");
		writeFileSync(join(agent, "src/utils/image-resize-worker.ts"), "export {};\n");
		writeFileSync(join(agent, "src/extensions/codemode/worker.ts"), "export {};\n");
		const binary = join(directory, process.platform === "win32" ? "pi.exe" : "pi");
		const build = spawnSync(process.execPath, [join(scripts, "build-coding-agent-binary.mjs"), "--outfile", binary], {
			encoding: "utf8", timeout: 60000,
		});
		assert.equal(build.status, 0, build.stdout + build.stderr);
		const run = spawnSync(binary, [], {
			cwd: directory,
			env: { ...process.env, PI_BYTECODE_TEST_DOTENV: undefined },
			encoding: "utf8", timeout: 30000,
		});
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout.trim(), "42 node:fs unset");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

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
