import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	handleCliStdoutError,
	installCliStdoutErrorHandler,
	isBrokenPipeError,
} from "./cli-stream-errors.ts";

const MODULE_PATH = path.resolve(import.meta.dir, "cli-stream-errors.ts");

async function emitStreamError(
	stream: "stderr" | "stdout",
	code: string
): Promise<{ exitCode: number; stderr: string }> {
	const script = `
		const { installCliStdoutErrorHandler } = await import(${JSON.stringify(MODULE_PATH)});
		installCliStdoutErrorHandler();
		const error = Object.assign(new Error("forced ${stream} failure"), { code: ${JSON.stringify(code)} });
		process.${stream}.emit("error", error);
	`;
	const child = Bun.spawn(["bun", "-e", script], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([
		new Response(child.stderr).text(),
		child.exited,
	]);

	return { exitCode, stderr };
}

describe("CLI stream errors", () => {
	test("recognizes only EPIPE errors as closed pipes", () => {
		expect(
			isBrokenPipeError(Object.assign(new Error("closed"), { code: "EPIPE" }))
		).toBe(true);
		expect(
			isBrokenPipeError(Object.assign(new Error("failed"), { code: "EIO" }))
		).toBe(false);
		expect(isBrokenPipeError(new Error("missing code"))).toBe(false);
	});

	test("rethrows non-EPIPE stdout errors", () => {
		const error = Object.assign(new Error("forced stdout failure"), {
			code: "EIO",
		});

		expect(() => {
			handleCliStdoutError(error);
		}).toThrow(error);
	});

	test("keeps non-EPIPE stdout failures visible and non-zero", async () => {
		const result = await emitStreamError("stdout", "EIO");

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("forced stdout failure");
		expect(result.stderr).toContain("EIO");
	});

	test("does not swallow stderr EPIPE failures", async () => {
		const result = await emitStreamError("stderr", "EPIPE");

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("forced stderr failure");
		expect(result.stderr).toContain("EPIPE");
	});

	test("installs only the exported stdout handler", () => {
		const stdoutListenersBefore = process.stdout.listenerCount("error");
		const stderrListenersBefore = process.stderr.listenerCount("error");

		installCliStdoutErrorHandler();

		expect(process.stdout.listenerCount("error")).toBe(
			stdoutListenersBefore + 1
		);
		expect(process.stderr.listenerCount("error")).toBe(stderrListenersBefore);
		process.stdout.off("error", handleCliStdoutError);
	});
});
