/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import type { WriteStream } from "node:fs";
import { splitIncompleteAnsiSuffix, stripAnsi } from "../utils/ansi.ts";
import { createOutputFileStream } from "../utils/output-files.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	let discardedOutput = false;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;
	// The interactive component retains every streamed chunk until the command finishes.
	const maxStreamBytes = 1024 * 1024;
	let streamBytes = 0;
	let streamTruncated = false;

	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		({ path: tempFilePath, stream: tempFileStream } = createOutputFileStream("pi-bash", ".log"));
		for (const chunk of outputChunks) {
			tempFileStream.write(chunk);
		}
	};

	const decoder = new TextDecoder();
	// Unfinished escape sequence at the end of the previous chunk, completed by the next chunk.
	let pendingAnsi = "";

	const appendText = (rawText: string) => {
		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(rawText)).replace(/\r/g, "");
		if (!text) {
			return;
		}

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
			discardedOutput = true;
		}

		// Stream to callback
		if (options?.onChunk) {
			if (!streamTruncated) {
				const bytes = Buffer.from(text);
				const remaining = maxStreamBytes - streamBytes;
				if (bytes.length <= remaining) {
					streamBytes += bytes.length;
					options.onChunk(text);
				} else {
					let end = remaining;
					while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
					if (end > 0) options.onChunk(bytes.subarray(0, end).toString("utf8"));
					streamTruncated = true;
					options.onChunk("\n[Live output truncated at 1 MiB; full output is saved to a log.]\n");
				}
			}
		}
	};

	const onData = (data: Buffer) => {
		totalBytes += data.length;
		const { complete, pending } = splitIncompleteAnsiSuffix(pendingAnsi + decoder.decode(data, { stream: true }));
		pendingAnsi = pending;
		appendText(complete);
	};

	const flushOutput = () => {
		const rest = pendingAnsi + decoder.decode();
		pendingAnsi = "";
		appendText(rest);
	};

	let exitCode: number | null = null;
	try {
		({ exitCode } = await operations.exec(command, cwd, { onData, signal: options?.signal }));
	} catch (err) {
		// An aborted command still returns the output it produced so far
		if (!options?.signal?.aborted) {
			tempFileStream?.end();
			throw err;
		}
	}

	flushOutput();
	const fullOutput = outputChunks.join("");
	const truncationResult = truncateTail(fullOutput);
	if (truncationResult.truncated) {
		ensureTempFile();
	}
	tempFileStream?.end();
	const cancelled = options?.signal?.aborted ?? false;

	return {
		output: truncationResult.truncated ? truncationResult.content : fullOutput,
		exitCode: cancelled ? undefined : (exitCode ?? undefined),
		cancelled,
		truncated: discardedOutput || truncationResult.truncated,
		fullOutputPath: tempFilePath,
	};
}
