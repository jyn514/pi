import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./biome-check.mjs", import.meta.url));

async function check(t, vcsEnabled, source) {
	const root = await mkdtemp(join(tmpdir(), "pi-biome-wasm-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "packages/example/src"), { recursive: true });
	await writeFile(join(root, "packages/example/src/index.ts"), source);
	await writeFile(
		join(root, "biome.json"),
		JSON.stringify({
			vcs: { enabled: vcsEnabled, clientKind: "git", useIgnoreFile: true },
			files: { includes: ["packages/*/src/**/*.ts"] },
			formatter: { indentStyle: "space", indentWidth: 4 },
			linter: { rules: { recommended: true, style: { noNonNullAssertion: "off" } } },
		}),
	);
	const preloader = join(root, "android.mjs");
	await writeFile(
		preloader,
		`import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
Object.defineProperty(process, "platform", { value: "android" });
const original = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => {
	if (command === "git" && args[0] === "ls-files") return "packages/example/src/index.ts\\0";
	return original(command, args, options);
};
syncBuiltinESMExports();
`,
	);
	return spawnSync(process.execPath, ["--import", preloader, script], { cwd: root, encoding: "utf8" });
}

for (const vcsEnabled of [false, true]) {
	test(`WASM preserves lint and formatting settings with VCS ${vcsEnabled ? "enabled" : "disabled"}`, async (t) => {
		const result = await check(
			t,
			vcsEnabled,
			'const values = ["ok"];\nif (values.length > 0) {\n    console.log(values[0]!);\n}\n',
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Biome WASM: checked 1 files; 0 diagnostics\./);
	});
}

test("WASM still rejects source violations when VCS integration is enabled", async (t) => {
	const result = await check(t, true, "debugger;\n");
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /lint\/suspicious\/noDebugger/);
});
