import { spawn, spawnSync } from "node:child_process";
import type { AuthOperationOptions } from "@earendil-works/pi-ai";
import type { AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage.ts";

const failure = () =>
	new Error("User keychain unavailable: install secret-tool and unlock your Secret Service keyring");

/** Stores the complete provider map as one item; the existing file backend owns exclusion. */
export class KeychainAuthStorageBackend implements AuthStorageBackend {
	private readonly profile: string;
	private readonly lock: FileAuthStorageBackend;

	constructor(profile: string, lock: FileAuthStorageBackend) {
		this.profile = profile;
		this.lock = lock;
	}

	private args(command: "lookup" | "store"): string[] {
		return [
			command,
			...(command === "store" ? ["--label=Pi provider credentials"] : []),
			"service",
			"pi-coding-agent",
			"profile",
			this.profile,
		];
	}

	private runSync(command: "lookup" | "store", secret?: string): string | undefined {
		const result = spawnSync("secret-tool", this.args(command), {
			input: secret,
			encoding: "utf8",
			timeout: 30_000,
			killSignal: "SIGKILL",
			maxBuffer: 1024 * 1024,
		});
		if (!result.error && result.status === 0) return result.stdout;
		if (!result.error && result.status === 1 && !result.stderr && command === "lookup") return undefined;
		// Never include subprocess output or JSON parse diagnostics: they may contain tokens.
		throw failure();
	}

	/** A read-only snapshot does not acquire the refresh lock or change local files. */
	readSnapshot(): string | undefined {
		return this.runSync("lookup");
	}

	private run(
		command: "lookup" | "store",
		secret?: string,
		options?: AuthOperationOptions,
	): Promise<string | undefined> {
		return new Promise((resolve, reject) => {
			const child = spawn("secret-tool", this.args(command), {
				signal: options?.signal,
				timeout: 30_000,
				killSignal: "SIGKILL",
				stdio: ["pipe", "pipe", "pipe"],
			});
			let output = "";
			let diagnostic = "";
			let processError: Error | undefined;
			child.stdout.setEncoding("utf8").on("data", (value: string) => {
				output += value;
			});
			child.stderr.setEncoding("utf8").on("data", (value: string) => {
				diagnostic += value;
			});
			child.stdin.on("error", () => {});
			child.on("error", (error) => {
				processError = error;
			});
			// Abort emits error before close. Keep the lock until the writer has actually exited.
			child.on("close", (code) => {
				if (processError && options?.signal?.aborted) reject(options.signal.reason);
				else if (!processError && code === 0) resolve(output);
				else if (!processError && code === 1 && !diagnostic && command === "lookup") resolve(undefined);
				else reject(failure());
			});
			child.stdin.end(secret);
		});
	}

	withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
		return this.lock.withLock(() => {
			const { result, next } = fn(this.runSync("lookup"));
			if (next !== undefined) {
				this.runSync("store", next);
				if (this.runSync("lookup") !== next) throw new Error("User keychain read-back verification failed");
			}
			return { result };
		});
	}

	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<{ result: T; next?: string }>,
		options?: AuthOperationOptions,
	): Promise<T> {
		return this.lock.withLockAsync(async (_current, assertHeld) => {
			const { result, next } = await fn(await this.run("lookup", undefined, options));
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				assertHeld();
				await this.run("store", next, options);
				assertHeld();
				if ((await this.run("lookup", undefined, options)) !== next)
					throw new Error("User keychain read-back verification failed");
			}
			return { result };
		}, options);
	}
}
