import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { Type } from "typebox";
import { getModel } from "@earendil-works/pi-ai";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";

export default async function (pi) {
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
	// Capture the production tool from its public factory and call it directly:
	// no session context, credentials, provider requests, or source-checkout imports.
	let codemode;
	await createCodemodeExtension({ models: false })({
		...pi,
		registerTool(tool) { codemode = tool; },
	});
	assert.ok(codemode, "codemode factory did not register its tool");
	const result = await codemode.execute("binary-smoke", {
		code: '// @options: {"timeout_ms": 5000}\ntext("PI_BINARY_CODEMODE_OUTPUT"); return await Promise.resolve(6 * 7);',
	}, undefined, undefined, undefined);
	assert.notEqual(result.isError, true, JSON.stringify(result));
	assert.deepEqual(result.content.slice(1), [
		{ type: "text", text: "PI_BINARY_CODEMODE_OUTPUT" },
		{ type: "text", text: "42" },
	]);
	assert.match(result.content[0].text, /^Script completed\n/);
	console.log("PI_BINARY_CODEMODE_OK");
	console.log("PI_BINARY_SMOKE_OK");
}
