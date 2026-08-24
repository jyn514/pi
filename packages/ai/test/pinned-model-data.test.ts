import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPinnedModelData } from "../scripts/hydrate-pinned-model-data.ts";
import { createModelDataManifest, type ModelDataStructure } from "../scripts/model-data.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
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
		'import { TEST_PROVIDER_CLASSIFIER_MODELS, TEST_PROVIDER_IMAGE_MODELS, TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\n',
	);
	writeFileSync(
		join(providersDir, "test-provider.models.ts"),
		"export const TEST_PROVIDER_CLASSIFIER_MODELS = {};\nexport const TEST_PROVIDER_IMAGE_MODELS = {};\nexport const TEST_PROVIDER_MODELS = {};\n",
	);
	writeFileSync(join(providersDir, "data", "sentinel"), "original\n");

	const structure: ModelDataStructure = { "test-provider": { "chat:model-a": "openai-completions" } };
	const content = `${JSON.stringify({
		"openai-completions": {
			"chat:model-a": {
				type: "chat",
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
		expect(readdirSync(join(dataDir, "..")).filter((entry) => entry.startsWith(".model-data-"))).toEqual([]);
	});

	it("restores the original data when installing the validated stage fails", () => {
		const fixture = createFixture();
		const providersDir = join(fixture.packageRoot, "src", "providers");
		const installationError = Object.assign(new Error("staged installation denied"), { code: "EACCES" });
		const rename = fs.renameSync;
		vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
			if (String(source).startsWith(join(providersDir, ".model-data-staged-"))) throw installationError;
			return rename(source, destination);
		});
		syncBuiltinESMExports();

		expect(() => installPinnedModelData(fixture)).toThrow(installationError);

		expect(readFileSync(join(providersDir, "data", "sentinel"), "utf8")).toBe("original\n");
		expect(readdirSync(providersDir).filter((entry) => entry.startsWith(".model-data-"))).toEqual([]);
	});

	it.each([false, true])(
		"retains the original backup and reports failures (stage cleanup fails: %s)",
		(cleanupFails) => {
			const fixture = createFixture();
			const providersDir = join(fixture.packageRoot, "src", "providers");
			const installationError = Object.assign(new Error("staged installation denied"), { code: "EACCES" });
			const rollbackError = Object.assign(new Error("backup restoration denied"), { code: "EACCES" });
			const cleanupError = Object.assign(new Error("staged cleanup denied"), { code: "EACCES" });
			const rename = fs.renameSync;
			const remove = fs.rmSync;
			let backupPath: string | undefined;
			vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
				if (String(source).startsWith(join(providersDir, ".model-data-staged-"))) throw installationError;
				if (String(source).startsWith(join(providersDir, ".model-data-backup-"))) throw rollbackError;
				rename(source, destination);
				backupPath = String(destination);
			});
			vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
				if (cleanupFails && String(path).startsWith(join(providersDir, ".model-data-staged-"))) throw cleanupError;
				return remove(path, options);
			});
			syncBuiltinESMExports();

			let failure: unknown;
			try {
				installPinnedModelData(fixture);
			} catch (error) {
				failure = error;
			}

			if (!backupPath) throw new Error("Original data was not moved to a backup");
			expect(readFileSync(join(backupPath, "sentinel"), "utf8")).toBe("original\n");
			expect(existsSync(join(providersDir, "data"))).toBe(false);
			expect(readdirSync(providersDir).filter((entry) => entry.startsWith(".model-data-staged-"))).toHaveLength(
				cleanupFails ? 1 : 0,
			);
			expect(failure).toBeInstanceOf(AggregateError);
			expect((failure as AggregateError).errors).toHaveLength(cleanupFails ? 3 : 2);
			expect((failure as AggregateError).errors[0]).toBe(installationError);
			expect((failure as AggregateError).errors[1]).toBe(rollbackError);
			if (cleanupFails) expect((failure as AggregateError).errors[2]).toBe(cleanupError);
			expect((failure as Error).message).toContain(backupPath);
		},
	);

	it("preserves existing data when the pinned package version is wrong", () => {
		const fixture = createFixture("1.2.2");

		expect(() => installPinnedModelData(fixture)).toThrow("does not match pi-ai");

		expect(readFileSync(join(fixture.packageRoot, "src", "providers", "data", "sentinel"), "utf8")).toBe(
			"original\n",
		);
	});
});
