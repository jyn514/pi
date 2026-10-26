import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);

test("published session entry reads context without resolving the UI or root SDK", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-session-entry-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const manifest = JSON.parse(await readFile(join(root, "packages/coding-agent/package.json"), "utf8"));
	const entry = manifest.exports["./session"];
	assert.equal(typeof entry?.import, "string", "package exports a session entry");
	assert.equal(typeof entry?.types, "string", "session entry has TypeScript declarations");
	await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
	await symlink(join(root, "node_modules"), join(directory, "node_modules"));
	await mkdir(join(directory, "dist"));
	await writeFile(join(directory, "dist/index.js"), 'throw new Error("root SDK must not load");\n');
	await build({
		entryPoints: [join(root, "packages/coding-agent/src/session.ts")],
		outfile: join(directory, entry.import),
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
	});
	await writeFile(
		join(directory, "forbid-ui.mjs"),
		`import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.includes("pi-tui") || specifier.includes("/modes/interactive/")) {
    throw new Error("session entry resolved UI: " + specifier);
  }
  return nextResolve(specifier, context);
} });
`,
	);
	await writeFile(
		join(directory, "probe.mjs"),
		`import assert from "node:assert/strict";
import { CURRENT_SESSION_VERSION, SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent/session";
assert.ok(CURRENT_SESSION_VERSION >= 3);
const session = SessionManager.inMemory();
session.appendMessage({ role: "user", content: "session-only context", timestamp: 1 });
const messages = convertToLlm(session.buildSessionContext().messages);
assert.equal(messages.length, 1);
assert.equal(messages[0].role, "user");
assert.equal(messages[0].content, "session-only context");
`,
	);
	await execute(process.execPath, ["--import", join(directory, "forbid-ui.mjs"), join(directory, "probe.mjs")], {
		cwd: directory,
	});
});
