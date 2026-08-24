import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hydratePinnedModelData } from "../scripts/hydrate-pinned-model-data.ts";
import { validateGeneratedModelData } from "../scripts/model-data.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	syncBuiltinESMExports();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-pinned-model-data-"));
	temporaryRoots.push(root);
	const packageRoot = join(root, "packages", "ai");
	const providersDir = join(packageRoot, "src", "providers");
	const dataDir = join(providersDir, "data");
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(join(root, "nix"));
	writeFileSync(
		join(packageRoot, "src", "models.generated.ts"),
		'import { TEST_PROVIDER_CLASSIFIER_MODELS, TEST_PROVIDER_IMAGE_MODELS, TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\n',
	);
	writeFileSync(
		join(providersDir, "test-provider.models.ts"),
		"export const TEST_PROVIDER_CLASSIFIER_MODELS = {};\nexport const TEST_PROVIDER_IMAGE_MODELS = {};\nexport const TEST_PROVIDER_MODELS = {};\n",
	);
	writeFileSync(join(dataDir, "sentinel"), "original\n");
	const model = {
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
	};
	const bytes = JSON.stringify({ "test-provider": [model] });
	const revision = pinCatalog(root, bytes);
	const fetchCatalog = vi.fn(async () => new Response(bytes));
	vi.stubGlobal("fetch", fetchCatalog);
	return { root, packageRoot, providersDir, dataDir, model, bytes, revision, fetchCatalog };
}

function pinCatalog(root: string, bytes: string): string {
	const revision = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
	writeFileSync(join(root, "nix", "model-catalog.json"), JSON.stringify({ revision }));
	return revision;
}

function snapshot(directory: string): Record<string, string> {
	return Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), "utf8")]));
}

