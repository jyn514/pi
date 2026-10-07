import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const biome = fileURLToPath(new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url));
const rule = fileURLToPath(new URL("./biome/model-type-comparison.grit", import.meta.url));

async function lint(t, source) {
	const root = await mkdtemp(join(tmpdir(), "pi-model-type-comparison-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "biome.json"), JSON.stringify({
		linter: { rules: { recommended: false } },
		plugins: [rule],
	}));
	await writeFile(join(root, "sample.ts"), source);
	const result = spawnSync(process.execPath, [biome, "lint", "--error-on-warnings", "--reporter=json", "sample.ts"], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.error, undefined);
	assert.ok(result.status === 0 || result.status === 1, result.stderr);
	const { diagnostics } = JSON.parse(result.stdout);
	return { status: result.status, diagnostics };
}

async function assertComparisons(t, source, comparisons) {
	const { status, diagnostics } = await lint(t, source);
	assert.equal(status, comparisons.length ? 1 : 0);
	assert.equal(diagnostics.length, comparisons.length);
	assert.deepEqual(diagnostics.map(({ location: { span } }) => source.slice(...span)).sort(), comparisons.toSorted());
	for (const diagnostic of diagnostics) {
		assert.match(diagnostic.description, /Chat models may omit type\. Use isModelType\(model, 'chat'\) or getModelType\(model\)/);
	}
}

// Distinct receivers and duplicate occurrences must not share Grit match bindings.
test("reports every supported comparison, including repeated expressions", async (t) => {
	const comparisons = [
		'first.type === "chat"',
		'second.type !== "chat"',
		'third.type == "chat"',
		'fourth.type != "chat"',
		'"chat" === fifth.type',
		'"chat" !== sixth.type',
		'first.type === "chat"',
	];
	await assertComparisons(t, comparisons.map((comparison) => `if (${comparison}) action();`).join("\n"), comparisons);
});

test("preserves single quotes, trivia, complex receivers, and nested comparisons", async (t) => {
	const comparisons = [
		"models[0].type === 'chat'",
		"lookup(). /* member */ type\n!== /* value */ 'chat'",
		"'chat' === current.model.type",
		"nested.type == 'chat'",
	];
	const source = `if (${comparisons[0]} && (${comparisons[1]})) action();\nconst value = ${comparisons[2]} ? (${comparisons[3]}) : false;`;
	await assertComparisons(t, source, comparisons);
});

for (const [name, source] of [
	["without chat", 'if (model.type === "image") action();'],
	["without type", 'if (model.name === "chat") action();'],
	["with both words but no forbidden comparison", `
// model.type === "chat"
const example = 'model.type === "chat"';
isModelType(model, "chat");
getModelType(model) === "chat";
model.type === "image";
model.name === "chat";
model.type = "chat";
model.type > "chat";
`],
]) {
	test(`accepts source ${name}`, async (t) => {
		await assertComparisons(t, source, []);
	});
}
