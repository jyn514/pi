import { StringDecoder } from "node:string_decoder";
import { setImmediate } from "node:timers/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@earendil-works/pi-ai";
import { constants, createReadStream } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { readRenderers } from "./renderers/read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

/**
 * Result for programmatic callers such as codemode scripts: the text for text files, and an image
 * block for images that codemode's `image()` accepts. `note` is the text that goes with the image,
 * such as resize hints. Property descriptions are left out so the type stays on one line in tool
 * descriptions.
 */
const readOutputSchema = Type.Union([
	Type.String(),
	Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String(), note: Type.String() }),
]);

export type ReadToolOutput = Static<typeof readOutputSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer. Legacy text fallback buffers the whole file. */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/**
	 * Optional streaming text source. Honor the signal and release resources on completion,
	 * failure, cancellation, and iterator disposal. Yields are decoded in bounded pieces.
	 * Each call opens a fresh source at the beginning; EOF-relative negative limits may require two calls.
	 */
	readChunks?: (absolutePath: string, signal?: AbortSignal) => AsyncIterable<Uint8Array>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	readChunks: async function* (path, signal) {
		// Open lazily so an abort before the first next() cannot leave an unstarted stream open.
		yield* createReadStream(path, { highWaterMark: READ_CHUNK_BYTES, signal });
	},
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

const READ_CHUNK_BYTES = 64 * 1024;

function checkReadAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

async function* legacyReadChunks(buffer: Buffer): AsyncIterable<Uint8Array> {
	for (let position = 0; position < buffer.length; position += READ_CHUNK_BYTES) {
		yield buffer.subarray(position, position + READ_CHUNK_BYTES);
	}
}

/** Scan every line, but retain only a bounded selected prefix and complete output lines. */
async function scanText(
	chunks: AsyncIterable<Uint8Array>,
	start: number,
	end: number,
	signal?: AbortSignal,
): Promise<{ totalFileLines: number; firstLineBytes: number; truncation: TruncationResult }> {
	const decoder = new StringDecoder("utf8");
	let fileLine = 0;
	let selectedRecords = 0;
	let selectedBytes = 0;
	let lastSelectedLineBytes = 0;
	let firstLineBytes = 0;
	let lineBytes = 0;
	let linePrefix = "";
	let fullPrefix = "";
	const outputLines: string[] = [];
	let outputBytes = 0;
	let byteStoppedAt: number | undefined;
	const selected = () => fileLine >= start && fileLine < end;
	const finishLine = () => {
		if (selected()) {
			selectedRecords++;
			lastSelectedLineBytes = lineBytes;
			if (selectedRecords === 1) firstLineBytes = lineBytes;
			if (byteStoppedAt === undefined && outputLines.length < DEFAULT_MAX_LINES) {
				const bytes = lineBytes + (outputLines.length > 0 ? 1 : 0);
				if (outputBytes + bytes <= DEFAULT_MAX_BYTES) {
					outputLines.push(linePrefix);
					outputBytes += bytes;
				} else {
					byteStoppedAt = selectedRecords;
				}
			}
		}
		fileLine++;
		lineBytes = 0;
		linePrefix = "";
	};
	const consume = (text: string) => {
		let position = 0;
		while (position < text.length) {
			const newline = text.indexOf("\n", position);
			const stop = newline < 0 ? text.length : newline;
			if (selected()) {
				const fragment = text.slice(position, stop);
				const bytes = Buffer.byteLength(fragment, "utf8");
				lineBytes += bytes;
				selectedBytes += bytes;
				if (lineBytes <= DEFAULT_MAX_BYTES) linePrefix += fragment;
				if (selectedBytes <= DEFAULT_MAX_BYTES) fullPrefix += fragment;
			}
			if (newline < 0) break;
			finishLine();
			// A join separator belongs before the next selected line, not after this one.
			if (selected() && selectedRecords > 0) {
				selectedBytes++;
				if (selectedBytes <= DEFAULT_MAX_BYTES) fullPrefix += "\n";
			}
			position = newline + 1;
		}
	};

	const iterator = chunks[Symbol.asyncIterator]();
	let failure: unknown;
	let failed = false;
	let bytesSinceYield = 0;
	let chunksSinceYield = 0;
	try {
		checkReadAbort(signal);
		while (true) {
			checkReadAbort(signal);
			let onAbort: (() => void) | undefined;
			let next: IteratorResult<Uint8Array>;
			try {
				const aborted = new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(new Error("Operation aborted"));
					signal?.addEventListener("abort", onAbort, { once: true });
				});
				next = await Promise.race([iterator.next(), aborted]);
			} finally {
				if (onAbort) signal?.removeEventListener("abort", onAbort);
			}
			checkReadAbort(signal);
			if (next.done) break;
			for (let position = 0; position < next.value.byteLength; position += READ_CHUNK_BYTES) {
				checkReadAbort(signal);
				const piece = next.value.subarray(position, position + READ_CHUNK_BYTES);
				consume(decoder.write(piece));
				bytesSinceYield += piece.byteLength;
				// Synchronous custom sources and huge yields must not starve cancellation timers.
				if (bytesSinceYield >= READ_CHUNK_BYTES * 16) {
					await setImmediate();
					bytesSinceYield = 0;
				}
			}
			if (++chunksSinceYield >= 1024) {
				await setImmediate();
				chunksSinceYield = 0;
				bytesSinceYield = 0;
			}
		}
		consume(decoder.end());
		finishLine();
	} catch (error) {
		failed = true;
		failure = signal?.aborted ? new Error("Operation aborted") : error;
	} finally {
		try {
			await iterator.return?.();
		} catch (error) {
			if (!failed) {
				failed = true;
				failure = error;
			}
		}
	}
	if (failed) throw failure;
	checkReadAbort(signal);

	const totalLines = selectedRecords - (selectedRecords > 0 && lastSelectedLineBytes === 0 ? 1 : 0);
	if (selectedRecords > 0 && lastSelectedLineBytes === 0 && outputLines.length === selectedRecords) {
		outputLines.pop();
	}
	const truncated = totalLines > DEFAULT_MAX_LINES || selectedBytes > DEFAULT_MAX_BYTES;
	const firstLineExceedsLimit = truncated && firstLineBytes > DEFAULT_MAX_BYTES;
	const content = truncated ? (firstLineExceedsLimit ? "" : outputLines.join("\n")) : fullPrefix;
	return {
		totalFileLines: fileLine,
		firstLineBytes,
		truncation: {
			content,
			truncated,
			truncatedBy: !truncated
				? null
				: firstLineExceedsLimit ||
						(byteStoppedAt !== undefined && byteStoppedAt <= totalLines && outputLines.length < DEFAULT_MAX_LINES)
					? "bytes"
					: "lines",
			totalLines,
			totalBytes: selectedBytes,
			outputLines: truncated ? (firstLineExceedsLimit ? 0 : outputLines.length) : totalLines,
			outputBytes: Buffer.byteLength(content, "utf8"),
			lastLinePartial: false,
			firstLineExceedsLimit,
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		},
	};
}

