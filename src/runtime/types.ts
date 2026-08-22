export interface FileSystem {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	exists(path: string): Promise<boolean>;
	deleteFile(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

export interface GlobRunner {
	glob(
		pattern: string,
		options: { cwd: string; absolute?: boolean }
	): AsyncIterable<string>;
}

/**
 * How a child process ended (#245). Every abnormal ending is structurally
 * distinguishable from a normal exit so no caller can misread a hung,
 * killed, aborted, or spawn-failed process as a clean completion.
 */
export type ProcessTermination =
	| { kind: "exit"; exitCode: number }
	| { kind: "spawn-error"; message: string }
	| { kind: "signal"; signal: string }
	| { kind: "aborted" }
	| { kind: "timeout" }
	| { kind: "output-limit"; stream: "stdout" | "stderr" };

/** Captured result of a child-process invocation. */
export interface ProcessResult {
	stdout: string;
	stderr: string;
	/**
	 * Process exit code, or null for every abnormal termination. Kept for
	 * existing callers; `termination` is the authoritative discriminant.
	 */
	exitCode: number | null;
	/** Structured description of how the process ended (#245). */
	termination: ProcessTermination;
	/** True when stdout or stderr hit the byte bound and was cut short. */
	outputTruncated: boolean;
}

/**
 * Default finite execution policy (#245). Applied by both production
 * runtimes to EVERY exec call unless the caller overrides them, so no
 * production child process is unbounded: Git commands, typechecks, builds,
 * and package-manager operations all inherit these caps.
 *
 * 10 minutes covers the slowest legitimate cold typecheck/build this tool
 * launches; 64 MiB of captured output is far beyond any parseable tsc or
 * git output while still bounding memory.
 */
export const DEFAULT_PROCESS_TIMEOUT_MS = 600_000;
export const DEFAULT_PROCESS_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface ExecOptions {
	cwd?: string;
	stdin?: string;
	/** Cancels the child (TERM, then KILL after a grace period). */
	signal?: AbortSignal;
	/** Hard deadline; elapsed → `termination.kind === "timeout"`. */
	timeoutMs?: number;
	/** Per-stream captured-output bound in bytes. */
	maxOutputBytes?: number;
}

/**
 * Abstraction over real process execution (tsc, git, …). Production runtimes
 * spawn a real child process; tests inject a fake that returns scripted
 * results, so the unit suite never spawns a subprocess.
 */
export interface ProcessRunner {
	exec(command: string[], options?: ExecOptions): Promise<ProcessResult>;
}

export interface Runtime {
	fs: FileSystem;
	glob: GlobRunner;
	process: ProcessRunner;
}
