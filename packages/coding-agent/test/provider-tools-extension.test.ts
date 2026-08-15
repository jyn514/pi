import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const tempDirs: string[] = [];
const observedEvents: unknown[] = [];

afterEach(async () => {
	observedEvents.length = 0;
	Reflect.deleteProperty(globalThis, "__piProviderEventTestObserver");
	await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("extension provider tools", () => {
	it("collects provider-executed tools without wrapping them as local tools", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-provider-tool-"));
		tempDirs.push(dir);
		const extensionPath = join(dir, "provider-tool.ts");
		await writeFile(
			extensionPath,
			`
export default function (pi) {
  pi.registerProviderTool({
    type: "web_search",
    allowedDomains: ["rust-lang.org"],
  });
}
`,
		);

		const loaded = await loadExtensions([extensionPath], dir);
		expect(loaded.errors).toEqual([]);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			dir,
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);

		expect(runner.getAllRegisteredTools()).toEqual([]);
		expect(runner.getAllProviderTools()).toEqual([
			{
				type: "web_search",
				allowedDomains: ["rust-lang.org"],
			},
		]);
	});

	it("delivers transient provider events synchronously", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-provider-event-"));
		tempDirs.push(dir);
		const extensionPath = join(dir, "provider-event.ts");
		await writeFile(
			extensionPath,
			`
export default function (pi) {
  pi.on("provider_event", ({ event }) => {
    globalThis.__piProviderEventTestObserver(event);
  });
}
`,
		);
		Object.assign(globalThis, {
			__piProviderEventTestObserver: (event: unknown) => observedEvents.push(event),
		});

		const loaded = await loadExtensions([extensionPath], dir);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			dir,
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		const event = {
			provider: "openai",
			api: "openai-responses",
			model: "gpt-test",
			type: "response.web_search_call.completed",
			payload: { query: "Rust" },
		};

		runner.emitProviderEvent(event);

		expect(observedEvents).toEqual([event]);
	});
});
