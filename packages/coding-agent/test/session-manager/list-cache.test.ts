import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import fs from "fs";
import fsPromises from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { type SessionInfo, SessionManager } from "../../src/core/session-manager.ts";
import * as paths from "../../src/utils/paths.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

interface CachedEnvelope {
	version: number;
	sourcePath: string;
	revision: string;
	info: Record<string, unknown>;
}

const probeDir = process.env.PI_LIST_CACHE_PROBE;
const created = "2025-01-01T00:00:00.000Z";
const activity = Date.parse("2025-01-02T00:00:00.000Z");

function message(text: string, role: "user" | "assistant" = "user", timestamp = activity) {
	return {
		type: "message",
		id: `${role}-${text}`,
		parentId: null,
		timestamp: created,
		message: { ...(role === "user" ? userMsg(text) : assistantMsg(text)), timestamp },
	};
}

function infoEntry(name?: string) {
	return { type: "session_info", id: "title", parentId: null, timestamp: created, name };
}

function append(file: string, entry: unknown) {
	fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

// A separate Vitest process uses the repository's native TS/alias harness, rather than
// depending on installed build artifacts or a new loader dependency.
it.skipIf(!probeDir)("fresh-process cache probe", async () => {
	const streams = vi.spyOn(fs, "createReadStream");
	syncBuiltinESMExports();
	try {
		const sessions = await SessionManager.listAll(probeDir);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].firstMessage).toBe("persisted prompt");
		expect(sessions[0].created).toBeInstanceOf(Date);
		expect(sessions[0].modified).toBeInstanceOf(Date);
		expect(streams).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
	}
});

