import { execFile } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Credential } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { checkProviderAuth, createAuthCheckModelRuntime, getProviderCredential } from "../src/cli/auth-check.ts";
import { resolveCredentialForPrint } from "../src/cli/credential-print.ts";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage, ReadOnlyAuthStorage, readStoredCredential } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { migrateAuthToAuthJson } from "../src/migrations.ts";

describe.skipIf(process.platform !== "linux")("Linux default keychain credentials", () => {
	let root: string;
	let agent: string;
	let vault: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-keychain-"));
		agent = join(root, "agent");
		vault = join(root, "vault");
		mkdirSync(agent);
		mkdirSync(vault);
		const bin = join(root, "bin");
		mkdirSync(bin);
		copyFileSync(
			fileURLToPath(new URL("fixtures/keychain/secret-tool.mjs", import.meta.url)),
			join(bin, "secret-tool"),
		);
		chmodSync(join(bin, "secret-tool"), 0o700);
		vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
		vi.stubEnv("PI_CODING_AGENT_DIR", agent);
		vi.stubEnv("TEST_KEYCHAIN_DIRECTORY", vault);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	test("fresh login ignores the legacy file, persists across instances, and logs out", async () => {
		const legacy = JSON.stringify({ openai: { type: "api_key", key: "legacy-key" } });
		writeFileSync(join(agent, "auth.json"), legacy);
		const first = AuthStorage.create();
		expect(await first.read("openai")).toBeUndefined();
		const runtime = await createAuthCheckModelRuntime(first);
		await runtime.login("openai", "api_key", { prompt: async () => "fresh-key", notify: () => {} });
		const second = AuthStorage.create();
		expect(await second.read("openai")).toEqual({ type: "api_key", key: "fresh-key" });
		expect(await second.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
		expect(readFileSync(join(agent, "auth.json"), "utf8")).toBe(legacy);
		expect(readFileSync(join(agent, "auth.json.keychain"), "utf8")).toBe("{}");
		expect(readFileSync(join(vault, "trace.jsonl"), "utf8")).not.toContain("fresh-key");
		await runtime.logout("openai");
		expect(await first.read("openai")).toBeUndefined();
	});

	test("read-only auth checks and credential printing use the same default store", async () => {
		const storage = AuthStorage.create();
		await storage.modify("openai", async () => ({ type: "api_key", key: "fresh-key" }));
		const credential = { type: "oauth" as const, access: "access", refresh: "refresh", expires: 0 };
		await storage.modify("openai-codex", async () => credential);
		const readonly = new ReadOnlyAuthStorage();
		expect(await readonly.read("openai-codex")).toEqual(credential);
		expect(readStoredCredential("openai-codex")).toEqual(credential);
		const runtime = await createAuthCheckModelRuntime(readonly);
		expect(await checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).toMatchObject({ status: "ready" });
		expect(await getProviderCredential("openai-codex", runtime, readonly, { refresh: false })).toBe("access");
		expect(await resolveCredentialForPrint(parseArgs(["--provider", "openai"]), runtime, "api_key")).toBe(
			"fresh-key",
		);
		expect(existsSync(join(agent, "auth.json"))).toBe(false);
		await expect(readonly.delete("openai")).rejects.toThrow("Read-only");
	});

	test("concurrent stores hold exclusion across the complete refresh callback", async () => {
		const first = AuthStorage.create();
		await first.modify("openai-codex", async () => ({ type: "oauth", access: "access", refresh: "0", expires: 0 }));
		let entered!: () => void;
		let release!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const rotating = first.modify("openai-codex", async (current) => {
			entered();
			await held;
			return { ...current, type: "oauth", access: "new", refresh: "1", expires: 1 };
		});
		await ready;
		const next = AuthStorage.create();
		const refresh = vi.fn(async (current: Credential | undefined): Promise<Credential> => {
			if (current?.type !== "oauth") throw new Error("OAuth credential required");
			expect(current.refresh).toBe("1");
			return { ...current, refresh: "2" };
		});
		const waiting = next.modify("openai-codex", refresh);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(refresh).not.toHaveBeenCalled();
		release();
		await Promise.all([rotating, waiting]);
		expect(await first.read("openai-codex")).toMatchObject({ refresh: "2" });
	});

	test("keychain failures cannot fall back to cached credentials or expose subprocess diagnostics", async () => {
		const storage = AuthStorage.create();
		await storage.modify("openai", async () => ({ type: "api_key", key: "fresh-key" }));
		await storage.read("openai");
		vi.stubEnv("TEST_KEYCHAIN_FAIL", "lookup");
		await expect(storage.read("openai")).rejects.toThrow("User keychain unavailable");
		await expect(storage.list()).rejects.not.toThrow("sensitive-subprocess-diagnostic");
		vi.stubEnv("TEST_KEYCHAIN_FAIL", "store");
		await expect(storage.modify("openai", async () => ({ type: "api_key", key: "failed" }))).rejects.toThrow();
		vi.stubEnv("TEST_KEYCHAIN_FAIL", "");
		expect(await storage.read("openai")).toMatchObject({ key: "fresh-key" });
		vi.stubEnv("TEST_KEYCHAIN_MISMATCH", "1");
		await expect(storage.modify("openai", async () => ({ type: "api_key", key: "new" }))).rejects.toThrow(
			"read-back",
		);
		expect(existsSync(join(agent, "auth.json"))).toBe(false);
	});

	test("agent directories use independent profiles and explicit SDK paths retain file storage", async () => {
		await AuthStorage.create().modify("openai", async () => ({ type: "api_key", key: "first" }));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "other-agent"));
		const second = AuthStorage.create();
		expect(await second.read("openai")).toBeUndefined();
		await second.modify("openai", async () => ({ type: "api_key", key: "second" }));
		expect(await AuthStorage.createDefault(agent).read("openai")).toMatchObject({ key: "first" });
		vi.stubEnv("PI_CODING_AGENT_DIR", agent);
		expect(await AuthStorage.create().read("openai")).toMatchObject({ key: "first" });
		const path = join(root, "explicit.json");
		await AuthStorage.create(path).modify("openai", async () => ({ type: "api_key", key: "explicit" }));
		expect(await new ReadOnlyAuthStorage(path).read("openai")).toMatchObject({ key: "explicit" });
	});

	test("CLI services and SDK sessions use the selected directory's keychain", async () => {
		await AuthStorage.createDefault(agent).modify("openai", async () => ({ type: "api_key", key: "fresh-key" }));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "unrelated-agent"));
		const services = await createAgentSessionServices({
			cwd: root,
			agentDir: agent,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		expect(await services.modelRuntime.getAuth("openai")).toMatchObject({ auth: { apiKey: "fresh-key" } });
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: agent,
			sessionManager: SessionManager.inMemory(root),
		});
		try {
			expect(await session.modelRuntime.getAuth("openai")).toMatchObject({ auth: { apiKey: "fresh-key" } });
		} finally {
			session.dispose();
		}
		expect(existsSync(join(agent, "auth.json"))).toBe(false);
	});

	test("startup never migrates legacy OAuth files into plaintext on Linux", () => {
		const legacy = JSON.stringify({ "openai-codex": { access: "old", refresh: "old", expires: 0 } });
		writeFileSync(join(agent, "oauth.json"), legacy);
		expect(migrateAuthToAuthJson()).toEqual([]);
		expect(readFileSync(join(agent, "oauth.json"), "utf8")).toBe(legacy);
		expect(existsSync(join(agent, "auth.json"))).toBe(false);
	});

	test("concurrent provider checks share one fresh keychain read", async () => {
		const storage = AuthStorage.create();
		await storage.modify("openai", async () => ({ type: "api_key", key: "first" }));
		writeFileSync(join(vault, "trace.jsonl"), "");
		await Promise.all(Array.from({ length: 40 }, () => storage.read("openai")));
		const calls = readFileSync(join(vault, "trace.jsonl"), "utf8").trim().split("\n");
		expect(calls).toHaveLength(1);
		await AuthStorage.create().modify("openai", async () => ({ type: "api_key", key: "second" }));
		expect(await storage.read("openai")).toMatchObject({ key: "second" });
	});

	test("separate processes cannot overwrite each other's token rotations", async () => {
		const storage = AuthStorage.create();
		await storage.modify("openai-codex", async () => ({ type: "oauth", access: "access", refresh: "0", expires: 0 }));
		const resolver = fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url));
		const worker = fileURLToPath(new URL("fixtures/keychain/rotate.ts", import.meta.url));
		await Promise.all(
			Array.from({ length: 2 }, () => promisify(execFile)(process.execPath, ["--import", resolver, worker])),
		);
		expect(await storage.read("openai-codex")).toMatchObject({ refresh: "2" });
	});

	test("a compromised lock during refresh prevents keychain publication", async () => {
		const storage = AuthStorage.create();
		await storage.modify("openai", async () => ({ type: "api_key", key: "first" }));
		let compromise!: (error: Error) => void;
		vi.spyOn(lockfile, "lock").mockImplementation(async (_path, options) => {
			compromise = options!.onCompromised!;
			return async () => {};
		});
		await expect(
			storage.modify("openai", async () => {
				compromise(new Error("lock compromised"));
				return { type: "api_key", key: "must-not-publish" };
			}),
		).rejects.toThrow("lock compromised");
		expect(await new ReadOnlyAuthStorage().read("openai")).toMatchObject({ key: "first" });
	});

	test("cancelling a keychain writer waits for exit and leaves the old credential usable", async () => {
		const storage = AuthStorage.create();
		await storage.modify("openai", async () => ({ type: "api_key", key: "first" }));
		vi.stubEnv("TEST_KEYCHAIN_HANG", "store");
		const controller = new AbortController();
		const writing = storage.modify("openai", async () => ({ type: "api_key", key: "cancelled" }), {
			signal: controller.signal,
		});
		const rejected = expect(writing).rejects.toMatchObject({ name: "AbortError" });
		const deadline = Date.now() + 3000;
		while (!existsSync(join(vault, "writer-ready"))) {
			if (Date.now() > deadline) throw new Error("Keychain writer did not start");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		controller.abort();
		await rejected;
		expect(existsSync(join(agent, "auth.json.keychain.lock"))).toBe(false);
		expect(await storage.read("openai")).toMatchObject({ key: "first" });
	});
});
