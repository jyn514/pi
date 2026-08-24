import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installPinnedModelData } from "../scripts/hydrate-pinned-model-data.ts";
import { createModelDataManifest, type ModelDataStructure } from "../scripts/model-data.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createFixture(artifactVersion = "1.2.3") {
	const root = mkdtempSync(join(tmpdir(), "pi-pinned-model-data-"));
	temporaryRoots.push(root);
	const packageRoot = join(root, "source");
	const artifactRoot = join(root, "artifact");
	const providersDir = join(packageRoot, "src", "providers");
	const artifactDataDir = join(artifactRoot, "dist", "providers", "data");
	mkdirSync(join(providersDir, "data"), { recursive: true });
	mkdirSync(artifactDataDir, { recursive: true });
	writeFileSync(join(packageRoot, "package.json"), '{"version":"1.2.3"}\n');
	writeFileSync(join(artifactRoot, "package.json"), `${JSON.stringify({ version: artifactVersion })}\n`);
	writeFileSync(
		join(packageRoot, "src", "models.generated.ts"),
		'import { TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\n',
	);
	writeFileSync(join(providersDir, "test-provider.models.ts"), "export const TEST_PROVIDER_MODELS = {};\n");
	writeFileSync(join(providersDir, "data", "sentinel"), "original\n");

	const structure: ModelDataStructure = { "test-provider": { "model-a": "openai-completions" } };
	const content = `${JSON.stringify({
		"openai-completions": {
			"model-a": {
				id: "model-a",
				name: "Model A",
				api: "openai-completions",
				provider: "test-provider",
				baseUrl: "https://example.test/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			},
		},
	})}\n`;
	writeFileSync(join(artifactDataDir, "test-provider.json"), content);
	writeFileSync(
		join(artifactDataDir, ".manifest.json"),
		`${JSON.stringify(createModelDataManifest(structure, { "test-provider.json": content }, "2026-08-29T00:00:00Z"))}\n`,
	);
	return { artifactRoot, packageRoot };
}

describe("pinned model data hydration", () => {
	it("replaces generated data with a validated package snapshot", () => {
		const fixture = createFixture();

		installPinnedModelData(fixture);

		const dataDir = join(fixture.packageRoot, "src", "providers", "data");
		expect(readFileSync(join(dataDir, "test-provider.json"), "utf8")).toContain('"model-a"');
		expect(() => readFileSync(join(dataDir, "sentinel"), "utf8")).toThrow();
	});

	it("preserves existing data when the pinned package version is wrong", () => {
		const fixture = createFixture("1.2.2");

		expect(() => installPinnedModelData(fixture)).toThrow("does not match pi-ai");

		expect(readFileSync(join(fixture.packageRoot, "src", "providers", "data", "sentinel"), "utf8")).toBe(
			"original\n",
		);
	});
});
