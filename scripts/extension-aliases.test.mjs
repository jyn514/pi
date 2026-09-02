import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("installed Node aliases preserve import export conditions without workspace siblings", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-aliases-"));
	try {
		const destination = join(directory, "dist/core/extensions");
		mkdirSync(destination, { recursive: true });
		const source = new URL("../packages/coding-agent/src/core/extensions/aliases.ts", import.meta.url);
		copyFileSync(source, join(destination, "aliases.ts"));
		assert.deepEqual(readFileSync(join(destination, "aliases.ts")), readFileSync(source));
		writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
		for (const name of ["@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "@earendil-works/pi-ai", "typebox"]) {
			const packageDir = join(directory, "node_modules", name);
			mkdirSync(packageDir, { recursive: true });
			const conditions = { import: "./import.js", require: "./require.cjs" };
			writeFileSync(join(packageDir, "package.json"), JSON.stringify({
				name, type: "module", exports: { ".": conditions, "./*": conditions },
			}));
			writeFileSync(join(packageDir, "import.js"), "");
			writeFileSync(join(packageDir, "require.cjs"), "");
		}
		const probe = join(directory, "probe.mjs");
		copyFileSync(new URL("./fixtures/extension-aliases.mjs", import.meta.url), probe);
		const result = spawnSync(process.execPath, [probe], { cwd: directory, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
