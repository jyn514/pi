import { describe, expect, it } from "vitest";
import { CodemodeSourceError, parseCodemodeSource } from "../src/source.ts";

describe("parseCodemodeSource", () => {
	it("returns plain code unchanged", () => {
		expect(parseCodemodeSource("text('hi')")).toEqual({ code: "text('hi')", options: {} });
		expect(parseCodemodeSource("// just a comment\nreturn 1")).toEqual({
			code: "// just a comment\nreturn 1",
			options: {},
		});
	});

	it("parses the options line and keeps line numbers", () => {
		expect(parseCodemodeSource('// @options: {"timeout_ms": 10}\nconst a = 1;\ntext(a)')).toEqual({
			code: "\nconst a = 1;\ntext(a)",
			options: { timeoutMs: 10 },
		});
		expect(parseCodemodeSource('  // @options:{"max_output_tokens":0,"timeout_ms":1500}\r\ntext(1)').options).toEqual(
			{
				maxCombinedOutputTokens: 0,
				timeoutMs: 1500,
			},
		);
		expect(parseCodemodeSource("// @options: {}\ntext(1)")).toEqual({ code: "\ntext(1)", options: {} });
	});

	it("parses independent output budgets and normalizes the legacy combined alias", () => {
		for (const field of ["max_combined_output_tokens", "max_output_tokens"]) {
			expect(
				parseCodemodeSource(`// @options: {"max_call_output_tokens":7,"${field}":23}\ntext(1)`).options,
			).toEqual({ maxCallOutputTokens: 7, maxCombinedOutputTokens: 23 });
		}
		expect(parseCodemodeSource('// @options: {"max_call_output_tokens":0}\ntext(1)').options).toEqual({
			maxCallOutputTokens: 0,
		});
	});

	it("validates each output budget independently", () => {
		for (const field of ["max_call_output_tokens", "max_combined_output_tokens", "max_output_tokens"]) {
			for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
				const options = parseCodemodeSource(`// @options: ${JSON.stringify({ [field]: value })}\ntext(1)`).options;
				expect(options).toEqual({
					[field === "max_call_output_tokens" ? "maxCallOutputTokens" : "maxCombinedOutputTokens"]: value,
				});
			}
			for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", true, null, [], {}]) {
				expect(() => parseCodemodeSource(`// @options: ${JSON.stringify({ [field]: value })}\ntext(1)`)).toThrow(
					`@options field \`${field}\` must be a non-negative safe integer`,
				);
			}
		}
	});

	it("rejects alias and canonical combined budgets together, even when equal or zero", () => {
		for (const [alias, canonical] of [
			[1, 2],
			[1, 1],
			[0, 0],
		]) {
			expect(() =>
				parseCodemodeSource(
					`// @options: {"max_output_tokens":${alias},"max_combined_output_tokens":${canonical}}\ntext(1)`,
				),
			).toThrow("Supply only one of `max_output_tokens` and `max_combined_output_tokens`");
		}
	});

	it("only treats the first line as an options line", () => {
		expect(parseCodemodeSource("// @optionsx {}\ntext(1)").options).toEqual({});
		expect(parseCodemodeSource('text("// @options: {}")').options).toEqual({});
	});

	// #10631: an options line after the first line used to be ignored, so its timeout never applied.
	it("rejects an options line that is not the first line", () => {
		const cases: [string, number][] = [
			['// count things\n// @options: {"timeout_ms": 1000}\nwhile (true) {}', 2],
			['\n  // @options: {"timeout_ms": 1000}\nwhile (true) {}', 2],
			['text(1)\r\n// @options: {"timeout_ms": 1}', 2],
			['// @options: {"timeout_ms": 1}\ntext(1)\n// @options: {"timeout_ms": 2}', 3],
		];
		for (const [input, line] of cases) {
			expect(() => parseCodemodeSource(input), input).toThrow(CodemodeSourceError);
			expect(() => parseCodemodeSource(input), input).toThrow(
				`The // @options: line must be the first line of the input; found one on line ${line}`,
			);
		}
	});

	it("rejects empty input and invalid options", () => {
		const cases: [string, string | RegExp][] = [
			["", /Expected JavaScript source text \(non-empty\)/],
			["  \n", /Expected JavaScript source text \(non-empty\)/],
			["// @options:\ntext(1)", /@options must be a JSON object with supported fields/],
			["// @options: {timeout_ms: 1}\ntext(1)", /@options must be valid JSON with supported fields/],
			["// @options: [1]\ntext(1)", /@options must be a JSON object with supported fields/],
			[
				'// @options: {"yield": 1}\ntext(1)',
				"@options only supports `max_call_output_tokens`, `max_combined_output_tokens`, `max_output_tokens`, and `timeout_ms`; got `yield`",
			],
			[
				'// @options: {"max_output_tokens": 1.5}\ntext(1)',
				"@options field `max_output_tokens` must be a non-negative safe integer",
			],
			['// @options: {"timeout_ms": 0}\ntext(1)', /@options field `timeout_ms` must be a positive integer/],
			[
				'// @options: {"timeout_ms": 1}',
				"The @options line must be followed by JavaScript source on subsequent lines",
			],
			[
				'// @options: {"timeout_ms": 1}\n  \n',
				"The @options line must be followed by JavaScript source on subsequent lines",
			],
		];
		for (const [input, message] of cases) {
			expect(() => parseCodemodeSource(input), input).toThrow(CodemodeSourceError);
			expect(() => parseCodemodeSource(input), input).toThrow(message);
		}
	});
});
