import type { Api, Model, ProviderEvent, ProviderRequestOptions } from "../types.ts";

/** Emit an opt-in, transient event from a provider's native response stream. */
export function emitProviderEvent(
	options: Pick<ProviderRequestOptions, "onProviderEvent"> | undefined,
	model: Model<Api>,
	payload: unknown,
): void {
	if (!options?.onProviderEvent) return;
	const type =
		payload && typeof payload === "object" && "type" in payload && typeof payload.type === "string"
			? payload.type
			: "chunk";
	const event: ProviderEvent = {
		provider: model.provider,
		api: model.api,
		model: model.id,
		type,
		payload,
	};
	options.onProviderEvent(event);
}
