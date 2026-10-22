import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { renameTool } from "../mcp-tools/mutating.ts";
import { withErrorHandling } from "../mcp-tools/shared.ts";
import { bunRuntime, setRuntime } from "../runtime/index.ts";
import {
	cleanup,
	initializeGitRepository,
	makeFixture,
	runGitCommand,
} from "./__test-helpers.ts";
import { moveModuleWithRecovery } from "./move-apply.ts";
import { moveBatchWithDependencies } from "./move-batch.ts";

const dirs: string[] = [];
const original = "export function App() { return <section>Hello</section>; }\n";
const tsconfig = JSON.stringify({
	compilerOptions: {
		jsx: "preserve",
		module: "ESNext",
		moduleResolution: "Bundler",
		types: [],
	},
});

afterAll(async () => {
	setRuntime(bunRuntime);
	for (const dir of dirs) {
		await cleanup(dir);
	}
});

test.each([
	"cli",
	"mcp",
] as const)("%s reports extraction write failure only after restoring its checkpoint", async (surface) => {
	const dir = await makeFixture(
		`exception-${surface}`,
		{ "tsconfig.json": tsconfig, "App.tsx": original, "keep.txt": "unrelated" },
		{ outsideRepo: true }
	);
	dirs.push(dir);
	const source = path.join(dir, "App.tsx");
	const target = path.join(dir, "Part.tsx");
	const runtimeModule = path.resolve(import.meta.dir, "../runtime/index.ts");
	const commandModule = path.resolve(import.meta.dir, "extract-component.ts");
	const mcpModule = path.resolve(import.meta.dir, "../mcp-tools/read-only.ts");
	const sharedModule = path.resolve(import.meta.dir, "../mcp-tools/shared.ts");
	const script = `
import { bunRuntime, setRuntime } from ${JSON.stringify(runtimeModule)};
import { extractComponentCommand } from ${JSON.stringify(commandModule)};
import { extractComponentTool } from ${JSON.stringify(mcpModule)};
import { withErrorHandling } from ${JSON.stringify(sharedModule)};
const file = ${JSON.stringify(source)};
const newFile = ${JSON.stringify(target)};
setRuntime({ ...bunRuntime, fs: { ...bunRuntime.fs, writeFile: async (name, text) => {
  await bunRuntime.fs.writeFile(name, text);
  if (name === newFile) throw new Error("EACCES: injected destination failure");
}}, process: { exec: async (args, options) => args[0] === "git" ? bunRuntime.process.exec(args, options) : ({ exitCode: 0, stdout: "", stderr: "", outputTruncated: false, termination: { kind: "exit", exitCode: 0 } }) }});
if (${JSON.stringify(surface)} === "cli") {
  await extractComponentCommand({ file, newFile, selector: "section" });
} else {
  const result = await withErrorHandling(() => extractComponentTool(file, "section", newFile, { dryRun: false }));
  process.stdout.write(JSON.stringify(result));
}
`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode).toBe(surface === "cli" ? 1 : 0);
	expect(`${stdout}${stderr}`).toContain(
		"EACCES: injected destination failure"
	);
	expect(`${stdout}${stderr}`).toContain("Changes were rolled back");
	expect(`${stdout}${stderr}`).not.toContain("✅ Wrote");
	if (surface === "mcp") {
		expect(JSON.parse(stdout).isError).toBe(true);
	}
	expect(await Bun.file(source).text()).toBe(original);
	expect(await Bun.file(target).exists()).toBe(false);
	expect(await Bun.file(path.join(dir, "keep.txt")).text()).toBe("unrelated");
});

test("MCP rename retains its write scope when the source write throws before returning", async () => {
	const contents = "export const before = 1;\n";
	const dir = await makeFixture(
		"rename-write-exception",
		{
			"tsconfig.json": tsconfig,
			"value.ts": contents,
			"consumer.ts":
				'import { before } from "./value"; export const use = before;\n',
		},
		{ outsideRepo: true }
	);
	dirs.push(dir);
	await initializeGitRepository(dir);
	const source = path.join(dir, "value.ts");
	setRuntime({
		...bunRuntime,
		fs: {
			...bunRuntime.fs,
			writeFile: async (file, text) => {
				await bunRuntime.fs.writeFile(file, text);
				if (file === source) {
					throw new Error("rename source write failed");
				}
			},
		},
	});
	try {
		const result = await withErrorHandling(async () =>
			renameTool({
				file: source,
				oldName: "before",
				newName: "after",
				dryRun: false,
				force: false,
				verify: false,
				verbose: false,
			})
		);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("rename source write failed");
		expect(JSON.stringify(result)).toContain("Changes were rolled back");
		expect(await Bun.file(source).text()).toBe(contents);
		expect(await runGitCommand(dir, ["status", "--porcelain=v1"])).toBe("");
	} finally {
		setRuntime(bunRuntime);
	}
});

test("a batch exception after a completed move restores retained source and importer state", async () => {
	const sourceText = "export const value = 1;\n";
	const importerText =
		'import { value } from "./value"; export const use = value;\n';
	const dir = await makeFixture(
		"batch-write-exception",
		{
			"tsconfig.json": tsconfig,
			"value.ts": sourceText,
			"consumer.ts": importerText,
		},
		{ outsideRepo: true }
	);
	dirs.push(dir);
	await initializeGitRepository(dir);
	const result = await moveBatchWithDependencies(
		{
			baseDir: dir,
			verify: false,
			journal: true,
			moves: [{ source: "value.ts", target: "moved/value.ts" }],
		},
		{
			moveModule: async (...args) => {
				await moveModuleWithRecovery(...args);
				throw new Error("after-move hook failed");
			},
		}
	).catch((error: unknown) => error);
	expect(result).toMatchObject({ rolledBack: true });
	expect(result instanceof Error && result.message).toContain(
		"after-move hook failed"
	);
	expect(await Bun.file(path.join(dir, "value.ts")).text()).toBe(sourceText);
	expect(await Bun.file(path.join(dir, "consumer.ts")).text()).toBe(
		importerText
	);
	expect(await Bun.file(path.join(dir, "moved/value.ts")).exists()).toBe(false);
	expect(await runGitCommand(dir, ["status", "--porcelain=v1"])).toBe("");
});
