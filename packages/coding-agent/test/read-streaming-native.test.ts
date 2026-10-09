import { constants } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../src/core/tools/truncate.ts";
import { killProcessTree } from "../src/utils/shell.ts";

const probeDirectory = process.env.PI_READ_NATIVE_PROBE_DIR;
const reportName = "native-report.json";
const fixtureName = "native-sparse.txt";
const giantBytes = constants.MAX_STRING_LENGTH + 64 * 1024;
const prefix = "visible one\nvisible two\n";
// Fixed budget, NOT a fraction of fixture size. Native streaming measured below 64 MiB
// above the loaded Vitest worker baseline; allow 192 MiB for GC/platform variability.
// The old whole-file Buffer alone is >512 MiB on the tested Node runtime.
const memoryBudgetBytes = 192 * 1024 * 1024;
const childTimeoutMs = 90_000;

interface ProbeReport {
	fixtureBytes: number;
	giantBytes: number;
	baselineRss: number;
	baselinePeakRss: number;
	peakRss: number;
	peakIncrease: number;
	cases: { text: string; details: unknown; structuredContent: unknown }[];
}

function runProbe(directory: string): Promise<string> {
	return new Promise((resolveProbe, reject) => {
		// Run exactly this file through the existing package config: its workspace source
		// aliases avoid stale dist exports, without a build or a custom Node loader.
		const child = spawn(
			process.execPath,
			[
				resolve("../../node_modules/vitest/dist/cli.js"),
				"--run",
				"test/read-streaming-native.test.ts",
				"--maxWorkers=1",
			],
			{
				cwd: process.cwd(),
				// A timed-out Vitest coordinator must not leave its probe worker behind.
				detached: process.platform !== "win32",
				env: { ...process.env, PI_OFFLINE: "1", PI_READ_NATIVE_PROBE_DIR: directory },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		const capture = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-32 * 1024);
		};
		child.stdout.on("data", capture);
		child.stderr.on("data", capture);
		const timer = setTimeout(() => {
			if (child.pid) killProcessTree(child.pid);
			else child.kill("SIGKILL");
		}, childTimeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolveProbe(output);
			else reject(new Error(`Native probe exited ${code} (${signal}):\n${output}`));
		});
	});
}

describe("native bounded-memory read", () => {
	if (probeDirectory) {
		it(
			"probes the real filesystem reader in this isolated Vitest worker",
			async () => {
				const fixturePath = join(probeDirectory, fixtureName);
				const handle = await open(fixturePath, "w");
				try {
					// Only the short prefix is allocated/written. truncate creates a sparse,
					// unterminated NUL-filled third line larger than V8's string limit.
					await handle.write(prefix);
					await handle.truncate(Buffer.byteLength(prefix) + giantBytes);
				} finally {
					await handle.close();
				}
				const fixtureBytes = (await stat(fixturePath)).size;
				expect(fixtureBytes).toBeGreaterThan(constants.MAX_STRING_LENGTH);
				const baselineRss = process.memoryUsage().rss;
				const baselinePeakRss = process.resourceUsage().maxRSS * 1024;
				let sampledPeakRss = baselineRss;
				const sample = () => {
					sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss);
				};
				const sampler = setInterval(sample, 5);
				const cases: ProbeReport["cases"] = [];
				try {
					// No operations injection: exercises access, MIME sniffing and native stream.
					const tool = createReadTool(probeDirectory);
					for (const parameters of [
						{ path: fixtureName, limit: 2 },
						{ path: fixtureName, offset: 3, limit: 1 },
					]) {
						const result = await tool.execute("native-probe", parameters);
						const text = result.content.find((block) => block.type === "text");
						if (!text || text.type !== "text") throw new Error("Native read did not return text");
						cases.push({ text: text.text, details: result.details, structuredContent: result.structuredContent });
						sample();
					}
				} finally {
					clearInterval(sampler);
				}
				const peakRss = Math.max(sampledPeakRss, process.resourceUsage().maxRSS * 1024);
				const report: ProbeReport = {
					fixtureBytes,
					giantBytes,
					baselineRss,
					baselinePeakRss,
					peakRss,
					peakIncrease: Math.max(sampledPeakRss - baselineRss, peakRss - baselinePeakRss),
					cases,
				};
				await writeFile(join(probeDirectory, reportName), JSON.stringify(report));
				expect(report.peakIncrease).toBeLessThan(memoryBudgetBytes);
			},
			childTimeoutMs - 10_000,
		);
	} else {
		it(
			"reads limited and oversized selected lines above V8's string limit with bounded native memory",
			async () => {
				const directory = await mkdtemp(join(tmpdir(), "pi-read-native-"));
				try {
					await runProbe(directory);
					const report: ProbeReport = JSON.parse(await readFile(join(directory, reportName), "utf8"));
					expect(report.fixtureBytes).toBe(Buffer.byteLength(prefix) + giantBytes);
					expect(report.giantBytes).toBe(giantBytes);
					expect(report.baselineRss).toBeGreaterThan(0);
					expect(report.baselinePeakRss).toBeGreaterThan(0);
					expect(report.peakIncrease).toBeGreaterThanOrEqual(0);
					expect(report.peakIncrease).toBeLessThan(memoryBudgetBytes);
					const limitedText = "visible one\nvisible two\n\n[1 more lines in file. Use offset=3 to continue.]";
					expect(report.cases[0]).toEqual({ text: limitedText, structuredContent: limitedText });
					const oversizedText = `[Line 3 is ${formatSize(giantBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '3p' ${fixtureName} | head -c ${DEFAULT_MAX_BYTES}]`;
					expect(report.cases[1]).toEqual({
						text: oversizedText,
						structuredContent: oversizedText,
						details: {
							truncation: {
								content: "",
								truncated: true,
								truncatedBy: "bytes",
								totalLines: 1,
								totalBytes: giantBytes,
								outputLines: 0,
								outputBytes: 0,
								lastLinePartial: false,
								firstLineExceedsLimit: true,
								maxLines: DEFAULT_MAX_LINES,
								maxBytes: DEFAULT_MAX_BYTES,
							},
						},
					});
					console.log(`Native read probe: ${JSON.stringify(report)}`);
				} finally {
					await rm(directory, { recursive: true, force: true });
				}
			},
			childTimeoutMs + 15_000,
		);
	}
});
