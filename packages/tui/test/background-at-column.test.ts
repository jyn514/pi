import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getActiveBackgroundAnsi, getBackgroundAtColumn } from "../src/index.ts";

describe("background at a visible column", () => {
	for (const [ansi, color] of [
		["\x1b[41m", { kind: "indexed", index: 1 }],
		["\x1b[103m", { kind: "indexed", index: 11 }],
		["\x1b[48;5;237m", { kind: "indexed", index: 237 }],
		["\x1b[48;2;17;80;140m", { kind: "rgb", r: 17, g: 80, b: 140 }],
	] as const) {
		it(`observes ${JSON.stringify(ansi)} before the closing reset`, () => {
			const line = `${ansi}panel\x1b[49m`;
			assert.deepEqual(getBackgroundAtColumn(line, 4), { ansi, color });
			assert.equal(getActiveBackgroundAnsi(line), "");
		});
	}

	it("follows resets, combined attributes, and wide columns", () => {
		const line = "\x1b[1;48;5;240m界\x1b[39mX\x1b[49mY";
		for (const column of [0, 1, 2]) {
			assert.deepEqual(getBackgroundAtColumn(line, column), {
				ansi: "\x1b[48;5;240m",
				color: { kind: "indexed", index: 240 },
			});
		}
		assert.equal(getBackgroundAtColumn(line, 3), undefined);
		assert.equal(getBackgroundAtColumn("\x1b[44mX\x1b[0mY", 1), undefined);
		assert.equal(getBackgroundAtColumn("plain", 2), undefined);
	});

	it("ignores invalid channels at the ANSI output boundary", () => {
		for (const ansi of ["\x1b[48;5;999m", "\x1b[48;2;300;2;3m"]) {
			assert.equal(getBackgroundAtColumn(`${ansi}panel`, 0), undefined);
		}
	});
});
