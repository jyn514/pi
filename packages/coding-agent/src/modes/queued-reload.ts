import type { AgentSession } from "../core/agent-session.ts";
import type { ExtensionCommandContext, ReloadCompletionHandler } from "../core/extensions/types.ts";

/** Share one mode-owned reload and notify every caller after the mode finishes refreshing. */
export function createReloadRequester(
	session: AgentSession,
	reload: (performReload: AgentSession["reload"]) => Promise<void>,
): ExtensionCommandContext["requestReload"] {
	let pending: ReloadCompletionHandler[] | undefined;
	return async (onComplete) => {
		if (pending) {
			pending.push(onComplete);
			return;
		}
		const callbacks = [onComplete];
		pending = callbacks;
		await session.requestReload(async (performReload) => {
			let error: Error | undefined;
			try {
				await reload(performReload);
			} catch (cause) {
				error = cause instanceof Error ? cause : new Error(String(cause));
			}
			try {
				for (const callback of callbacks) {
					try {
						await callback(error);
					} catch (cause) {
						// Reload detached the old runner's error listener; report through the current runner.
						session.extensionRunner.emitError({
							extensionPath: "<runtime>",
							event: "request_reload",
							error: cause instanceof Error ? cause.message : String(cause),
						});
					}
				}
			} finally {
				pending = undefined;
			}
		});
	};
}
