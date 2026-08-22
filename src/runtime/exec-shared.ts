/**
 * Shared bounded-execution policy and output collection for the production
 * ProcessRunners (#245). Both runtimes apply the same defaults, byte
 * accounting, and TERM → grace → KILL escalation so their termination
 * semantics stay in parity.
 */
import { effectiveCancellationSignal } from "./cancellation.ts";
import {
	DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
	DEFAULT_PROCESS_TIMEOUT_MS,
	type ExecOptions,
	type ProcessResult,
	type ProcessTermination,
} from "./types.ts";

/** Grace period between SIGTERM and SIGKILL when force-stopping a child. */
export const KILL_GRACE_MS = 2000;

export interface ResolvedExecPolicy {
	cwd?: string;
	stdin?: string;
	signal?: AbortSignal;
	timeoutMs: number;
	maxOutputBytes: number;
}

/** Apply the documented finite defaults and the ambient cancellation scope. */
export function resolveExecPolicy(options?: ExecOptions): ResolvedExecPolicy {
	return {
		cwd: options?.cwd,
		stdin: options?.stdin,
		signal: effectiveCancellationSignal(options?.signal),
		timeoutMs: options?.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
		maxOutputBytes: options?.maxOutputBytes ?? DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
	};
}

/**
 * Byte-bounded incremental output collector. `push` returns false exactly
 * once, when the bound is first crossed; collected text is cut at the bound.
 */
export class OutputCollector {
	truncated = false;
	private bytes = 0;
	private readonly parts: string[] = [];
	private readonly decoder = new TextDecoder();
	private readonly maxBytes: number;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	push(chunk: Uint8Array | string): boolean {
		if (this.truncated) {
			return false;
		}
		const text =
			typeof chunk === "string"
				? chunk
				: this.decoder.decode(chunk, { stream: true });
		const size =
			typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
		if (this.bytes + size > this.maxBytes) {
			const remaining = this.maxBytes - this.bytes;
			this.parts.push(text.slice(0, Math.max(0, remaining)));
			this.bytes = this.maxBytes;
			this.truncated = true;
			return false;
		}
		this.parts.push(text);
		this.bytes += size;
		return true;
	}

	text(): string {
		return this.parts.join("");
	}
}

/** Assemble the final ProcessResult from collectors and a termination. */
export function buildResult(
	stdout: OutputCollector,
	stderr: OutputCollector,
	termination: ProcessTermination
): ProcessResult {
	return {
		stdout: stdout.text(),
		stderr: stderr.text(),
		exitCode: termination.kind === "exit" ? termination.exitCode : null,
		termination,
		outputTruncated: stdout.truncated || stderr.truncated,
	};
}
