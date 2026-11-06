import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-ts-relative-imports.mjs", import.meta.url));
const failurePreload = fileURLToPath(new URL("./fixtures/check-ts-relative-imports-failure.mjs", import.meta.url));

test("ignores artifact copies while still checking maintained TypeScript imports", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-check-ts-imports-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "src"));
	for (const directory of [".artifacts", "target", "work"]) {
		mkdirSync(join(root, directory, "experiment"), { recursive: true });
		writeFileSync(join(root, directory, "experiment", "copy.ts"), 'import "./ignored.js";\n');
	}
	const maintained = join(root, "src", "maintained.ts");
	writeFileSync(maintained, "export const value = 1;\n");

	const ignored = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
	assert.equal(ignored.status, 0, ignored.stderr);

	writeFileSync(maintained, 'import "./invalid.js";\n');
	const checked = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
	assert.equal(checked.status, 1, checked.stderr);
	assert.match(checked.stderr, /src\/maintained\.ts:1:\d+: \.\/invalid\.js/);
	assert.doesNotMatch(checked.stderr, /\.artifacts|target|work|ignored\.js/);
});

test("still checks nested source directories named target and work", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-check-ts-imports-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const directory of ["target", "work"]) {
		mkdirSync(join(root, "src", directory), { recursive: true });
		writeFileSync(join(root, "src", directory, "maintained.ts"), 'export * from "./invalid.js";\n');
	}

	const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 1, result.stderr);
	for (const directory of ["target", "work"]) {
		assert.ok(result.stderr.includes(`src/${directory}/maintained.ts:1:`), result.stderr);
	}
});

for (const failure of ["parse", "cleanup"]) {
	test(`reports the ${failure} failure without masking it during cleanup`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "pi-check-ts-imports-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		writeFileSync(join(root, "maintained.ts"), "export const value = 1;\n");
		const result = spawnSync(process.execPath, ["--import", failurePreload, checker], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, CHECK_TS_TEST_FAILURE: failure },
		});

		assert.equal(result.status, 1, result.stderr);
		if (failure === "parse") {
			assert.match(result.stderr, /simulated parse failure/);
			assert.doesNotMatch(result.stderr, /simulated cleanup EPIPE/);
		} else {
			assert.match(result.stderr, /simulated cleanup EPIPE/);
		}
	});
}
