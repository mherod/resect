import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { measureProcess, outputHash, startMcp } from "./process.ts";
import { toolText, validateFixture } from "./vscode.ts";

const sessions: ReturnType<typeof startMcp>[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) {
		await session.close();
	}
});

test("process receipts distinguish successful, failed, and timed-out children", async () => {
	const output = await mkdtemp(path.join(tmpdir(), "resect-benchmark-test-"));
	const success = await measureProcess(
		[process.execPath, "-e", 'console.log("ok")'],
		output,
		path.join(output, "success")
	);
	expect(success.exitCode).toBe(0);
	expect(success.peakRssBytes).toBeGreaterThan(0);
	expect(await Bun.file(path.join(output, "success.stdout")).text()).toBe(
		"ok\n"
	);
	const failed = await measureProcess(
		[process.execPath, "-e", "process.exit(7)"],
		output,
		path.join(output, "failure")
	);
	expect(failed.exitCode).toBe(7);
	expect(failed.timedOut).toBe(false);
	const timeout = await measureProcess(
		[process.execPath, "-e", "setInterval(() => {}, 1000)"],
		output,
		path.join(output, "timeout"),
		100
	);
	expect(timeout.timedOut).toBe(true);
	expect(timeout.exitCode).not.toBe(0);
});

test("MCP correlates overlapping responses in reverse completion order", async () => {
	const output = await mkdtemp(
		path.join(tmpdir(), "resect-mcp-benchmark-test-")
	);
	const source = `for await (const line of console) { const message = JSON.parse(line); setTimeout(() => console.log(JSON.stringify({jsonrpc: "2.0", id: message.id, result: message.params})), message.params.delay); }`;
	const session = startMcp(
		[process.execPath, "-e", source],
		output,
		path.join(output, "stderr")
	);
	sessions.push(session);
	const results = await Promise.all([
		session.request("first", { delay: 80, value: 1 }),
		session.request("second", { delay: 0, value: 2 }),
	]);
	expect(results).toEqual([
		{ delay: 80, value: 1 },
		{ delay: 0, value: 2 },
	]);
});

test("MCP rejects a silent or malformed server and closes its process", async () => {
	const output = await mkdtemp(path.join(tmpdir(), "resect-mcp-failure-test-"));
	const silent = startMcp(
		[process.execPath, "-e", "setInterval(() => {}, 1000)"],
		output,
		path.join(output, "silent.stderr"),
		100
	);
	sessions.push(silent);
	await expect(silent.request("initialize", {})).rejects.toThrow("timed out");
	const malformed = startMcp(
		[process.execPath, "-e", 'console.log("not JSON")'],
		output,
		path.join(output, "bad.stderr")
	);
	sessions.push(malformed);
	await expect(malformed.request("initialize", {})).rejects.toThrow();
});

test("report checks preserve ordering while normalizing fixture location", () => {
	expect(outputHash('["/one/a","/one/b"]', "/one")).toBe(
		outputHash('["/two/a","/two/b"]', "/two")
	);
	expect(outputHash('["a","b"]', "/one")).not.toBe(
		outputHash('["b","a"]', "/one")
	);
	expect(() => toolText({ isError: true, content: [] })).toThrow();
	expect(() =>
		toolText({ content: [{ type: "text", text: "invalid" }] })
	).toThrow();
});

test("fixture guard refuses an unrelated repository", async () => {
	await expect(
		validateFixture(path.resolve(import.meta.dir, "../.."))
	).rejects.toThrow("Expected VS Code revision");
});
