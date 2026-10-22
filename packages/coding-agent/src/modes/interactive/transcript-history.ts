import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { type SessionEntry, sessionEntryToContextMessages } from "../../core/session-manager.ts";

export type TranscriptUnit = {
	id: string;
	entry: SessionEntry;
	historical: boolean;
	label: string;
	failed: boolean;
} & (
	| { kind: "message"; message: AgentMessage }
	| { kind: "tool"; message: AssistantMessage; call: ToolCall; part: number; result?: ToolResultMessage }
	| { kind: "custom"; entry: Extract<SessionEntry, { type: "custom" }> }
	| { kind: "usage"; entry: Extract<SessionEntry, { type: "usage" }> }
);

/** Only the selected branch defines display membership. Retained model context is not a second display source. */
export function collectTranscriptUnits(branch: readonly SessionEntry[]): TranscriptUnit[] {
	let cutoff = -1;
	for (let i = 0; i < branch.length; i++) if (branch[i].type === "compaction") cutoff = i;
	const units: TranscriptUnit[] = [];
	const pending = new Map<string, Extract<TranscriptUnit, { kind: "tool" }>>();
	for (const [index, entry] of branch.entries()) {
		const base = { entry, historical: index < cutoff, failed: false };
		if (entry.type === "custom") {
			units.push({ ...base, entry, kind: "custom", id: entry.id, label: entry.customType });
			continue;
		}
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			units.push({ ...base, entry, kind: "usage", id: entry.id, label: "Cache warming" });
			continue;
		}
		for (const [part, message] of sessionEntryToContextMessages(entry).entries()) {
			const id = `${entry.id}:message:${part}`;
			if (message.role === "system" || (message.role === "custom" && !message.display)) continue;
			if (
				message.role === "user" &&
				!(typeof message.content === "string"
					? message.content
					: message.content.some((c) => c.type === "text" && c.text))
			)
				continue;
			if (message.role === "toolResult") {
				const tool = pending.get(message.toolCallId);
				if (tool) {
					tool.result = message;
					tool.failed ||= message.isError;
					pending.delete(message.toolCallId);
				}
				continue;
			}
			if (message.role === "assistant") {
				const failed = message.stopReason === "aborted" || message.stopReason === "error";
				if (
					failed ||
					message.stopReason === "length" ||
					message.content.some(
						(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
					) ||
					message.diagnostics?.length
				) {
					units.push({ ...base, kind: "message", id, message, label: "Assistant", failed });
				}
				for (const [part, call] of message.content.entries()) {
					if (call.type !== "toolCall") continue;
					const tool: Extract<TranscriptUnit, { kind: "tool" }> = {
						...base,
						kind: "tool",
						id: `${entry.id}:tool:${part}`,
						message,
						call,
						part,
						label: call.name,
						failed,
					};
					units.push(tool);
					pending.set(call.id, tool);
				}
			} else {
				const label =
					message.role === "user"
						? "You"
						: message.role === "custom"
							? message.customType
							: message.role === "bashExecution"
								? `Bash: ${message.command.slice(0, 80)}`
								: message.role === "compactionSummary"
									? "Compaction summary"
									: "Branch summary";
				units.push({
					...base,
					kind: "message",
					id,
					message,
					label,
					failed:
						message.role === "bashExecution" &&
						(message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0)),
				});
			}
		}
	}
	return units;
}

function argumentFragments(value: unknown, fragments: string[]): void {
	if (typeof value === "string") fragments.push(value);
	else if (typeof value === "number" || typeof value === "boolean") fragments.push(String(value));
	else if (Array.isArray(value)) for (const item of value) argumentFragments(item, fragments);
	else if (value && typeof value === "object")
		for (const item of Object.values(value)) argumentFragments(item, fragments);
}

/** Original textual fragments only: never renderer text, opaque details, images, or full-output files. */
export function transcriptUnitFragments(unit: TranscriptUnit): string[] {
	if (unit.kind === "custom" || unit.kind === "usage") return [];
	if (unit.kind === "tool") {
		const fragments = [unit.call.name];
		argumentFragments(unit.call.arguments, fragments);
		for (const block of unit.result?.content ?? []) if (block.type === "text") fragments.push(block.text);
		return fragments;
	}
	const message = unit.message;
	switch (message.role) {
		case "user":
		case "custom":
			return typeof message.content === "string"
				? [message.content]
				: message.content.filter((c) => c.type === "text").map((c) => c.text);
		case "assistant":
			return message.content.flatMap((c) =>
				c.type === "text" ? [c.text] : c.type === "thinking" ? [c.thinking] : [],
			);
		case "bashExecution":
			return [message.command, message.output];
		case "compactionSummary":
		case "branchSummary":
			return [message.summary];
		default:
			return [];
	}
}

/** Bounded unformatted preview; do not inspect tool arguments or invoke renderers here. */
export function transcriptUnitPreview(unit: TranscriptUnit): string {
	if (unit.kind !== "message") return unit.label;
	const message = unit.message;
	const text =
		message.role === "compactionSummary" || message.role === "branchSummary"
			? message.summary
			: "content" in message && typeof message.content === "string"
				? message.content
				: "content" in message && Array.isArray(message.content)
					? (message.content.find((c) => c.type === "text")?.text ?? "")
					: "";
	return `${unit.label}${text ? `: ${text.slice(0, 120)}` : ""}`;
}
