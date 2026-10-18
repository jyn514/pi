import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { fauxAssistantMessage, fauxToolCall, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness as createSessionHarness, type Harness as SessionHarness } from "./suite/harness.ts";
import { createHarness, type Harness } from "./test-harness.ts";

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/** A solid gray RGB PNG of the given size, base64 encoded. */
function createPng(width: number, height: number): string {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.alloc(1 + width * 3, 0x80);
	row[0] = 0;
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

function persistedUserContent(harness: Harness, text: string): (TextContent | ImageContent)[] {
	for (const entry of harness.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		if (typeof content === "string") continue;
		if (content[0]?.type === "text" && content[0].text.split("\n")[0] === text) return content;
	}
	throw new Error(`No user message "${text}"`);
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("AgentSession queued message images", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	// Regression test for #11738: queued messages skipped the image resize idle prompts get.
	it("resizes images in steering, follow-up, and streaming prompt messages", async () => {
		harness = await createHarness({ responses: [{ text: "first", delayMs: 300 }, "second", "third", "fourth"] });
		const image: ImageContent = { type: "image", data: createPng(1200, 9000), mimeType: "image/png" };

		const run = harness.session.prompt("idle");
		await waitFor(() => harness!.session.isStreaming);
		await harness.session.steer("steer", [image]);
		await harness.session.followUp("follow up", [image]);
		await harness.session.prompt("streaming prompt", { images: [image], streamingBehavior: "followUp" });
		await run;
		await waitFor(() => !harness!.session.isStreaming && harness!.faux.callCount >= 4);

		for (const text of ["steer", "follow up", "streaming prompt"]) {
			const content = persistedUserContent(harness, text);
			const images = content.filter((block): block is ImageContent => block.type === "image");
			expect(images).toHaveLength(1);
			expect(images[0].data).not.toBe(image.data);
			expect((content[0] as TextContent).text).toContain("original 1200x9000, displayed at 267x2000");
		}
		const sentImages = harness.faux.contexts
			.flatMap((context) => context.messages)
			.flatMap((message): readonly { type: string }[] =>
				typeof message.content === "string" ? [] : message.content,
			)
			.filter((block): block is ImageContent => block.type === "image");
		expect(sentImages.length).toBeGreaterThan(0);
		expect(sentImages.some((block) => block.data === image.data)).toBe(false);
		expect(harness.session.pendingMessageCount).toBe(0);
	});
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function expectResized(content: string | (TextContent | ImageContent)[], original: ImageContent): void {
	if (typeof content === "string") throw new Error("Expected image content");
	const images = content.filter((part): part is ImageContent => part.type === "image");
	expect(images).toHaveLength(1);
	expect(images[0].data).not.toBe(original.data);
	const decoded = PhotonImage.new_from_byteslice(Buffer.from(images[0].data, "base64"));
	try {
		expect([decoded.get_width(), decoded.get_height()]).toEqual([267, 2000]);
	} finally {
		decoded.free();
	}
	const text = content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	expect(text.match(/original 1200x9000, displayed at 267x2000/g)).toHaveLength(1);
}

describe("AgentSession prepared input images", () => {
	const harnesses: SessionHarness[] = [];
	const directories: string[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	const deliveries = ["initial", "steer", "followUp", "nextTurn"] as const;
	const shapes = ["text-first", "image-first", "image-only"] as const;
	const cases = deliveries.flatMap((delivery) => shapes.map((shape) => ({ delivery, shape })));

	it.each(cases)(
		"normalizes $shape prepared input at $delivery delivery before events, persistence, and the provider",
		async ({ delivery, shape }) => {
			const entered = deferred();
			const release = deferred();
			const harness = await createSessionHarness({
				settings: { images: { autoResize: true }, compaction: { enabled: false }, retry: { enabled: false } },
				tools: [
					{
						name: "hold",
						label: "Hold",
						description: "Wait for queued input",
						parameters: Type.Object({}),
						execute: async () => {
							entered.resolve();
							await release.promise;
							return { content: [], details: {} };
						},
					},
				],
			});
			harnesses.push(harness);
			const image: ImageContent = { type: "image", data: createPng(1200, 9000), mimeType: "image/png" };
			const text: TextContent = { type: "text", text: "prepared payload" };
			const content = shape === "image-only" ? [image] : shape === "image-first" ? [image, text] : [text, image];
			let sent: (TextContent | ImageContent)[] | undefined;
			harness.setResponses([
				...(delivery === "steer" || delivery === "followUp"
					? [fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" })]
					: []),
				// Follow-up input waits for the tool-result response to finish before delivery.
				...(delivery === "followUp" ? [fauxAssistantMessage("tool completed")] : []),
				(context) => {
					const message = context.messages.find(
						(message) =>
							typeof message.content !== "string" && message.content.some((part) => part.type === "image"),
					);
					if (message && typeof message.content !== "string")
						sent = message.content.filter(
							(part): part is TextContent | ImageContent => part.type === "text" || part.type === "image",
						);
					return fauxAssistantMessage("done");
				},
			]);
			const running = delivery === "steer" || delivery === "followUp" ? harness.session.prompt("start") : undefined;
			try {
				if (running) await entered.promise;
				const result = await harness.session.submitInput({
					kind: "prepared",
					message: { customType: "prepared-images", content, display: true, details: { shape } },
					options: delivery === "initial" ? { triggerTurn: true } : { triggerTurn: true, deliverAs: delivery },
				});
				expect(result).toEqual({ disposition: delivery === "initial" ? "started" : "queued" });
			} finally {
				release.resolve();
			}
			if (delivery === "nextTurn") await harness.session.prompt("deliver prepared context");
			await running;
			await harness.session.waitForIdle();
			expect(sent).toBeDefined();
			expectResized(sent!, image);
			const persisted = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "custom_message" && entry.customType === "prepared-images");
			if (persisted?.type !== "custom_message") throw new Error("Missing prepared input in transcript");
			expectResized(persisted.content, image);
			expect(persisted.details).toEqual({ shape });
			const started = harness
				.eventsOfType("message_start")
				.find((event) => event.message.role === "custom" && event.message.customType === "prepared-images");
			if (started?.message.role !== "custom") throw new Error("Missing prepared message_start");
			expectResized(started.message.content, image);
			expect(harness.session.pendingMessageCount).toBe(0);
		},
	);

	it("normalizes captured image-only steering input after reopening and prepared nextTurn replay", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-prepared-images-"));
		directories.push(directory);
		const original = await createSessionHarness({ sessionManager: SessionManager.create(directory, directory) });
		harnesses.push(original);
		const image: ImageContent = { type: "image", data: createPng(1200, 9000), mimeType: "image/png" };
		await original.session.steer("", [image]);
		expect(original.session.pendingMessageCount).toBe(1);
		const saved = await original.session.handoff("prepared-images");
		expect(original.session.pendingMessageCount).toBe(0);
		expect(saved.pending.steering).toHaveLength(1);
		const captured = saved.pending.steering[0];
		if (captured.role !== "user") throw new Error("Expected captured user input");
		const reopened = await createSessionHarness({ sessionManager: SessionManager.open(saved.sessionFile) });
		harnesses.push(reopened);
		let sent: (TextContent | ImageContent)[] | undefined;
		reopened.setResponses([
			(context) => {
				const message = context.messages.find(
					(message) =>
						typeof message.content !== "string" && message.content.some((part) => part.type === "image"),
				);
				if (message && typeof message.content !== "string")
					sent = message.content.filter(
						(part): part is TextContent | ImageContent => part.type === "text" || part.type === "image",
					);
				return fauxAssistantMessage("recovered");
			},
		]);
		expect(
			await reopened.session.submitInput({
				kind: "prepared",
				message: { customType: "replayed-images", content: captured.content, display: true },
				options: { deliverAs: "nextTurn" },
			}),
		).toEqual({ disposition: "queued" });
		await reopened.session.prompt("continue");
		expectResized(sent!, image);
		const persisted = SessionManager.open(saved.sessionFile)
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "replayed-images");
		if (persisted?.type !== "custom_message") throw new Error("Missing replayed input on disk");
		expectResized(persisted.content, image);
		expect(reopened.session.pendingMessageCount).toBe(0);
	});
});
