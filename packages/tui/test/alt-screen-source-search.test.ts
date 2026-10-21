import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AltScreenSearchComponent,
	findAltScreenSourceMatches,
	getAltScreenSearchMatchKey,
	getAltScreenSourceExcerpt,
} from "../src/alt-screen-search.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";

describe("original-text transcript matching", () => {
	it("preserves UTF-16 offsets, Unicode case folding, whitespace, and repeated occurrence identity", () => {
		const text = "🙂 Kelvin\t\n界  kelvin\u00a0界";
		const matches = findAltScreenSourceMatches([{ id: "unit", fragments: [text] }], "  KELVIN \n界 ");
		assert.deepEqual(matches, [
			{ unitId: "unit", fragmentIndex: 0, start: 3, end: 12 },
			{ unitId: "unit", fragmentIndex: 0, start: 14, end: 22 },
		]);
		assert.deepEqual(
			matches.map((match) => text.slice(match.start, match.end)),
			["Kelvin\t\n界", "kelvin\u00a0界"],
		);
		assert.equal(new Set(matches.map(getAltScreenSearchMatchKey)).size, 2);
	});

	it("escapes regex literals and never joins fragments or units", () => {
		const units = [
			{ id: "one", fragments: ["a.* a.*", "first", "second"] },
			{ id: "two", fragments: ["second", "first"] },
		];
		assert.equal(findAltScreenSourceMatches(units, "a.*").length, 2);
		assert.deepEqual(findAltScreenSourceMatches(units, "first second"), []);
		assert.deepEqual(findAltScreenSourceMatches(units, "second first"), []);
		assert.deepEqual(findAltScreenSourceMatches(units, " \n\t"), []);
	});

	it("bounds and sanitizes excerpts and moves mouse controls with the optional excerpt row", () => {
		const fragment = `${"前".repeat(100)}needle\x00\x07\x08\x1b[2J\x85\n${"🙂".repeat(200)}`;
		const match = findAltScreenSourceMatches([{ id: "unit", fragments: [fragment] }], "needle")[0]!;
		const excerpt = getAltScreenSourceExcerpt(fragment, match);
		assert.ok(excerpt.length < 220);
		assert.ok(excerpt.includes("needle"));
		assert.doesNotMatch(excerpt, /[\x00-\x1f\x7f-\x9f]/u);
		const component = new AltScreenSearchComponent(() => {});
		component.setExcerpt(excerpt);
		for (const width of [1, 2, 4, 8, 15, 32, 80]) {
			const lines = component.render(width).map(stripTerminalSequences);
			assert.equal(lines.length, 4);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			if (width >= 15) assert.ok(lines[2]!.includes("needle"));
			const next = lines[3]!.indexOf("↓");
			if (next >= 0) {
				assert.equal(component.getNavigationDirectionAt(3, next), 1);
				assert.equal(component.getNavigationDirectionAt(2, next), undefined);
			}
		}
		component.setExcerpt(undefined);
		assert.equal(component.render(32).length, 3);
	});
});
