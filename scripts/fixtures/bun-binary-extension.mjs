import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { Type } from "typebox";
import { getModel } from "@earendil-works/pi-ai";

export default async function () {
	assert.equal(Type.String().type, "string");
	assert.equal(typeof getModel, "function");
	const assets = dirname(process.execPath);
	assert.ok(JSON.parse(readFileSync(join(assets, "theme/dark.json"), "utf8")));
	assert.match(readFileSync(join(assets, "export-html/template.html"), "utf8"), /<html/);
	// Exercise the embedded worker directly so the in-process fallback cannot
	// conceal a missing entrypoint or an unreadable Photon WASM asset.
	const worker = new Worker("./src/utils/image-resize-worker.ts");
	try {
		const response = await new Promise((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
			worker.once("exit", (code) => reject(new Error(`Worker exited before replying: ${code}`)));
			worker.postMessage({
				inputBytes: new Uint8Array(readFileSync(join(assets, "assets/clankolas.png"))),
				mimeType: "image/png",
				options: { maxWidth: 1, maxHeight: 1 },
			});
		});
		assert.equal(response.error, undefined);
		assert.equal(response.result?.width, 1);
		assert.equal(response.result?.height, 1);
	} finally {
		await worker.terminate();
	}
	console.log("PI_BINARY_SMOKE_OK");
}
