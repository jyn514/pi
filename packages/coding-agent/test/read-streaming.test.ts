import { constants } from "node:buffer";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createReadTool,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
} from "../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "../src/core/tools/truncate.ts";

const virtualPath = "/virtual/pi-read-streaming.txt";
type ReadWindow = Omit<ReadToolInput, "path">;

// Reference: read.ts at ada5881d8b7b03a157fd06f564192c0f70a5ae7b. Only bounded fixtures use this
// whole-buffer oracle; the large-file regressions must not construct their expected text this way.
function previousTextRead(buffer: Buffer, { offset, limit }: ReadWindow) {
	const allLines = buffer.toString("utf-8").split("\n");
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
	}
	let userLimitedLines: number | undefined;
	let selectedContent: string;
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, allLines.length);
		selectedContent = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	} else {
		selectedContent = allLines.slice(startLine).join("\n");
	}
	const truncation = truncateHead(selectedContent);
	let text: string;
	let details: ReadToolDetails | undefined;
	if (truncation.firstLineExceedsLimit) {
		text = `[Line ${startLineDisplay} is ${formatSize(Buffer.byteLength(allLines[startLine], "utf-8"))}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${virtualPath} | head -c ${DEFAULT_MAX_BYTES}]`;
		details = { truncation };
	} else if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const byteNotice = truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
		text = `${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length}${byteNotice}. Use offset=${endLineDisplay + 1} to continue.]`;
		details = { truncation };
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		text = `${truncation.content}\n\n[${allLines.length - (startLine + userLimitedLines)} more lines in file. Use offset=${startLine + userLimitedLines + 1} to continue.]`;
	} else {
		text = truncation.content;
	}
	return { content: [{ type: "text", text }], details, structuredContent: text };
}

function streamedTool(data: Buffer, chunkSize: number) {
	const operations: ReadOperations = {
		access: async () => {},
		readFile: async () => {
			throw new Error("Text must not use the whole-buffer reader");
		},
		async *readChunks(path) {
			expect(path).toBe(virtualPath);
			for (let index = 0; index < data.length; index += chunkSize) {
				yield data.subarray(index, index + chunkSize);
			}
		},
	};
	return createReadTool("/", { operations });
}

const smallFixtures = [
	{ name: "empty", data: Buffer.alloc(0) },
	{ name: "plain", data: Buffer.from("first\nsecond\nthird") },
	{ name: "terminal LF", data: Buffer.from("first\nsecond\n") },
	{ name: "blank records", data: Buffer.from("\n\nfirst\n\n") },
	{ name: "CRLF and BOM", data: Buffer.from("\ufefffirst\r\nsecond\r\n") },
	{ name: "multibyte UTF-8", data: Buffer.from("é\n🙂漢字\nlast") },
	{ name: "invalid UTF-8", data: Buffer.from([0xf0, 0x9f, 0x0a, 0x80, 0xc0, 0xaf, 0x0a, 0xe2, 0x82]) },
];
const windows: ReadWindow[] = [
	{},
	{ offset: 1 },
	{ offset: 0 },
	{ offset: -1 },
	{ offset: 2 },
	{ offset: 99 },
	{ limit: 0 },
	{ limit: 1 },
	{ limit: 2 },
	{ limit: -1 },
	{ limit: -2.5 },
	{ limit: -99 },
	{ offset: 2, limit: -3 },
	{ offset: 2, limit: 1 },
	{ offset: 2, limit: 99 },
	{ offset: 1.5, limit: 2.5 },
];

async function expectParity(data: Buffer, chunkSize: number, window: ReadWindow) {
	let expected: ReturnType<typeof previousTextRead>;
	try {
		expected = previousTextRead(data, window);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		await expect(streamedTool(data, chunkSize).execute("parity", { path: virtualPath, ...window })).rejects.toThrow(
			error.message,
		);
		return;
	}
	const actual = await streamedTool(data, chunkSize).execute("parity", { path: virtualPath, ...window });
	expect(actual).toEqual(expected);
}

