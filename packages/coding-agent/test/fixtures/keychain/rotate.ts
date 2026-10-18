import { setTimeout } from "node:timers/promises";
import { AuthStorage } from "../../../src/core/auth-storage.ts";

await AuthStorage.create().modify("openai-codex", async (credential) => {
	if (credential?.type !== "oauth") throw new Error("Missing fixture OAuth credential");
	await setTimeout(50);
	return { ...credential, refresh: String(Number(credential.refresh) + 1) };
});
