import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wrapTextWithAnsiLines } from "../src/utils.ts";

describe("incremental ANSI wrapping", () => {
	it("keeps literal-newline styling separate for interleaved consumers", () => {
		const red = wrapTextWithAnsiLines("\x1b[31mfirst\nsecond\x1b[0m", 10);
		const blue = wrapTextWithAnsiLines("\x1b[34mother\r\nlast\x1b[0m", 10);
		assert.deepEqual(red.next(), { value: "\x1b[31mfirst", done: false });
		assert.deepEqual(blue.next(), { value: "\x1b[34mother", done: false });
		assert.deepEqual(red.next(), { value: "\x1b[31msecond\x1b[0m", done: false });
		assert.deepEqual(blue.next(), { value: "\x1b[34mlast\x1b[0m", done: false });
		assert.equal(red.next().done, true);
		assert.equal(blue.next().done, true);
	});

	it("closes and reopens a BEL-terminated hyperlink while splitting a long word", () => {
		const open = "\x1b]8;;https://example.com\x07";
		const close = "\x1b]8;;\x07";
		assert.deepEqual(
			[...wrapTextWithAnsiLines(`${open}abcdefgh${close}`, 3)],
			[`${open}abc${close}`, `${open}def${close}`, `${open}gh${close}`],
		);
	});

	it("preserves empty logical lines, including the final newline", () => {
		assert.deepEqual([...wrapTextWithAnsiLines("first\n\nlast\n", 10)], ["first", "", "last", ""]);
		assert.deepEqual([...wrapTextWithAnsiLines("", 10)], [""]);
	});
});
