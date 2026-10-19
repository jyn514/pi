import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { truncateToVisualLines, VisualLinePreview } from "../src/modes/interactive/components/visual-truncate.ts";

const fixtures = [
	"",
	" \t\r\n ",
	"first\nsecond\nthird\nfourth\nfifth",
	"first\r\nsecond\rthird\n",
	"\x1b[4;31mfirst\nsecond third fourth\x1b[24;39m fifth",
	"\x1b]8;;https://example.com\x07long-link-label-that-wraps\ncontinued\x1b]8;;\x07",
	"\x1b]8;;https://example.com\x1b\\long-link-label-that-wraps\ncontinued\x1b]8;;\x1b\\",
	"\x1b]133;A\x07first\nsecond\x1b]133;B\x07",
	"\tfirst\tsecond\n\tthird\t",
	"中文 e\u0301 👩‍💻 🇨 กํา\nmore 中文",
	"a".repeat(301),
	"word ".repeat(71),
];

// Fixed seed and explicit fixtures cover styles crossing discarded lines, newline forms,
// tabs, wide/combining graphemes, and long logical lines without another test dependency.
let seed = 0x51aa902;
const fragments = ["word", "  ", "\t", "\n", "\r", "\r\n", "\x1b[31m", "\x1b[0m", "中文", "e\u0301", "👩‍💻"];
for (let i = 0; i < 64; i++) {
	let text = "";
	for (let j = 0; j < 12; j++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		text += fragments[seed % fragments.length];
	}
	fixtures.push(text);
}

describe("visual line previews", () => {
	test("match fully rendered Text at either end, including padding and exact hidden counts", () => {
		for (const text of fixtures) {
			for (const width of [1, 2, 10, 40]) {
				for (const paddingX of [0, 1, 3]) {
					const rendered = new Text(text, paddingX, 0).render(width);
					for (const limit of [0, 1, 3, 100]) {
						for (const keep of ["start", "end"] as const) {
							const expected =
								limit === 0 ? [] : keep === "start" ? rendered.slice(0, limit) : rendered.slice(-limit);
							expect(
								truncateToVisualLines(text, limit, width, paddingX, keep),
								JSON.stringify({ text, width, paddingX, limit, keep }),
							).toEqual({ visualLines: expected, skippedCount: Math.max(0, rendered.length - limit) });
						}
					}
				}
			}
		}
	});

	test.each(["start", "end"] as const)("updates %s previews and hints when the terminal width changes", (keep) => {
		const text = "first second third fourth fifth sixth";
		const preview = new VisualLinePreview({
			text,
			maxVisualLines: 2,
			keep,
			formatHint: (hidden) => `${hidden} hidden`,
		});
		for (const width of [10, 40, 10]) {
			const all = new Text(text, 0, 0).render(width);
			const retained = keep === "start" ? all.slice(0, 2) : all.slice(-2);
			const hidden = all.length - retained.length;
			const hint = `${hidden} hidden`;
			expect(preview.render(width)).toEqual(
				hidden === 0 ? retained : keep === "start" ? [...retained, hint] : [hint, ...retained],
			);
		}
		preview.invalidate();
		expect(preview.render(40)).toEqual(new Text(text, 0, 0).render(40));
	});
});