afterEach(() => vi.restoreAllMocks());

describe("read streaming", () => {
	it.each(smallFixtures)("preserves previous results for $name across chunk boundaries", async ({ data }) => {
		for (const chunkSize of [1, 2, 7, 65536]) {
			for (const window of windows) await expectParity(data, chunkSize, window);
		}
	});

	it("preserves output-limit boundaries, trailing newlines, and truncation precedence", async () => {
		const fixtures = [
			"x".repeat(DEFAULT_MAX_BYTES),
			`${"x".repeat(DEFAULT_MAX_BYTES)}\n`,
			"x".repeat(DEFAULT_MAX_BYTES + 1),
			`${"x".repeat(DEFAULT_MAX_BYTES - 1)}\nx`,
			`${"x".repeat(DEFAULT_MAX_BYTES - 2)}\nx\n`,
			"🙂".repeat(DEFAULT_MAX_BYTES / 4 + 1),
			"\n".repeat(DEFAULT_MAX_LINES),
			"\n".repeat(DEFAULT_MAX_LINES + 1),
			"x\n".repeat(DEFAULT_MAX_LINES),
			"x\n".repeat(DEFAULT_MAX_LINES + 1),
			`${"x\n".repeat(DEFAULT_MAX_LINES)}${"y".repeat(DEFAULT_MAX_BYTES + 1)}`,
		];
		for (const text of fixtures) {
			const data = Buffer.from(text);
			for (const chunkSize of [7, 4096, data.length + 1]) {
				for (const window of [
					{},
					{ limit: 0 },
					{ limit: 1 },
					{ offset: 2 },
					{ limit: DEFAULT_MAX_LINES },
					{ offset: 1.5, limit: 2.5 },
				]) {
					await expectParity(data, chunkSize, window);
				}
			}
		}
	});

	it.each([{ offset: 2, limit: 1 }, { limit: -1 }, { offset: 2, limit: -3 }])(
		"keeps old whole-buffer adapters on the same text-selection path (%j)",
		async (window) => {
			const data = Buffer.from("first\nsecond\nthird\n");
			const readFile = vi.fn(async () => data);
			const tool = createReadTool("/", { operations: { access: async () => {}, readFile } });
			const result = await tool.execute("fallback", { path: virtualPath, ...window });
			expect(result).toEqual(previousTextRead(data, window));
			expect(readFile).toHaveBeenCalledExactlyOnceWith(virtualPath);
		},
	);

	it("uses the binary reader rather than the optional text stream for images", async () => {
		const data = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
			"base64",
		);
		const readFile = vi.fn(async () => data);
		const readChunks = vi.fn(() => {
			throw new Error("Image used text stream");
		});
		const tool = createReadTool("/", {
			operations: { access: async () => {}, detectImageMimeType: async () => "image/png", readFile, readChunks },
		});
		const result = await tool.execute("binary-image", { path: virtualPath });
		expect(result.content.find((block) => block.type === "image")?.mimeType).toBe("image/png");
		expect(readFile).toHaveBeenCalledExactlyOnceWith(virtualPath);
		expect(readChunks).not.toHaveBeenCalled();
	});

	it("bounds decoder inputs even when an adapter yields a large chunk", async () => {
		const data = Buffer.alloc(4 * 1024 * 1024, "x");
		const writes = vi.spyOn(StringDecoder.prototype, "write");
		const result = await streamedTool(data, data.length).execute("large-yield", { path: virtualPath });
		expect(result.details?.truncation?.totalBytes).toBe(data.length);
		expect(result.details?.truncation?.firstLineExceedsLimit).toBe(true);
		// A generous resource bound, not an assertion of the implementation's exact chunk size.
		expect(
			Math.max(
				...writes.mock.calls.map(([chunk]) =>
					typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength,
				),
			),
		).toBeLessThanOrEqual(1024 * 1024);
	});

	it("counts and discards a selected line larger than V8's string limit", async () => {
		const chunk = Buffer.alloc(65536, "x");
		const repetitions = Math.ceil((constants.MAX_STRING_LENGTH + 1) / chunk.length);
		const lineBytes = repetitions * chunk.length;
		let closed = false;
		const tool = createReadTool("/", {
			operations: {
				access: async () => {},
				readFile: async () => {
					throw new Error("Unexpected whole-file read");
				},
				async *readChunks() {
					try {
						yield Buffer.from("before\n");
						for (let index = 0; index < repetitions; index++) yield chunk;
						yield Buffer.from("\nafter");
					} finally {
						closed = true;
					}
				},
			},
		});
		const result = await tool.execute("huge-line", { path: virtualPath, offset: 2, limit: 1 });
		expect(result.structuredContent).toContain(`[Line 2 is ${formatSize(lineBytes)}, exceeds 50.0KB limit.`);
		expect(result.details?.truncation).toEqual({
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 1,
			totalBytes: lineBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		expect(closed).toBe(true);
	}, 60000);

	it("skips a huge line without retaining it before the requested offset", async () => {
		const chunk = Buffer.alloc(65536, "x");
		const tool = createReadTool("/", {
			operations: {
				access: async () => {},
				readFile: async () => {
					throw new Error("Unexpected whole-file read");
				},
				async *readChunks() {
					for (let index = 0; index < 2048; index++) yield chunk;
					yield Buffer.from("\nafter\nlast");
				},
			},
		});
		const result = await tool.execute("huge-prefix", { path: virtualPath, offset: 2, limit: 1 });
		expect(result).toEqual({
			content: [{ type: "text", text: "after\n\n[1 more lines in file. Use offset=3 to continue.]" }],
			details: undefined,
			structuredContent: "after\n\n[1 more lines in file. Use offset=3 to continue.]",
		});
	});

	it("does not open a source for a pre-aborted invocation", async () => {
		const controller = new AbortController();
		controller.abort();
		const access = vi.fn(async () => {});
		const readFile = vi.fn(async () => Buffer.alloc(0));
		const readChunks = vi.fn(async function* () {});
		const tool = createReadTool("/", { operations: { access, readFile, readChunks } });
		await expect(tool.execute("abort-before", { path: virtualPath }, controller.signal)).rejects.toThrow(
			"Operation aborted",
		);
		expect(access).not.toHaveBeenCalled();
		expect(readChunks).not.toHaveBeenCalled();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("waits for iterator cleanup when aborted while counting beyond the requested range", async () => {
		const waiting = Promise.withResolvers<void>();
		const cleanupStarted = Promise.withResolvers<void>();
		const allowCleanup = Promise.withResolvers<void>();
		const controller = new AbortController();
		let closed = false;
		const tool = createReadTool("/", {
			operations: {
				access: async () => {},
				readFile: async () => {
					throw new Error("Unexpected whole-file read");
				},
				async *readChunks(_path, signal) {
					expect(signal).toBe(controller.signal);
					try {
						yield Buffer.from("visible\n");
						await new Promise<void>((resolve) => {
							const onAbort = () => {
								signal?.removeEventListener("abort", onAbort);
								resolve();
							};
							signal?.addEventListener("abort", onAbort, { once: true });
							waiting.resolve();
						});
					} finally {
						cleanupStarted.resolve();
						await allowCleanup.promise;
						closed = true;
					}
				},
			},
		});
		const execution = tool.execute("abort-after-range", { path: virtualPath, limit: 1 }, controller.signal);
		let settled = false;
		void execution.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await waiting.promise;
		controller.abort();
		await cleanupStarted.promise;
		await nextTurn();
		try {
			expect(settled).toBe(false);
		} finally {
			allowCleanup.resolve();
		}
		await expect(execution).rejects.toThrow("Operation aborted");
		expect(closed).toBe(true);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it.each([null, "image/png"])("preserves immediate abort of pending legacy binary I/O (%s)", async (mimeType) => {
		const started = Promise.withResolvers<void>();
		const buffered = Promise.withResolvers<Buffer>();
		const controller = new AbortController();
		const tool = createReadTool("/", {
			operations: {
				access: async () => {},
				detectImageMimeType: async () => mimeType,
				readFile: async () => {
					started.resolve();
					return buffered.promise;
				},
			},
		});
		const execution = tool.execute("abort-buffered", { path: virtualPath }, controller.signal);
		await started.promise;
		controller.abort();
		try {
			await expect(execution).rejects.toThrow("Operation aborted");
		} finally {
			// Release the non-cancellable legacy operation too; do not leave background work behind.
			buffered.resolve(Buffer.from("unused"));
			await nextTurn();
		}
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("rejects a late source error rather than publishing the already collected range", async () => {
		let closed = false;
		const tool = createReadTool("/", {
			operations: {
				access: async () => {},
				readFile: async () => Buffer.alloc(0),
				async *readChunks() {
					try {
						yield Buffer.from("visible\n");
						throw new Error("late read failure");
					} finally {
						closed = true;
					}
				},
			},
		});
		await expect(tool.execute("late-error", { path: virtualPath, limit: 1 })).rejects.toThrow("late read failure");
		expect(closed).toBe(true);
	});

	it("preserves a source failure when iterator cleanup also throws", async () => {
		let cleaned = false;
		const tool = createReadTool("/", {
			operations: {
				access: async () => {},
				readFile: async () => Buffer.alloc(0),
				readChunks: () => ({
					[Symbol.asyncIterator]() {
						return {
							next: async () => {
								throw new Error("source failure");
							},
							return: async () => {
								cleaned = true;
								throw new Error("cleanup failure");
							},
						};
					},
				}),
			},
		});
		await expect(tool.execute("two-errors", { path: virtualPath })).rejects.toThrow("source failure");
		expect(cleaned).toBe(true);
	});

	it("closes the native file stream before an aborted read settles", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-read-abort-"));
		const controller = new AbortController();
		const opened = Promise.withResolvers<fs.ReadStream>();
		const create = fs.createReadStream;
		const spy = vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
			const stream = create(...args);
			opened.resolve(stream);
			return stream;
		});
		// The production module uses fs's named ESM export; keep that binding in sync with the spy.
		syncBuiltinESMExports();
		try {
			const file = await open(join(directory, "input.txt"), "w");
			try {
				await file.truncate(32 * 1024 * 1024);
			} finally {
				await file.close();
			}
			const execution = createReadTool(directory).execute("native-abort", { path: "input.txt" }, controller.signal);
			const stream = await opened.promise;
			controller.abort();
			await expect(execution).rejects.toThrow("Operation aborted");
			expect(stream.closed).toBe(true);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		} finally {
			controller.abort();
			spy.mockRestore();
			syncBuiltinESMExports();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps concurrent invocations' decoders and counters independent", async () => {
		const tool = createReadTool("/", {
			operations: {
				access: async () => {},
				readFile: async () => Buffer.alloc(0),
				async *readChunks(path) {
					const data = Buffer.from(`${path}\né🙂\nlast`);
					for (const byte of data) {
						await nextTurn();
						yield Uint8Array.of(byte);
					}
				},
			},
		});
		const paths = ["/virtual/first.txt", "/virtual/second.txt"];
		const results = await Promise.all(paths.map((path) => tool.execute(path, { path, limit: 2 })));
		for (const [index, result] of results.entries()) {
			expect(result.structuredContent).toBe(
				`${paths[index]}\né🙂\n\n[1 more lines in file. Use offset=3 to continue.]`,
			);
		}
	});
});
