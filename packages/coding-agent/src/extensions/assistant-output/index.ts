/**
 * Assistant output tools. The CLI loads them as a built-in extension; SDK users add
 * `createAssistantOutputExtension()` to their extension factories.
 *
 * Registered inactive, but callable from codemode without activation.
 */

import { Type } from "typebox";
import type { ExtensionFactory } from "../../core/extensions/types.ts";

export function createAssistantOutputExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "send_commentary",
			label: "Send commentary",
			description:
				"Send an assistant commentary message after the enclosing outer tool call completes. Does not end the turn or cancel scripts or sibling calls.",
			parameters: Type.Object({ message: Type.String({ description: "Assistant commentary to send." }) }),
			exposure: "codemode",
			defaultActive: false,
			async execute(_toolCallId, { message }, _signal, _onUpdate, ctx) {
				ctx.sendCommentary(message);
				return { content: [{ type: "text", text: "Commentary staged." }], details: undefined };
			},
		});
		pi.registerTool({
			name: "finish_turn",
			label: "Finish turn",
			description:
				"Send a final assistant message and skip the automatic model follow-up after the enclosing outer tool call succeeds. An empty message stops silently. Does not cancel scripts or sibling calls; failure or abort of the outer call does not finish the turn.",
			parameters: Type.Object({
				message: Type.String({ description: "Final assistant message, or an empty string to stop silently." }),
			}),
			exposure: "codemode",
			defaultActive: false,
			async execute(_toolCallId, { message }, _signal, _onUpdate, ctx) {
				ctx.finishTurn(message);
				return { content: [{ type: "text", text: "Turn completion staged." }], details: undefined };
			},
		});
	};
}

export default createAssistantOutputExtension();
