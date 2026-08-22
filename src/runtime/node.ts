import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
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

const nodeFs: FileSystem = {
	async readFile(filePath: string): Promise<string> {
		return fs.readFile(filePath, "utf-8");
	},

	async writeFile(
		filePath: string,
		content: string | Uint8Array
	): Promise<void> {
		await fs.writeFile(filePath, content);
	},

	async exists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	},

	async deleteFile(filePath: string): Promise<void> {
		await fs.unlink(filePath);
	},

	async rename(from: string, to: string): Promise<void> {
		await fs.rename(from, to);
	},
};

async function* globScan(
	pattern: string,
	{ cwd, absolute = false }: { cwd: string; absolute?: boolean }
): AsyncGenerator<string> {
	const parts = pattern.split("/");
	yield* matchSegments(cwd, parts, 0, cwd, absolute);
}

async function* matchSegments(
	basePath: string,
	parts: string[],
	depth: number,
	cwd: string,
	absolute: boolean
): AsyncGenerator<string> {
	const part = parts[depth];
	if (part === undefined) {
		return;
	}
	const isLast = depth === parts.length - 1;

	if (part === "**") {
		// Match zero or more segments
		yield* matchSegments(basePath, parts, depth + 1, cwd, absolute);
		try {
			const entries = await fs.readdir(basePath, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const nextPath = path.join(basePath, entry.name);
					yield* matchSegments(nextPath, parts, depth, cwd, absolute);
				}
			}
		} catch {
			// Directory not readable; skip
		}
	} else if (part.includes("*")) {
		const regex = new RegExp(`^${part.replace(/\*/g, "[^/]*")}$`);
		try {
			const entries = await fs.readdir(basePath, { withFileTypes: true });
			for (const entry of entries) {
				if (!regex.test(entry.name)) {
					continue;
				}
				const nextPath = path.join(basePath, entry.name);
				if (isLast) {
					yield absolute ? nextPath : path.relative(cwd, nextPath);
				} else if (entry.isDirectory()) {
					yield* matchSegments(nextPath, parts, depth + 1, cwd, absolute);
				}
			}
		} catch {
			// Directory not readable; skip
		}
	} else {
		const nextPath = path.join(basePath, part);
		if (isLast) {
			try {
				await fs.access(nextPath);
				yield absolute ? nextPath : path.relative(cwd, nextPath);
			} catch {
				// File not found; skip
			}
		} else {
			yield* matchSegments(nextPath, parts, depth + 1, cwd, absolute);
		}
	}
}

const nodeGlob: GlobRunner = {
	glob(
		pattern: string,
		options: { cwd: string; absolute?: boolean }
	): AsyncIterable<string> {
		return globScan(pattern, options);
	},
};

const nodeProcess: ProcessRunner = {
	async exec(command, options) {
		const policy = resolveExecPolicy(options);
		const stdout = new OutputCollector(policy.maxOutputBytes);
		const stderr = new OutputCollector(policy.maxOutputBytes);
		const [cmd, ...args] = command;
		if (!cmd) {
			return buildResult(stdout, stderr, {
				kind: "spawn-error",
				message: "empty command",
			});
		}
		if (policy.signal?.aborted) {
			return buildResult(stdout, stderr, { kind: "aborted" });
		}

		return new Promise((resolve) => {
			let settled = false;
			// Abnormal cause recorded when we start killing the child; the final
			// `close` event settles exactly once with this cause when present.
			let abnormal: ProcessTermination | null = null;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const child = spawn(cmd, args, { cwd: policy.cwd });

			const cleanup = () => {
				clearTimeout(timeoutTimer);
				if (graceTimer) {
					clearTimeout(graceTimer);
				}
				policy.signal?.removeEventListener("abort", onAbort);
			};

			const settle = (termination: ProcessTermination) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(buildResult(stdout, stderr, termination));
			};

			// TERM → grace period → KILL. The `close` event performs the single
			// settlement with the recorded abnormal cause.
			const forceStop = (cause: ProcessTermination) => {
				if (abnormal || settled) {
					return;
				}
				abnormal = cause;
				child.kill("SIGTERM");
				graceTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
			};

			const onAbort = () => {
				forceStop({ kind: "aborted" });
			};
			policy.signal?.addEventListener("abort", onAbort, { once: true });
			const timeoutTimer = setTimeout(() => {
				forceStop({ kind: "timeout" });
			}, policy.timeoutMs);

			child.stdout.on("data", (chunk: Buffer) => {
				if (!stdout.push(chunk)) {
					forceStop({ kind: "output-limit", stream: "stdout" });
				}
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (!stderr.push(chunk)) {
					forceStop({ kind: "output-limit", stream: "stderr" });
				}
			});
			// Node may emit `close` after `error`; the settled guard keeps a
			// single settlement, and spawn failure must never look like exit 0.
			child.on("error", (error) => {
				settle({ kind: "spawn-error", message: error.message });
			});
			child.on("close", (code, signal) => {
				if (abnormal) {
					settle(abnormal);
					return;
				}
				if (code === null) {
					settle({ kind: "signal", signal: signal ?? "unknown" });
					return;
				}
				settle({ kind: "exit", exitCode: code });
			});
			if (policy.stdin !== undefined) {
				// A child that exits before reading stdin emits EPIPE; without a
				// listener that crashes the host process.
				child.stdin.on("error", () => undefined);
				child.stdin.write(policy.stdin);
				child.stdin.end();
			}
		});
	},
};

export const nodeRuntime: Runtime = {
	fs: nodeFs,
	glob: nodeGlob,
	process: nodeProcess,
};