describe.skipIf(!!probeDir)("session listing cache", () => {
	let root: string;
	let agentDir: string;
	let sessionsDir: string;
	let cwd: string;
	let oldAgentDir: string | undefined;

	beforeEach(() => {
		root = fs.mkdtempSync(join(tmpdir(), "pi-list-cache-"));
		agentDir = join(root, "agent");
		sessionsDir = join(root, "flat");
		cwd = join(root, "project");
		fs.mkdirSync(sessionsDir);
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	});

	function session(
		filename = "arbitrary.jsonl",
		id = "custom-id",
		entries: unknown[] = [message("hello")],
		storedCwd = cwd,
	) {
		const file = join(sessionsDir, filename);
		fs.writeFileSync(
			file,
			`${[
				{ type: "session", version: 3, id, cwd: storedCwd, timestamp: created, parentSession: "/parent.jsonl" },
				...entries,
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return file;
	}

	function cacheFile(id = "custom-id") {
		return join(getAgentDir(), "cache", "session-list-v1", `${createHash("sha256").update(id).digest("hex")}.json`);
	}

	function readCache(id = "custom-id"): CachedEnvelope {
		return JSON.parse(fs.readFileSync(cacheFile(id), "utf8"));
	}

	const list = () => SessionManager.list(cwd, sessionsDir);

	it("preserves complete scanner results, Dates, cleared names, search scope and activity ordering", async () => {
		const old = session("old.jsonl", "old", [message("older", "user", activity - 1000)]);
		const current = session("current.jsonl", "current", [
			message("first prompt"),
			message("assistant answer", "assistant", activity + 1000),
			{
				...message("tool secret"),
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "tool secret" }],
					timestamp: activity + 90000,
				},
			},
			{ type: "custom", data: "custom secret" },
			infoEntry("initial name"),
			infoEntry("   "),
		]);
		fs.utimesSync(old, new Date(), new Date());
		const cold = await list();
		expect(cold.map((s) => s.path)).toEqual([current, old]);
		expect(cold[0]).toEqual({
			path: current,
			id: "current",
			cwd,
			name: undefined,
			parentSessionPath: "/parent.jsonl",
			created: new Date(created),
			modified: new Date(activity + 1000),
			messageCount: 3,
			firstMessage: "first prompt",
			allMessagesText: "first prompt assistant answer",
		});
		const streams = vi.spyOn(fs, "createReadStream");
		syncBuiltinESMExports();
		const warm = await list();
		expect(warm).toEqual(cold);
		for (const info of warm) {
			expect(info.created).toBeInstanceOf(Date);
			expect(info.modified).toBeInstanceOf(Date);
		}
		expect(streams).not.toHaveBeenCalled();
	});

	it("uses safe ID hashing, the shared revision authority, and private cache files", async () => {
		const id = "../../outside/naïve\\untrusted";
		const file = session("not-the-id.jsonl", id);
		const writes = vi.spyOn(fsPromises, "writeFile");
		syncBuiltinESMExports();
		const [info] = await list();
		expect(writes).toHaveBeenCalledWith(
			expect.stringMatching(/\.[^.]+\.tmp$/),
			expect.any(String),
			expect.objectContaining({ flag: "wx", mode: 0o600 }),
		);
		expect(readCache(id)).toEqual({
			version: 1,
			sourcePath: paths.resolvePath(file),
			revision: paths.getFileRevision(file),
			info: JSON.parse(JSON.stringify(info)),
		});
		expect(fs.readdirSync(join(agentDir, "cache", "session-list-v1"))).toEqual([
			`${createHash("sha256").update(id).digest("hex")}.json`,
		]);
		if (process.platform !== "win32") {
			expect(fs.statSync(cacheFile(id)).mode & 0o777).toBe(0o600);
			expect(fs.statSync(join(agentDir, "cache", "session-list-v1")).mode & 0o777).toBe(0o700);
		}
	});

	it("reuses persisted cache in a fresh process", async () => {
		session("persisted.jsonl", "persisted", [message("persisted prompt")]);
		await list();
		await promisify(execFile)(
			process.execPath,
			[
				resolve("../../node_modules/vitest/dist/cli.js"),
				"--run",
				"test/session-manager/list-cache.test.ts",
				"-t",
				"fresh-process cache probe",
			],
			{
				cwd: process.cwd(),
				env: { ...process.env, PI_LIST_CACHE_PROBE: sessionsDir },
				timeout: 25000,
			},
		);
	});

	it.each(["append", "rename", "title rename", "clear", "same-size rewrite", "replacement"])(
		"invalidates after %s",
		async (change) => {
			let file = session("source.jsonl", "custom-id", [message("hello"), infoEntry("before")]);
			await list();
			const revision = paths.getFileRevision(file);
			if (change === "append") append(file, message("new prompt", "user", activity + 1));
			if (change === "rename") {
				const renamed = join(sessionsDir, "renamed.jsonl");
				fs.renameSync(file, renamed);
				file = renamed;
			}
			if (change === "title rename") append(file, infoEntry("after"));
			if (change === "clear") append(file, infoEntry());
			if (change === "same-size rewrite") {
				const text = fs.readFileSync(file, "utf8");
				fs.writeFileSync(file, text.replaceAll("hello", "world"));
			}
			if (change === "replacement") {
				const replacement = session("replacement.tmp", "custom-id", [message("replacement")]);
				fs.renameSync(replacement, file);
			}
			if (change !== "rename") expect(paths.getFileRevision(file)).not.toBe(revision);
			const streams = vi.spyOn(fs, "createReadStream");
			syncBuiltinESMExports();
			const [updated] = await list();
			expect(streams).toHaveBeenCalledTimes(1);
			expect(updated.path).toBe(file);
			if (change === "append") expect(updated.allMessagesText).toBe("hello new prompt");
			if (change === "title rename") {
				expect(updated.name).toBe("after");
				expect(updated.modified).toEqual(new Date(activity));
			}
			if (change === "clear") expect(updated.name).toBeUndefined();
			if (change === "same-size rewrite") expect(updated.firstMessage).toBe("world");
			if (change === "replacement") expect(updated.firstMessage).toBe("replacement");
			streams.mockClear();
			expect(await list()).toEqual([updated]);
			expect(streams).not.toHaveBeenCalled();
		},
	);

	it("publishes complete cache entries during concurrent listings", async () => {
		session();
		const results = await Promise.all([list(), list(), list()]);
		expect(results[1]).toEqual(results[0]);
		expect(results[2]).toEqual(results[0]);
		expect(readCache().info.firstMessage).toBe("hello");
		expect(fs.readdirSync(join(agentDir, "cache", "session-list-v1"))).toEqual([
			`${createHash("sha256").update("custom-id").digest("hex")}.json`,
		]);
		const streams = vi.spyOn(fs, "createReadStream");
		syncBuiltinESMExports();
		expect(await list()).toEqual(results[0]);
		expect(streams).not.toHaveBeenCalled();
	});

	it("never confuses distinct files sharing an ID", async () => {
		const first = session("first.jsonl", "shared", [message("one")]);
		const second = session("second.jsonl", "shared", [message("two")]);
		for (let i = 0; i < 3; i++) {
			const results = await list();
			expect(results.map((s) => [s.path, s.firstMessage]).sort()).toEqual(
				[
					[first, "one"],
					[second, "two"],
				].sort(),
			);
		}
	});

	it.each([
		["corrupt JSON", (_cache: CachedEnvelope) => "{broken"],
		["obsolete version", (cache: CachedEnvelope) => JSON.stringify({ ...cache, version: 0 })],
		["wrong source", (cache: CachedEnvelope) => JSON.stringify({ ...cache, sourcePath: "/other.jsonl" })],
		["wrong revision", (cache: CachedEnvelope) => JSON.stringify({ ...cache, revision: "obsolete" })],
		["wrong ID", (cache: CachedEnvelope) => JSON.stringify({ ...cache, info: { ...cache.info, id: "other" } })],
		[
			"wrong info path",
			(cache: CachedEnvelope) => JSON.stringify({ ...cache, info: { ...cache.info, path: "/other.jsonl" } }),
		],
		[
			"bad date",
			(cache: CachedEnvelope) => JSON.stringify({ ...cache, info: { ...cache.info, created: "not a date" } }),
		],
		[
			"bad modified date",
			(cache: CachedEnvelope) => JSON.stringify({ ...cache, info: { ...cache.info, modified: null } }),
		],
		[
			"missing search text",
			(cache: CachedEnvelope) => JSON.stringify({ ...cache, info: { ...cache.info, allMessagesText: undefined } }),
		],
		[
			"bad message count",
			(cache: CachedEnvelope) => JSON.stringify({ ...cache, info: { ...cache.info, messageCount: "1" } }),
		],
		["bad optional name", (cache: CachedEnvelope) => JSON.stringify({ ...cache, info: { ...cache.info, name: 42 } })],
	])("falls back from %s", async (_description, corrupt) => {
		session();
		const expected = await list();
		fs.writeFileSync(cacheFile(), corrupt(readCache()));
		const streams = vi.spyOn(fs, "createReadStream");
		syncBuiltinESMExports();
		expect(await list()).toEqual(expected);
		expect(streams).toHaveBeenCalledTimes(1);
		expect(readCache().info.firstMessage).toBe("hello");
	});

	it("rechecks the source after reading a cache hit", async () => {
		const file = session();
		await list();
		const original = paths.getFileRevision;
		let calls = 0;
		vi.spyOn(paths, "getFileRevision").mockImplementation((path) => {
			if (path === file && ++calls === 2) append(file, message("new activity", "user", activity + 1000));
			return original(path);
		});
		const streams = vi.spyOn(fs, "createReadStream");
		syncBuiltinESMExports();
		const [info] = await list();
		expect(info.allMessagesText).toBe("hello new activity");
		expect(info.modified).toEqual(new Date(activity + 1000));
		expect(streams).toHaveBeenCalledTimes(1);
	});

	it("falls back when reading an existing cache fails", async () => {
		session();
		const expected = await list();
		const read = vi.spyOn(fsPromises, "readFile").mockRejectedValue(new Error("injected read failure"));
		const streams = vi.spyOn(fs, "createReadStream");
		syncBuiltinESMExports();
		expect(await list()).toEqual(expected);
		expect(read).toHaveBeenCalled();
		expect(streams).toHaveBeenCalledTimes(1);
	});

	it("does not hide scans when temporary file creation fails", async () => {
		session();
		const write = vi.spyOn(fsPromises, "writeFile").mockRejectedValue(new Error("injected write failure"));
		syncBuiltinESMExports();
		expect((await list())[0].firstMessage).toBe("hello");
		expect(write).toHaveBeenCalled();
		expect(fs.readdirSync(join(agentDir, "cache", "session-list-v1"))).toEqual([]);
	});

	it("does not hide scans when the cache directory cannot be created", async () => {
		session();
		fs.mkdirSync(agentDir);
		fs.writeFileSync(join(agentDir, "cache"), "not a directory");
		expect((await list())[0].firstMessage).toBe("hello");
	});

	it("does not hide scans or leave owned temporary files when publication fails", async () => {
		session();
		const rename = vi.spyOn(fsPromises, "rename").mockRejectedValue(new Error("injected rename failure"));
		syncBuiltinESMExports();
		expect((await list())[0].firstMessage).toBe("hello");
		expect(rename).toHaveBeenCalled();
		expect(fs.readdirSync(join(agentDir, "cache", "session-list-v1"))).toEqual([]);
	});

	it.each(["unavailable initially", "unavailable after scan", "changed during scan"])(
		"returns scanned info without caching when revision is %s",
		async (condition) => {
			const file = session();
			const original = paths.getFileRevision;
			let calls = 0;
			const revisions = vi.spyOn(paths, "getFileRevision").mockImplementation((path) => {
				if (path !== file) return original(path);
				calls++;
				if (condition === "unavailable initially") return undefined;
				if (calls > 1 && condition === "unavailable after scan") return undefined;
				if (calls > 1 && condition === "changed during scan") {
					// Mutate at the post-scan boundary, with no timing dependency or retry.
					append(file, infoEntry("concurrent title"));
				}
				return original(path);
			});
			const streams = vi.spyOn(fs, "createReadStream");
			syncBuiltinESMExports();
			const [info] = await list();
			expect(info.firstMessage).toBe("hello");
			expect(fs.existsSync(cacheFile())).toBe(false);
			expect(streams).toHaveBeenCalledTimes(1);
			revisions.mockRestore();
			streams.mockClear();
			expect((await list())[0].firstMessage).toBe("hello");
			expect(streams).toHaveBeenCalledTimes(1);
		},
	);

	it("does not negatively cache an invalid file that later becomes a session", async () => {
		const file = join(sessionsDir, "recoverable.jsonl");
		fs.writeFileSync(file, "not json\n");
		expect(await list()).toEqual([]);
		session("recoverable.jsonl");
		const [info] = await list();
		expect(info.firstMessage).toBe("hello");
		expect(readCache().info.firstMessage).toBe("hello");
	});

	it("keeps discovery authoritative after deletion even with retained cache", async () => {
		const file = session();
		await list();
		fs.unlinkSync(file);
		expect(fs.existsSync(cacheFile())).toBe(true);
		expect(await list()).toEqual([]);
		expect(await SessionManager.listAll(sessionsDir)).toEqual([]);
	});

	it("preserves custom flat-directory cwd filtering, including warm progress", async () => {
		const matching = session("matching.jsonl", "matching");
		session("other.jsonl", "other", [message("other")], join(root, "other"));
		session("legacy.jsonl", "legacy", [], "");
		expect(await SessionManager.listAll(sessionsDir)).toHaveLength(3);
		const streams = vi.spyOn(fs, "createReadStream");
		syncBuiltinESMExports();
		const partial: (readonly SessionInfo[])[] = [];
		const progress = vi.fn((_loaded, _total, infos?: readonly SessionInfo[]) => {
			if (infos) partial.push(infos);
		});
		expect((await SessionManager.list(cwd, sessionsDir, progress)).map((s) => s.path)).toEqual([matching]);
		expect(progress).toHaveBeenCalled();
		for (const infos of partial) expect(infos.every((s) => s.path === matching)).toBe(true);
		expect(streams).not.toHaveBeenCalled();
	});

	it("caches default listAll project discovery too", async () => {
		const projectDir = join(agentDir, "sessions", "project");
		fs.mkdirSync(projectDir, { recursive: true });
		const file = session();
		fs.renameSync(file, join(projectDir, "custom.jsonl"));
		const cold = await SessionManager.listAll();
		const streams = vi.spyOn(fs, "createReadStream");
		syncBuiltinESMExports();
		expect(await SessionManager.listAll()).toEqual(cold);
		expect(cold).toHaveLength(1);
		expect(streams).not.toHaveBeenCalled();
	});

	it.each([false, true])("rejects already-aborted listings (warm=%s)", async (warm) => {
		session();
		if (warm) await list();
		const controller = new AbortController();
		controller.abort();
		await expect(SessionManager.list(cwd, sessionsDir, undefined, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		await expect(SessionManager.listAll(sessionsDir, undefined, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it.each([false, true])(
		"rejects cancellation while reading cache (warm=%s) without opening a transcript",
		async (warm) => {
			session();
			if (warm) await list();
			const controller = new AbortController();
			const originalRead = fsPromises.readFile;
			vi.spyOn(fsPromises, "readFile").mockImplementation(async (...args: Parameters<typeof originalRead>) => {
				try {
					return await originalRead(...args);
				} finally {
					if (String(args[0]) === cacheFile()) controller.abort();
				}
			});
			const streams = vi.spyOn(fs, "createReadStream");
			syncBuiltinESMExports();
			await expect(SessionManager.list(cwd, sessionsDir, undefined, controller.signal)).rejects.toMatchObject({
				name: "AbortError",
			});
			expect(streams).not.toHaveBeenCalled();
		},
	);

	it("rejects cancellation at cache publication instead of swallowing it as IO failure", async () => {
		session();
		const controller = new AbortController();
		const originalRename = fsPromises.rename;
		vi.spyOn(fsPromises, "rename").mockImplementation(async (...args) => {
			await originalRename(...args);
			controller.abort();
		});
		syncBuiltinESMExports();
		await expect(SessionManager.list(cwd, sessionsDir, undefined, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it("falls back to the scanner for headers beyond bounded discovery", async () => {
		const id = "x".repeat(1024 * 1024 + 1);
		session("large-header.jsonl", id);
		const streams = vi.spyOn(fs, "createReadStream");
		syncBuiltinESMExports();
		for (let i = 0; i < 2; i++) {
			const [info] = await list();
			expect(info.id).toBe(id);
			expect(info.firstMessage).toBe("hello");
		}
		expect(streams).toHaveBeenCalledTimes(2);
		expect(fs.existsSync(cacheFile(id))).toBe(false);
	});
});
