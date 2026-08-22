import { Glob } from "bun";
import {
	buildResult,
	KILL_GRACE_MS,
	OutputCollector,
	resolveExecPolicy,
} from "./exec-shared.ts";
import type {
	FileSystem,
	GlobRunner,
	ProcessRunner,
	ProcessTermination,
	Runtime,
} from "./types.ts";

const bunFs: FileSystem = {
	async readFile(path: string): Promise<string> {
		return Bun.file(path).text();
	},

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await Bun.write(path, content);
	},

	async exists(path: string): Promise<boolean> {
		const f = Bun.file(path);
		if (await f.exists()) {
			return true;
		}
		// Bun.file().exists() returns false for directories; fall back to stat
		try {
			const { stat } = await import("node:fs/promises");
			await stat(path);
			return true;
		} catch {
			return false;
		}
	},

	async deleteFile(path: string): Promise<void> {
		await Bun.file(path).delete();
	},

	async rename(from: string, to: string): Promise<void> {
		const { rename } = await import("node:fs/promises");
		await rename(from, to);
	},
};

const bunGlob: GlobRunner = {
	glob(
		pattern: string,
		{ cwd, absolute }: { cwd: string; absolute?: boolean }
	): AsyncIterable<string> {
		const g = new Glob(pattern);
		return g.scan({ cwd, absolute });
	},
};

const bunProcess: ProcessRunner = {
	async exec(command, options) {
		const policy = resolveExecPolicy(options);
		const stdout = new OutputCollector(policy.maxOutputBytes);
		const stderr = new OutputCollector(policy.maxOutputBytes);
		if (policy.signal?.aborted) {
			return buildResult(stdout, stderr, { kind: "aborted" });
		}

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(command, {
				cwd: policy.cwd,
				stdin: policy.stdin === undefined ? "ignore" : "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			return buildResult(stdout, stderr, {
				kind: "spawn-error",
				message: error instanceof Error ? error.message : String(error),
			});
		}

		// Abnormal cause recorded when we start killing the child; the awaited
		// exit below performs the single settlement with this cause. Held in a
		// holder object because control-flow analysis cannot see the closure
		// assignments made by the abort/timeout/drain callbacks.
		const state: { abnormal: ProcessTermination | null } = { abnormal: null };
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		// TERM → grace period → KILL.
		const forceStop = (cause: ProcessTermination) => {
			if (state.abnormal) {
				return;
			}
			state.abnormal = cause;
			proc.kill("SIGTERM");
			graceTimer = setTimeout(() => {
				proc.kill("SIGKILL");
			}, KILL_GRACE_MS);
		};
		const onAbort = () => {
			forceStop({ kind: "aborted" });
		};
		policy.signal?.addEventListener("abort", onAbort, { once: true });
		const timeoutTimer = setTimeout(() => {
			forceStop({ kind: "timeout" });
		}, policy.timeoutMs);

		try {
			if (policy.stdin !== undefined && typeof proc.stdin === "object") {
				await proc.stdin.write(policy.stdin);
				await proc.stdin.end();
			}
			// Bounded incremental reads: stop capturing (and kill) the moment a
			// stream crosses the byte bound instead of buffering to exit.
			const drain = async (
				stream: ReadableStream<Uint8Array> | undefined,
				collector: OutputCollector,
				name: "stdout" | "stderr"
			) => {
				if (!stream) {
					return;
				}
				for await (const chunk of stream) {
					if (!collector.push(chunk)) {
						forceStop({ kind: "output-limit", stream: name });
						break;
					}
				}
			};
			await Promise.all([
				drain(proc.stdout as ReadableStream<Uint8Array>, stdout, "stdout"),
				drain(proc.stderr as ReadableStream<Uint8Array>, stderr, "stderr"),
			]);
			// Await final child closure exactly once.
			const exitCode = await proc.exited;
			if (state.abnormal) {
				return buildResult(stdout, stderr, state.abnormal);
			}
			if (proc.signalCode) {
				return buildResult(stdout, stderr, {
					kind: "signal",
					signal: proc.signalCode,
				});
			}
			return buildResult(stdout, stderr, { kind: "exit", exitCode });
		} finally {
			clearTimeout(timeoutTimer);
			if (graceTimer) {
				clearTimeout(graceTimer);
			}
			policy.signal?.removeEventListener("abort", onAbort);
		}
	},
};

export const bunRuntime: Runtime = {
	fs: bunFs,
	glob: bunGlob,
	process: bunProcess,
};