describe("pinned model data hydration", () => {
	it("fetches only the exact typed pin and deterministically publishes validated provider data", async () => {
		const fixture = createFixture();
		const aggregatorPath = join(fixture.packageRoot, "src", "models.generated.ts");
		const aggregator = readFileSync(aggregatorPath, "utf8");
		await hydratePinnedModelData(fixture.root);

		expect(fixture.fetchCatalog.mock.calls).toEqual([
			[`https://pi.dev/api/models/revisions/${fixture.revision}?types=chat,image,classifier`],
		]);
		expect(() => validateGeneratedModelData(fixture.packageRoot)).not.toThrow();
		expect(JSON.parse(readFileSync(join(fixture.dataDir, "test-provider.json"), "utf8"))).toEqual({
			"openai-completions": { "chat:model-a": fixture.model },
		});
		expect(existsSync(join(fixture.dataDir, "sentinel"))).toBe(false);
		const first = snapshot(fixture.dataDir);
		await hydratePinnedModelData(fixture.root);
		expect(snapshot(fixture.dataDir)).toEqual(first);
		expect(readFileSync(aggregatorPath, "utf8")).toBe(aggregator);
		expect(readdirSync(fixture.providersDir).filter((entry) => entry.startsWith(".model-"))).toEqual([]);
	});

	it("uses a changed checkout pin without discovering a live revision", async () => {
		const fixture = createFixture();
		const changedModel = { ...fixture.model, id: "second-model", name: "Second model" };
		const bytes = JSON.stringify({ "test-provider": [changedModel] });
		const revision = pinCatalog(fixture.root, bytes);
		fixture.fetchCatalog.mockImplementation(async () => new Response(bytes));
		await hydratePinnedModelData(fixture.root);
		expect(fixture.fetchCatalog.mock.calls).toEqual([
			[`https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`],
		]);
		expect(JSON.parse(readFileSync(join(fixture.dataDir, "test-provider.json"), "utf8"))).toEqual({
			"openai-completions": { "chat:second-model": changedModel },
		});
	});

	it("rejects altered bytes before publication, even when the JSON has identical values", async () => {
		const fixture = createFixture();
		fixture.fetchCatalog.mockImplementation(async () => new Response(`${fixture.bytes}\n`));
		await expect(hydratePinnedModelData(fixture.root)).rejects.toThrow("does not match its content");
		expect(snapshot(fixture.dataDir)).toEqual({ sentinel: "original\n" });
	});

	it("preserves existing data when a verified catalog omits a checkout provider", async () => {
		const fixture = createFixture();
		const bytes = JSON.stringify({ "other-provider": [fixture.model] });
		pinCatalog(fixture.root, bytes);
		fixture.fetchCatalog.mockImplementation(async () => new Response(bytes));
		await expect(hydratePinnedModelData(fixture.root)).rejects.toThrow("missing provider: test-provider");
		expect(snapshot(fixture.dataDir)).toEqual({ sentinel: "original\n" });
	});

	it.each([null, {}, { revision: "latest" }, { revision: "sha256-../../models" }])(
		"rejects malformed pins without network or data changes: %j",
		async (pin) => {
			const fixture = createFixture();
			writeFileSync(join(fixture.root, "nix", "model-catalog.json"), JSON.stringify(pin));
			await expect(hydratePinnedModelData(fixture.root)).rejects.toThrow("Invalid model catalog pin");
			expect(fixture.fetchCatalog).not.toHaveBeenCalled();
			expect(snapshot(fixture.dataDir)).toEqual({ sentinel: "original\n" });
		},
	);

	it("reports unavailable revisions without falling back to live discovery", async () => {
		const fixture = createFixture();
		fixture.fetchCatalog.mockImplementation(async () => new Response("unavailable", { status: 404 }));
		await expect(hydratePinnedModelData(fixture.root)).rejects.toThrow("HTTP 404");
		expect(fixture.fetchCatalog).toHaveBeenCalledTimes(1);
		expect(snapshot(fixture.dataDir)).toEqual({ sentinel: "original\n" });
	});

	it("restores the original data when publishing the validated stage fails", async () => {
		const fixture = createFixture();
		const installationError = Object.assign(new Error("staged publication denied"), { code: "EACCES" });
		const rename = fs.renameSync;
		vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
			if (String(source).startsWith(join(fixture.providersDir, ".model-hydration-"))) throw installationError;
			return rename(source, destination);
		});
		syncBuiltinESMExports();

		await expect(hydratePinnedModelData(fixture.root)).rejects.toThrow(installationError);
		expect(snapshot(fixture.dataDir)).toEqual({ sentinel: "original\n" });
		expect(readdirSync(fixture.providersDir).filter((entry) => entry.startsWith(".model-"))).toEqual([]);
	});

	it.each([false, true])(
		"retains the original backup and reports failures (stage cleanup fails: %s)",
		async (cleanupFails) => {
			const fixture = createFixture();
			const installationError = Object.assign(new Error("staged publication denied"), { code: "EACCES" });
			const rollbackError = Object.assign(new Error("backup restoration denied"), { code: "EACCES" });
			const cleanupError = Object.assign(new Error("staged cleanup denied"), { code: "EACCES" });
			const rename = fs.renameSync;
			const remove = fs.rmSync;
			let backupPath: string | undefined;
			vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
				if (String(source).startsWith(join(fixture.providersDir, ".model-hydration-"))) throw installationError;
				if (String(source).startsWith(join(fixture.providersDir, ".model-data-backup-"))) throw rollbackError;
				rename(source, destination);
				backupPath = String(destination);
			});
			vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
				if (cleanupFails && String(path).startsWith(join(fixture.providersDir, ".model-hydration-"))) {
					throw cleanupError;
				}
				return remove(path, options);
			});
			syncBuiltinESMExports();

			let failure: unknown;
			try {
				await hydratePinnedModelData(fixture.root);
			} catch (error) {
				failure = error;
			}

			if (!backupPath) throw new Error("Original data was not moved to a backup");
			expect(readFileSync(join(backupPath, "sentinel"), "utf8")).toBe("original\n");
			expect(existsSync(fixture.dataDir)).toBe(false);
			expect(
				readdirSync(fixture.providersDir).filter((entry) => entry.startsWith(".model-hydration-")),
			).toHaveLength(cleanupFails ? 1 : 0);
			expect(failure).toBeInstanceOf(AggregateError);
			expect((failure as AggregateError).errors).toEqual(
				cleanupFails ? [installationError, rollbackError, cleanupError] : [installationError, rollbackError],
			);
			expect((failure as Error).message).toContain(backupPath);
		},
	);
});
