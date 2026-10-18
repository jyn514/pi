import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager.ensurePersisted", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-ensure-persisted-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it.each(["empty", "metadata", "conversation"] as const)("materializes a reopenable %s session", (kind) => {
		const session = SessionManager.create(dir, dir);
		const file = session.getSessionFile()!;
		if (kind !== "empty") {
			session.appendModelChange("test-provider", "test-model");
			session.appendThinkingLevelChange("high");
			session.appendCustomEntry("pending-work", { inputs: ["first", "second"] });
		}
		if (kind === "conversation") {
			session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		}
		// The explicit operation must not change ordinary empty-launch suppression.
		expect(existsSync(file)).toBe(kind === "conversation");

		session.ensurePersisted();
		const reopened = SessionManager.open(file);
		expect(reopened.getHeader()).toEqual(session.getHeader());
		expect(reopened.getEntries()).toEqual(session.getEntries());
		expect(reopened.getLeafId()).toBe(session.getLeafId());
		const materialized = readFileSync(file, "utf8");
		session.ensurePersisted();
		expect(readFileSync(file, "utf8")).toBe(materialized);

		// Once materialized, metadata appends must persist without a conversation.
		session.appendCustomEntry("later", { saved: true });
		expect(SessionManager.open(file).getEntries()).toEqual(session.getEntries());
	});

	it("rejects nonpersistent sessions without losing buffered entries", () => {
		const session = SessionManager.inMemory(dir);
		session.appendCustomEntry("pending", { task: "keep" });
		const entries = session.getEntries();
		expect(() => session.ensurePersisted()).toThrow(/nonpersistent/);
		expect(session.getEntries()).toEqual(entries);
		expect(session.getSessionFile()).toBeUndefined();
	});

	it("retains buffered entries after a write failure and permits retry", () => {
		const session = SessionManager.create(dir, dir);
		session.appendCustomEntry("pending", { task: "keep" });
		const entries = session.getEntries();
		const file = session.getSessionFile()!;
		mkdirSync(file);
		expect(() => session.ensurePersisted()).toThrow();
		expect(session.getEntries()).toEqual(entries);
		rmSync(file, { recursive: true });

		session.ensurePersisted();
		expect(SessionManager.open(file).getEntries()).toEqual(entries);
	});

	it("includes buffered entries left by an append failure after materialization", () => {
		const session = SessionManager.create(dir, dir);
		session.ensurePersisted();
		const file = session.getSessionFile()!;
		rmSync(file);
		mkdirSync(file);
		expect(() => session.appendCustomEntry("pending", { task: "keep" })).toThrow();
		const entries = session.getEntries();
		expect(entries).toHaveLength(1);
		rmSync(file, { recursive: true });

		session.ensurePersisted();
		expect(SessionManager.open(file).getEntries()).toEqual(entries);
	});
});
