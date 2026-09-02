import assert from "node:assert/strict";
import { VERSION } from "../../packages/coding-agent/src/config.ts";

assert.equal(VERSION, "bootstrap-restored", "config evaluated before environment restoration");
assert.equal(process.env.PI_TEST_OAUTH_REGISTERED, "1");
assert.equal(process.env.PI_TEST_BEDROCK_REGISTERED, "1");
console.log(VERSION);
if (process.argv.includes("--fail")) throw new Error("startup failure propagated");
