import assert from "node:assert/strict";

assert.ok(process.env.PI_PACKAGE_DIR, "QuickJS evaluated before environment restoration");
// Deliberately differs from Node resolution, so a missing registration cannot pass.
export default "embedded-quickjs-test.wasm";
