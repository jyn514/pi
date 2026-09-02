// Bun loads .wasm imports as files: embedded in compiled executables, evaluating to a readable path.
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
import { setEmbeddedQuickJSWasmPath } from "../config.ts";

setEmbeddedQuickJSWasmPath(quickjsWasmPath);
