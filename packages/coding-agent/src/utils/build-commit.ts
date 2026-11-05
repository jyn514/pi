import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Read the checkout's short commit, without searching a containing repository. */
export function getSourceCommit(packageDir: string): string | undefined {
	const root = resolve(packageDir, "../..");
	if (!existsSync(join(root, ".git"))) return undefined;
	const result = spawnSync("git", ["-C", root, "rev-parse", "--short=8", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const commit = result.stdout?.trim();
	// Git output is an external process boundary, not arbitrary version metadata.
	return result.status === 0 && commit && /^[0-9a-f]{8,40}$/.test(commit) ? commit : undefined;
}

/** Read the commit recorded by build:unbundled, without requiring Git at runtime. */
export function readBuildCommit(packageDir: string): string | undefined {
	try {
		const commit = readFileSync(join(packageDir, "dist", "commit"), "utf8").trim();
		// The stamp is installed data and may be missing in third-party builds.
		return /^[0-9a-f]{8,40}$/.test(commit) ? commit : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
