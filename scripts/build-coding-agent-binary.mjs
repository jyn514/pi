#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: { outfile: { type: "string" }, target: { type: "string" } },
});
if (!values.outfile) throw new Error("Usage: node scripts/build-coding-agent-binary.mjs --outfile <path> [--target <bun-target>]");

const result = spawnSync("bun", [
	"build", "--compile", "--bytecode",
	// Project preload scripts must not run before Pi starts (#7684).
	"--no-compile-autoload-bunfig",
	"--define", "PI_BUNDLED_BUN=true",
	...(values.target ? ["--target", values.target] : []),
	"./dist/bun/cli.js",
	// Workers must be explicit entrypoints to be embedded in the executable.
	"./src/utils/image-resize-worker.ts",
	"--outfile", resolve(values.outfile),
], {
	cwd: fileURLToPath(new URL("../packages/coding-agent", import.meta.url)),
	encoding: "utf8",
	maxBuffer: 16 * 1024 * 1024,
	stdio: ["inherit", "pipe", "pipe"],
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) throw result.error;
// Bun 1.3.14 can report bytecode failure and still exit successfully.
process.exitCode = result.status !== 0
	? (result.status ?? 1)
	: /Failed to generate bytecode/i.test(`${result.stdout}\n${result.stderr}`) ? 1 : 0;
