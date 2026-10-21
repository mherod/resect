import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("bundled runtime imports under Node before selecting its adapter", async () => {
	const outdir = await mkdtemp(path.join(tmpdir(), "resect-node-import-"));
	try {
		const build = await Bun.build({
			entrypoints: [path.join(import.meta.dir, "index.ts")],
			outdir,
			target: "bun",
			format: "esm",
		});
		expect(build.success).toBe(true);
		const entry = pathToFileURL(path.join(outdir, "index.js")).href;
		const manifest = path.resolve(import.meta.dir, "../../package.json");
		const script = `
			const { getRuntime, setRuntime, nodeRuntime } = await import(${JSON.stringify(entry)});
			setRuntime(nodeRuntime);
			const content = await getRuntime().fs.readFile(${JSON.stringify(manifest)});
			process.stdout.write(JSON.parse(content).name);
		`;
		const proc = Bun.spawn(["node", "--input-type=module", "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout).toBe("@mherod/resect");
	} finally {
		await rm(outdir, { recursive: true, force: true });
	}
});
