import { beforeAll, describe, expect, test, vi } from "vitest";
import { highlightCode, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { highlight } from "../src/utils/syntax-highlight.ts";

beforeAll(() => initTheme("dark"));

const fixtures = [
	{ language: "python", code: '"""\nvisible <&>\n\nHIDDEN_TAIL\n"""\n\n' },
	{ language: "javascript", code: "const obj = {\n  before: 0,\n  answer\n\n: 42\n};\n" },
	{ language: "javascript", code: "const value = `first\nsecond $" + "{42}\n<&>\nlast`;\n" },
];

describe.each(fixtures)("budgeted $language formatting for $code", ({ language, code }) => {
	test.each([0, 1, 2, 3, 20])("budget %s is exactly the full highlight's visible prefix", (maxOutputLines) => {
		const options = {
			language,
			ignoreIllegals: true,
			theme: {
				default: (text: string) => `[default:${text}]`,
				string: (text: string) => `[string:${text}]`,
				subst: (text: string) => `[subst:${text}]`,
				attr: (text: string) => `[attr:${text}]`,
			},
		};
		expect(highlight(code, { ...options, maxOutputLines })).toBe(
			highlight(code, options).split("\n").slice(0, maxOutputLines).join("\n"),
		);
		expect(highlightCode(code, language, maxOutputLines)).toEqual(
			highlightCode(code, language).slice(0, maxOutputLines),
		);
	});
});

test.each([0, 1, 3])("formatters never receive hidden lines with output budget %s", (maxOutputLines) => {
	const format = vi.fn((text: string) => `[${text}]`);
	const code = '"""\nvisible <&>\n\nHIDDEN_TAIL\n"""';
	highlight(code, { language: "python", maxOutputLines, theme: { string: format, default: format } });
	expect(format.mock.calls.every(([text]) => !text.includes("HIDDEN_TAIL"))).toBe(true);
	if (maxOutputLines === 0) expect(format).not.toHaveBeenCalled();
	else expect(format).toHaveBeenCalledWith('"""');
	if (maxOutputLines === 3) expect(format).toHaveBeenCalledWith("visible <&>");
});

test.each([undefined, "not-a-language"])("plaintext fallback for %s respects the output budget", (language) => {
	const code = "first\n\nlast\n\n";
	for (const budget of [0, 1, 3, 20]) {
		expect(highlightCode(code, language, budget)).toEqual(highlightCode(code, language).slice(0, budget));
	}
});
