import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const mocks = vi.hoisted(() => ({
	readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: vi.fn(),
	readClipboardFilePaths: mocks.readClipboardFilePaths,
	readClipboardText: mocks.readClipboardText,
}));
vi.mock("../src/utils/clipboard-image.ts", () => ({
	extensionForImageMimeType: () => "png",
	readClipboardImage: mocks.readClipboardImage,
}));

beforeEach(() => vi.resetAllMocks());

test.each([false, true])("image pastes use the session target directory (already exists: %s)", async (exists) => {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-image-paste-"));
	const target = path.join(cwd, "target");
	try {
		if (exists) mkdirSync(target);
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		mocks.readClipboardFilePaths.mockResolvedValue(null);
		mocks.readClipboardImage.mockResolvedValue({ bytes, mimeType: "image/png" });
		const insertTextAtCursor = vi.fn<(text: string) => void>();
		const context = {
			sessionManager: { getCwd: () => cwd },
			editor: { insertTextAtCursor },
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const prototype = InteractiveMode.prototype as unknown as {
			handleClipboardPaste(this: typeof context): Promise<void>;
		};

		await prototype.handleClipboardPaste.call(context);
		await prototype.handleClipboardPaste.call(context);

		expect(context.showError).not.toHaveBeenCalled();
		expect(insertTextAtCursor).toHaveBeenCalledTimes(2);
		const paths = insertTextAtCursor.mock.calls.map(([filePath]) => filePath);
		expect(new Set(paths).size).toBe(2);
		for (const filePath of paths) {
			expect(path.dirname(filePath)).toBe(target);
			expect(path.extname(filePath)).toBe(".png");
			expect(readFileSync(filePath)).toEqual(Buffer.from(bytes));
		}
		expect(readdirSync(target).length).toBe(2);
		expect(context.ui.requestRender).toHaveBeenCalledTimes(2);
		expect(mocks.readClipboardText).not.toHaveBeenCalled();
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("image paste reports a target directory creation failure without inserting a path", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-image-paste-"));
	try {
		writeFileSync(path.join(cwd, "target"), "not a directory");
		mocks.readClipboardFilePaths.mockResolvedValue(null);
		mocks.readClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/png" });
		const context = {
			sessionManager: { getCwd: () => cwd },
			editor: { insertTextAtCursor: vi.fn() },
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const prototype = InteractiveMode.prototype as unknown as {
			handleClipboardPaste(this: typeof context): Promise<void>;
		};

		await prototype.handleClipboardPaste.call(context);

		expect(context.showError).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("Failed to paste from clipboard:"),
		);
		expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
		expect(mocks.readClipboardText).not.toHaveBeenCalled();
		expect(readFileSync(path.join(cwd, "target"), "utf8")).toBe("not a directory");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Finder file paths take precedence over their icon image", async () => {
	// Regression test for #9999.
	const filePaths = ["/tmp/screenshot.png", "/tmp/My Photos/photo.png"];
	mocks.readClipboardFilePaths.mockResolvedValue(filePaths);
	mocks.readClipboardImage.mockResolvedValue({
		bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
		mimeType: "image/png",
	});
	mocks.readClipboardText.mockResolvedValue(null);
	const insertTextAtCursor = vi.fn<(text: string) => void>();
	const context = {
		editor: { insertTextAtCursor },
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};

	await prototype.handleClipboardPaste.call(context);
	expect(insertTextAtCursor).toHaveBeenCalledExactlyOnceWith(filePaths.join("\n"));
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
});

test("clipboard file paths containing terminal control characters are rejected", async () => {
	const insertTextAtCursor = vi.fn<(text: string) => void>();
	const showError = vi.fn<(message: string) => void>();
	mocks.readClipboardFilePaths.mockResolvedValue(["/tmp/photo\x1b]0;unsafe\x07.png"]);
	const context = {
		editor: { insertTextAtCursor },
		showError,
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};

	await prototype.handleClipboardPaste.call(context);

	expect(insertTextAtCursor).not.toHaveBeenCalled();
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
	expect(showError).toHaveBeenCalledExactlyOnceWith(
		"Failed to paste from clipboard: Clipboard file path contains control characters",
	);
});

test("native file-path errors are shown without falling through to the icon image", async () => {
	const showError = vi.fn<(message: string) => void>();
	mocks.readClipboardFilePaths.mockRejectedValue(new Error("Native clipboard file read failed"));
	const context = {
		editor: { insertTextAtCursor: vi.fn() },
		showError,
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};

	await prototype.handleClipboardPaste.call(context);

	expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
	expect(showError).toHaveBeenCalledExactlyOnceWith(
		"Failed to paste from clipboard: Native clipboard file read failed",
	);
});

test.each([
	["punctuation", "Review:", 7],
	["Unicode text", "確認", 2],
])("clipboard file paths are separated from preceding %s", async (_description, editorText, cursorCol) => {
	const insertTextAtCursor = vi.fn<(text: string) => void>();
	mocks.readClipboardFilePaths.mockResolvedValue(["/tmp/photo.png"]);
	const context = {
		editor: {
			getCursor: () => ({ line: 0, col: cursorCol }),
			getText: () => editorText,
			insertTextAtCursor,
		},
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};

	await prototype.handleClipboardPaste.call(context);

	expect(insertTextAtCursor).toHaveBeenCalledExactlyOnceWith(" /tmp/photo.png");
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
});

test("bash mode shell-quotes file paths and inserts them as arguments", async () => {
	const insertTextAtCursor = vi.fn<(text: string) => void>();
	mocks.readClipboardFilePaths.mockResolvedValue([
		"/tmp/My Photos/photo.png",
		"/tmp/$(touch hacked).png",
		"/tmp/plain.png",
	]);
	const context = {
		editor: {
			getCursor: () => ({ line: 0, col: 3 }),
			getText: () => "catDEST",
			insertTextAtCursor,
		},
		isBashMode: true,
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};

	await prototype.handleClipboardPaste.call(context);

	expect(insertTextAtCursor).toHaveBeenCalledExactlyOnceWith(
		" '/tmp/My Photos/photo.png' '/tmp/$(touch hacked).png' /tmp/plain.png ",
	);
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
});
