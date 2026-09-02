export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.PI_EXPERIMENTAL === "1";
}

export function getExperimentalToolSampling(): { type: "json_schema"; strict: "prefer" } {
	return { type: "json_schema", strict: "prefer" };
}
