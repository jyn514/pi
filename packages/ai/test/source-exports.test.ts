import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const entries = [
	["@earendil-works/pi-ai", "index"],
	["@earendil-works/pi-ai/models", "models"],
	["@earendil-works/pi-ai/compat", "compat"],
	["@earendil-works/pi-ai/providers/faux", "providers/faux"],
	["@earendil-works/pi-ai/api/openai-completions", "api/openai-completions"],
	["@earendil-works/pi-ai/utils/validation", "utils/validation"],
	["@earendil-works/pi-ai/oauth", "oauth"],
	["@earendil-works/pi-ai/bedrock-provider", "bedrock-provider"],
	["@earendil-works/pi-ai/bun-oauth", "bun-oauth"],
];

describe.each([
	{ mode: "source", conditions: ["--conditions=source"], directory: "src", extension: "ts" },
	{ mode: "default", conditions: [], directory: "dist", extension: "js" },
])("$mode package exports", ({ conditions, directory, extension }) => {
	test.each(entries)("resolves %s", (specifier, entry) => {
		const result = spawnSync(
			process.execPath,
			[
				...conditions,
				"--input-type=module",
				"--eval",
				"console.log(import.meta.resolve(process.argv[1]))",
				specifier,
			],
			{ cwd: packageRoot, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
		);
		expect(result.status, result.stderr).toBe(0);
		const expected = new URL(`../${directory}/${entry}.${extension}`, import.meta.url);
		expect(result.stdout.trim()).toBe(expected.href);
		if (directory === "src") expect(existsSync(expected)).toBe(true);
	});
});

test("retains source compatibility registration side effects when bundled", async () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		dependencies: Record<string, string>;
	};
	const result = await build({
		absWorkingDir: packageRoot,
		stdin: {
			contents: 'import "@earendil-works/pi-ai/compat";',
			resolveDir: packageRoot,
			loader: "ts",
		},
		bundle: true,
		platform: "node",
		format: "esm",
		conditions: ["source"],
		external: Object.keys(manifest.dependencies),
		write: false,
		metafile: true,
		logLevel: "silent",
	});
	const emittedInputs = Object.values(result.metafile.outputs).flatMap((output) =>
		Object.entries(output.inputs)
			.filter(([, details]) => details.bytesInOutput > 0)
			.map(([path]) => path),
	);
	expect(result.warnings.filter((warning) => warning.id === "ignored-bare-import")).toEqual([]);
	expect(emittedInputs).toEqual(
		expect.arrayContaining(["src/compat.ts", "src/providers/images/register-builtins.ts"]),
	);
});
