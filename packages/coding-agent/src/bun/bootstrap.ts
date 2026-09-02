// This module must not import config or providers: they read the environment
// during evaluation, before an entrypoint-body call could restore it.
import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();
process.emitWarning = (() => {}) as typeof process.emitWarning;
