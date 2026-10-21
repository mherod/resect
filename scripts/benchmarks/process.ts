import { createHash } from "node:crypto";
import { z } from "zod";

export const MEMORY_LIMIT_BYTES = 2_000_000_000;
export const TIMEOUT_MS = 120_000;

export function outputHash(text: string, fixture: string): string {
	return createHash("sha256")
		.update(text.replaceAll(fixture, "<VSCODE>"))
		.digest("hex");
}

export async function measureProcess(
	command: string[],
	cwd: string,
	output: string,
	timeoutMs = TIMEOUT_MS
) {
	const start = performance.now();
	const child = Bun.spawn(command, {
		cwd,
		stdout: Bun.file(`${output}.stdout`),
		stderr: Bun.file(`${output}.stderr`),
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	try {
		const exitCode = await child.exited;
		return {
			command,
			exitCode,
			timedOut,
			elapsedMs: performance.now() - start,
			peakRssBytes: child.resourceUsage()?.maxRSS ?? null,
		};
	} finally {
		clearTimeout(timer);
	}
}

const responseSchema = z.object({
	id: z.number().optional(),
	result: z.unknown().optional(),
	error: z.unknown().optional(),
});

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/** A real stdio session, with request IDs supporting overlapping tool calls. */
export function startMcp(
	command: string[],
	cwd: string,
	stderr: string,
	timeoutMs = TIMEOUT_MS
) {
	const child = Bun.spawn(command, {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: Bun.file(stderr),
	});
	const pending = new Map<number, PendingRequest>();
	let nextId = 1;
	let closed = false;
	let failure: Error | undefined;
	const fail = (error: Error) => {
		failure = error;
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		pending.clear();
	};
	const reader = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of child.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.trim()) {
						const response = responseSchema.parse(JSON.parse(line));
						const request = response.id ? pending.get(response.id) : undefined;
						if (request && response.id) {
							pending.delete(response.id);
							clearTimeout(request.timer);
							if (response.error !== undefined) {
								request.reject(new Error(JSON.stringify(response.error)));
							} else {
								request.resolve(response.result);
							}
						}
					}
					newline = buffer.indexOf("\n");
				}
			}
			if (pending.size) {
				fail(new Error("MCP exited before replying"));
			}
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
			child.kill();
		} finally {
			closed = true;
		}
	})();
	const send = (message: unknown) => {
		child.stdin.write(`${JSON.stringify(message)}\n`);
	};
	return {
		request(method: string, params: unknown): Promise<unknown> {
			if (closed || failure) {
				return Promise.reject(failure ?? new Error("MCP session is closed"));
			}
			const id = nextId++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					fail(new Error(`MCP ${method} timed out after ${timeoutMs} ms`));
					child.kill("SIGKILL");
				}, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				try {
					send({ jsonrpc: "2.0", id, method, params });
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
				}
			});
		},
		notify(method: string) {
			send({ jsonrpc: "2.0", method });
		},
		async close() {
			child.stdin.end();
			const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
			try {
				const exitCode = await child.exited;
				await reader;
				return {
					exitCode,
					peakRssBytes: child.resourceUsage()?.maxRSS ?? null,
				};
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
