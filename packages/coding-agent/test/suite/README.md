# Coding agent suite tests

Use `test/suite/` for the new harness-based test suite around `AgentSession` and `AgentSessionRuntime`.

Rules:
- Use `test/suite/harness.ts`
- Use the faux provider from `packages/ai/src/providers/faux.ts`
- Do not use real provider APIs, real API keys, network calls, or paid tokens
- Keep these tests CI-safe and deterministic
- Do not use or extend the legacy `test/test-harness.ts` path unless a missing capability forces it

## Faux-provider assertions and reloads

Capture request data inside faux response callbacks, then assert it after `await session.prompt(...)` completes.
The faux provider catches callback exceptions, including assertion failures, and converts them into assistant error responses.
An assertion inside a callback therefore does not reliably fail the test.

`session.reload()` resets API-provider registrations, including the harness's faux provider.
Before reloading, capture its registration with `getApiProvider(harness.faux.api)` from `@earendil-works/pi-ai/compat`.
Restore that same registration with `registerApiProvider(provider)` during extension loading or in the mocked resource loader's `reload()`.
Reusing the registration preserves queued responses and request counters.
See [the reload tests](agent-session-reload.test.ts) for request capture and mocked-loader restoration.
