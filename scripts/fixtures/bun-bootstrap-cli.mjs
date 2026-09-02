import assert from "node:assert/strict";
import { getQuickJSWasmPath, VERSION } from "../../packages/coding-agent/src/config.ts";

assert.equal(VERSION, "bootstrap-restored", "config evaluated before environment restoration");
assert.equal(process.env.PI_TEST_OAUTH_REGISTERED, "1");
assert.equal(process.env.PI_TEST_BEDROCK_REGISTERED, "1");
assert.equal(getQuickJSWasmPath(), "embedded-quickjs-test.wasm", "embedded QuickJS was not registered before CLI startup");
console.log(VERSION);
if (process.argv.includes("--fail")) throw new Error("startup failure propagated");
