#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hydrateModelCatalog } from "./hydrate-model-catalog.ts";

/** Fetch and verify the checkout's immutable catalog pin, then hydrate through the offline converter. */
export async function hydratePinnedModelData(root: string): Promise<void> {
	const pinPath = join(root, "nix", "model-catalog.json");
	const pin: unknown = JSON.parse(readFileSync(pinPath, "utf8"));
	// The checked-in pin selects a URL path and the exact response bytes we accept.
	if (
		typeof pin !== "object" ||
		pin === null ||
		!("revision" in pin) ||
		typeof pin.revision !== "string" ||
		!/^sha256-[0-9a-f]{64}$/.test(pin.revision)
	) {
		throw new Error(`Invalid model catalog pin in ${pinPath}`);
	}
	const revision = pin.revision;
	const response = await fetch(`https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`);
	if (!response.ok) throw new Error(`Catalog revision ${revision} is unavailable: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (`sha256-${createHash("sha256").update(bytes).digest("hex")}` !== revision) {
		throw new Error(`Catalog revision ${revision} does not match its content`);
	}

	const directory = mkdtempSync(join(tmpdir(), "pi-pinned-model-catalog-"));
	try {
		const catalogPath = join(directory, "models.all.json");
		writeFileSync(catalogPath, bytes);
		hydrateModelCatalog(join(root, "packages", "ai"), catalogPath);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await hydratePinnedModelData(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
	console.log("Hydrated model data from the verified catalog pinned in nix/model-catalog.json.");
}
