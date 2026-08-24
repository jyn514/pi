#!/usr/bin/env node

import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readModelDataStructure, validateModelDataDirectory } from "./model-data.ts";

interface InstallPinnedModelDataOptions {
	artifactRoot: string;
	packageRoot: string;
}

export function installPinnedModelData({ artifactRoot, packageRoot }: InstallPinnedModelDataOptions): void {
	const sourcePackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
	const artifactPackage = JSON.parse(readFileSync(join(artifactRoot, "package.json"), "utf8")) as { version?: unknown };
	if (typeof sourcePackage.version !== "string" || artifactPackage.version !== sourcePackage.version) {
		throw new Error(
			`Pinned model data version ${JSON.stringify(artifactPackage.version)} does not match pi-ai ${JSON.stringify(sourcePackage.version)}`,
		);
	}

	const providersDir = join(packageRoot, "src", "providers");
	const destination = join(providersDir, "data");
	const staged = mkdtempSync(join(providersDir, ".model-data-staged-"));
	let backup: string | undefined;
	try {
		cpSync(join(artifactRoot, "dist", "providers", "data"), staged, { recursive: true });
		validateModelDataDirectory(readModelDataStructure(packageRoot, staged), staged);
		if (existsSync(destination)) {
			backup = mkdtempSync(join(providersDir, ".model-data-backup-"));
			rmSync(backup, { recursive: true });
			renameSync(destination, backup);
		}
		renameSync(staged, destination);
		if (backup) rmSync(backup, { recursive: true });
	} catch (error) {
		if (backup && !existsSync(destination)) renameSync(backup, destination);
		throw error;
	} finally {
		rmSync(staged, { force: true, recursive: true });
		if (backup) rmSync(backup, { force: true, recursive: true });
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const artifactEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai-model-data"));
	installPinnedModelData({
		artifactRoot: dirname(dirname(artifactEntry)),
		packageRoot: join(dirname(fileURLToPath(import.meta.url)), ".."),
	});
	console.log("Hydrated model data from the pinned pi-ai package.");
}