export interface ReadToolOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
	/** Fallback resize profile when the execution context has no model metadata. */
	resizeOptions?: ModelImageResizeOptions;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

/** The image block and its note, or the text for text files and images that could not be processed. */
function toReadOutput(content: (TextContent | ImageContent)[]): ReadToolOutput {
	const text = content.find((block) => block.type === "text")?.text ?? "";
	const image = content.find((block) => block.type === "image");
	return image ? { type: "image", data: image.data, mimeType: image.mimeType, note: text } : text;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const fallbackResizeOptions = options?.resizeOptions;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		outputSchema: readOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					let scanning = false;
					const onAbort = () => {
						aborted = true;
						if (!scanning) reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
							if (aborted) throw new Error("Operation aborted");
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) throw new Error("Operation aborted");
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							if (aborted) throw new Error("Operation aborted");
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								if (aborted) throw new Error("Operation aborted");
								const processed = await processImage(buffer, mimeType, {
									autoResizeImages,
									resizeOptions: ctx?.model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
								});
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Preserve slice's numeric coercion, including EOF-relative negative end indices.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								let legacyBuffer: Buffer | undefined;
								const source = async () => {
									checkReadAbort(signal);
									if (ops.readChunks) {
										scanning = true;
										return ops.readChunks(absolutePath, signal);
									}
									legacyBuffer ??= await ops.readFile(absolutePath);
									checkReadAbort(signal);
									scanning = true;
									return legacyReadChunks(legacyBuffer);
								};
								const requestedEnd = limit === undefined ? Infinity : startLine + limit;
								let end = Number.isNaN(requestedEnd) ? 0 : Math.trunc(requestedEnd);
								if (end < 0 && Number.isFinite(end)) {
									// Negative slice ends depend on EOF. Count first without retaining text.
									const counted = await scanText(await source(), Infinity, Infinity, signal);
									scanning = false;
									end = Math.max(0, counted.totalFileLines + end);
								}
								const { totalFileLines, firstLineBytes, truncation } = await scanText(
									await source(),
									Math.trunc(startLine),
									Math.max(0, end),
									signal,
								);
								scanning = false;
								if (startLine >= totalFileLines) {
									throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
								}
								const userLimitedLines =
									limit === undefined ? undefined : Math.min(startLine + limit, totalFileLines) - startLine;
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									if (!Number.isInteger(startLine)) {
										// Legacy array indexing returned undefined for fractional offsets here.
										const missingLine: string[] = [];
										Buffer.byteLength(missingLine[startLine], "utf-8");
									}
									const firstLineSize = formatSize(firstLineBytes);
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = totalFileLines - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) throw new Error("Operation aborted");
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error) {
							signal?.removeEventListener("abort", onAbort);
							reject(aborted ? new Error("Operation aborted") : error);
						}
					})();
				},
			).then((result) => ({ ...result, structuredContent: toReadOutput(result.content) }));
		},
		...readRenderers,
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
