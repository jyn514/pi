#!/usr/bin/env node
// A disposable Secret Service CLI fixture. Never connects to D-Bus.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [command, ...attributes] = process.argv.slice(2);
const directory = process.env.TEST_KEYCHAIN_DIRECTORY;
if (!directory) throw new Error("TEST_KEYCHAIN_DIRECTORY required");
const path = join(directory, createHash("sha256").update(attributes.at(-1)).digest("hex"));
appendFileSync(join(directory, "trace.jsonl"), `${JSON.stringify({ command, attributes })}\n`);
if (process.env.TEST_KEYCHAIN_HANG === command) {
	writeFileSync(join(directory, "writer-ready"), "");
	await new Promise((resolve) => setTimeout(resolve, 10_000));
}
if (process.env.TEST_KEYCHAIN_FAIL === command) {
	console.error("sensitive-subprocess-diagnostic");
	process.exit(2);
}
if (command === "lookup") {
	if (!existsSync(path)) process.exit(1);
	process.stdout.write(process.env.TEST_KEYCHAIN_MISMATCH ? "{}" : readFileSync(path, "utf8"));
} else if (command === "store") {
	writeFileSync(path, readFileSync(0));
} else process.exit(2);
