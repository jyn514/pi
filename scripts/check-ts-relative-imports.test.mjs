import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-ts-relative-imports.mjs", import.meta.url));

test("ignores artifact copies while still checking maintained TypeScript imports", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-check-ts-imports-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "src"));
	mkdirSync(join(root, ".artifacts", "experiment"), { recursive: true });
	writeFileSync(join(root, ".artifacts", "experiment", "copy.ts"), 'import "./ignored.js";\n');
	const maintained = join(root, "src", "maintained.ts");
	writeFileSync(maintained, "export const value = 1;\n");

	const ignored = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
	assert.equal(ignored.status, 0, ignored.stderr);

	writeFileSync(maintained, 'import "./invalid.js";\n');
	const checked = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
	assert.equal(checked.status, 1, checked.stderr);
	assert.match(checked.stderr, /src\/maintained\.ts:1:\d+: \.\/invalid\.js/);
	assert.doesNotMatch(checked.stderr, /\.artifacts|ignored\.js/);
});
