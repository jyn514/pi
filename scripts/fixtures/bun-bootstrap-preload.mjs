import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";

const cli = new URL("../../packages/coding-agent/src/cli.ts", import.meta.url).href;
const readFileSync = fs.readFileSync;
const restoredEnvironment = `PI_PACKAGE_DIR=${process.env.PI_BOOTSTRAP_PACKAGE}\0`;
fs.readFileSync = function (path, ...args) {
	return path === "/proc/self/environ" ? restoredEnvironment : readFileSync(path, ...args);
};
syncBuiltinESMExports();
process.versions.bun = "test";
process.env = {};
registerHooks({
	resolve(specifier, context, nextResolve) {
		// Exercise the real registration modules without requiring built pi-ai
		// packages or importing provider SDKs in this ordering test.
		if (["bun-oauth", "bedrock-provider", "compat"].some((name) => specifier === `@earendil-works/pi-ai/${name}`)) {
			return { url: new URL("./bun-bootstrap-providers.mjs", import.meta.url).href, shortCircuit: true };
		}
		const result = nextResolve(specifier, context);
		return result.url === cli
			? { url: new URL("./bun-bootstrap-cli.mjs", import.meta.url).href, shortCircuit: true }
			: result;
	},
});
