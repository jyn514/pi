import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Text } from "../src/components/text.ts";

const text = "\x1b[31mwrapped 界 content\x1b[39m\nsecond line";
const background = (line: string): string => `\x1b[44m${line}\x1b[49m`;

function createBox(paddingY: number): Box {
	const box = new Box(1, paddingY, background);
	box.addChild(new Text(text, 0, 0));
	return box;
}

// A padding change must invalidate same-width output without rebuilding live content.
// Fresh constructors supply the oracle so wrapping and color changes remain valid.
describe("mutable vertical padding", () => {
	for (const [name, create] of [
		["Box", createBox],
		["Text", (paddingY: number) => new Text(text, 1, paddingY, background)],
	] as const) {
		it(`updates cached ${name} output like a fresh component at each padding and width`, () => {
			const component = create(0);
			for (const width of [12, 30]) {
				component.setPaddingY(0);
				const original = component.render(width);
				assert.strictEqual(component.render(width), original);
				for (const paddingY of [2, 1, 0]) {
					component.setPaddingY(paddingY);
					const lines = component.render(width);
					assert.deepEqual(lines, create(paddingY).render(width));
					assert.equal(lines.length, original.length + paddingY * 2);
					assert.strictEqual(component.render(width), lines);
				}
			}
		});
	}

	it("retains Box child identity and invalidates only its own padding cache", () => {
		let invalidations = 0;
		const child = { render: () => ["live content"], invalidate: () => invalidations++ };
		const box = new Box(0, 0);
		box.addChild(child);
		box.render(20);
		box.setPaddingY(2);
		assert.equal(box.render(20).length, 5);
		assert.strictEqual(box.children[0], child);
		assert.equal(invalidations, 0);
	});

	it("keeps empty components absent after padding changes", () => {
		for (const component of [new Box(0, 0), new Text("", 0, 0)]) {
			component.render(20);
			component.setPaddingY(2);
			assert.deepEqual(component.render(20), []);
		}
	});
});
