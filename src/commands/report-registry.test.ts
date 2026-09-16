import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { CliValues } from "./option-flags.ts";

// Isolate module replacements in a child process so command suites keep their
// real implementations even when Bun runs files in parallel.
async function runRegistry(
	name: "similar" | "barrel",
	values: CliValues,
	thrown?: "error" | "string"
) {
	const replacement = thrown
		? `throw ${thrown === "error" ? 'new Error("barrel failed")' : '"barrel failed"'};`
		: "process.stdout.write(JSON.stringify(options, (_key, value) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value));";
	const script = `
import { mock } from "bun:test";
mock.module(${JSON.stringify(resolve(import.meta.dir, "similar.ts"))}, () => ({ similarCommand(options) { ${replacement} } }));
mock.module(${JSON.stringify(resolve(import.meta.dir, "barrel.ts"))}, () => ({ barrelCommand(options) { ${replacement} } }));
const { COMMANDS } = await import(${JSON.stringify(resolve(import.meta.dir, "registry.ts"))});
await COMMANDS.find(command => command.name === ${JSON.stringify(name)}).run(["fixture"], ${JSON.stringify(values)});
`;
	const child = Bun.spawn([process.execPath, "-e", script], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

for (const [values, expected] of [
	[{}, { threshold: 0.8, maxGroups: 10 }],
	[
		{ threshold: "", "name-threshold": "", "max-groups": "" },
		{ threshold: 0, nameThreshold: 0, maxGroups: 0 },
	],
	[{ "max-groups": "1.5" }, { maxGroups: 1.5 }],
	[
		{ "max-groups": "Infinity", "min-lines": "Infinity" },
		{ maxGroups: "Infinity", minLines: "Infinity" },
	],
	[{ "min-lines": "NaN" }, { minLines: "NaN" }],
	[
		{ kinds: " function,invalid, type,interface " },
		{ kinds: ["function", "type", "interface"] },
	],
	[{ kinds: "invalid" }, { kinds: [] }],
	[{ bucket: "", kinds: "", "min-lines": "" }, { bucket: "" }],
	[
		{ threshold: "1", bucket: "high", format: "compact" },
		{ threshold: 1, bucket: "high", format: "compact" },
	],
] satisfies [CliValues, Record<string, unknown>][]) {
	test(`similar preserves accepted input ${JSON.stringify(values)}`, async () => {
		const result = await runRegistry("similar", values);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject(expected);
	});
}

for (const [values, message] of [
	[
		{ threshold: "invalid", "max-groups": "-1", bucket: "bad" },
		"Error: --threshold must be a number between 0.0 and 1.0",
	],
	[
		{ threshold: "Infinity" },
		"Error: --threshold must be a number between 0.0 and 1.0",
	],
	[
		{ "max-groups": "-1", "name-threshold": "bad" },
		"Error: --max-groups must be a non-negative integer",
	],
	[
		{ "name-threshold": "2", bucket: "bad" },
		"Error: --name-threshold must be a number between 0.0 and 1.0",
	],
	[
		{ bucket: "bad", format: "bad" },
		"Error: --bucket must be 'exact', 'high', or 'medium'",
	],
	[{ format: "" }, "Error: --format must be 'compact'"],
] satisfies [CliValues, string][]) {
	test(`similar retains validation order for ${JSON.stringify(values)}`, async () => {
		const result = await runRegistry("similar", values);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.trim()).toBe(message);
		expect(result.stdout).toBe("");
	});
}

for (const thrown of ["error", "string"] as const) {
	test(`barrel renders a thrown ${thrown}`, async () => {
		const result = await runRegistry("barrel", {}, thrown);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.trim()).toBe("barrel failed");
		expect(result.stdout).toBe("");
	});
}
