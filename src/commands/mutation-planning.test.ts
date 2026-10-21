import { afterEach, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { logger } from "../cli-logger.ts";
import { loadProject } from "../core/project.ts";
import { applyStructuredEdits } from "../core/text-changes.ts";
import { bunRuntime, setRuntime } from "../runtime/index.ts";
import { makeFixture } from "./__test-helpers.ts";
import { applyMoveModulePlan, moveModule } from "./move-apply.ts";
import { planMoveModule } from "./move-module-plan.ts";
import {
	createCompactStructuredEdit,
	runMutationPlanning,
	shouldUsePlanningWorker,
} from "./mutation-planning.ts";
import { applyRenamePlan, planRenameSymbol, renameSymbol } from "./rename.ts";

afterEach(() => {
	setRuntime(bunRuntime);
});

test("compact edit spans preserve UTF-16, line metadata and exact application", () => {
	const prefix = `${"unchanged\n".repeat(1024)}\ud800 \ud83d\ude00 `;
	const suffix = `\r\n${"unchanged\n".repeat(1024)}`;
	const before = `${prefix}before${suffix}`;
	const after = `${prefix}after${suffix}`;
	const edit = createCompactStructuredEdit("unicode.ts", before, after);
	if (!edit) {
		throw new Error("Expected edit");
	}
	expect(applyStructuredEdits(before, [edit])).toBe(after);
	expect(edit.line).toBe(1025);
	expect(Object.keys(edit)).not.toContain("line");
	expect(
		createCompactStructuredEdit("same.ts", before, before)
	).toBeUndefined();
});

async function fixture() {
	const files: Record<string, string> = {
		"src/value.ts":
			"export function value() { return value; }\nexport function local(value: number) { return value; }\n",
		"src/use.ts":
			'import { value, local } from "./value";\nexport const result = [value(), local(1)];\n',
		"src/alias.ts":
			'import { value as kept } from "./value";\nexport const result = kept();\n',
	};
	for (let index = 0; index < 128; index++) {
		files[`src/filler${index}.ts`] =
			`export const filler${index} = ${index};\n`;
	}
	const dir = await makeFixture("mutation-worker", files, {
		outsideRepo: true,
		tsconfig: "bundler",
	});
	return {
		dir,
		files,
		project: loadProject(path.join(dir, "tsconfig.json")),
		source: path.join(dir, "src/value.ts"),
		consumer: path.join(dir, "src/use.ts"),
		target: path.join(dir, "src/nested/value.ts"),
	};
}

test("worker rename preserves complete edits, local identity and caller-owned writes", async () => {
	const { source, project, files, dir } = await fixture();
	expect(shouldUsePlanningWorker([project])).toBe(true);
	const reference = await planRenameSymbol(
		source,
		"value",
		"renamed",
		project,
		false
	);
	const preview = await renameSymbol(
		source,
		"value",
		"renamed",
		project,
		true,
		false
	);
	expect(preview).toEqual(reference.result);
	for (const edit of preview.edits) {
		expect(edit.line).toBeGreaterThan(0);
		expect(Object.keys(edit)).not.toContain("line");
	}
	for (const [file, content] of Object.entries(files)) {
		expect(await Bun.file(path.join(dir, file)).text()).toBe(content);
	}
	const applied = await renameSymbol(
		source,
		"value",
		"renamed",
		project,
		false,
		false
	);
	expect(applied).toEqual(preview);
	for (const edit of preview.edits) {
		expect(await Bun.file(edit.file).text()).toBe(
			applyStructuredEdits(files[path.relative(dir, edit.file)] ?? "", [edit])
		);
	}
	expect(await Bun.file(source).text()).toContain(
		"local(value: number) { return value; }"
	);
});

test("worker move matches injected-runtime planning and applies its complete plan", async () => {
	const { source, target, project, consumer, files } = await fixture();
	setRuntime({ ...bunRuntime });
	expect(shouldUsePlanningWorker([project])).toBe(false);
	const reference = await planMoveModule(source, target, project, false);
	setRuntime(bunRuntime);
	const plan = await planMoveModule(source, target, project, false);
	expect(plan).toEqual(reference);
	expect(await moveModule(source, target, project, true, false)).toEqual(
		plan.result
	);
	expect(await Bun.file(consumer).text()).toBe(files["src/use.ts"] ?? "");
	expect(await Bun.file(source).exists()).toBe(true);
	expect(await Bun.file(target).exists()).toBe(false);
	for (const edit of plan.result.edits) {
		expect(edit.line).toBeGreaterThan(0);
	}
	expect(await moveModule(source, target, project, false, false)).toEqual(
		plan.result
	);
	expect(await Bun.file(source).exists()).toBe(false);
	expect(plan.movedContent).toBe(await Bun.file(target).text());
	for (const write of plan.writes) {
		expect(await Bun.file(write.file).text()).toBe(write.content);
	}
});

test("compact worker writes reject a stale importer without replacing its content", async () => {
	const { source, target, project, consumer } = await fixture();
	const plan = await runMutationPlanning({
		kind: "move",
		args: [source, target, project, false],
		compactWrites: true,
	});
	const changed =
		'import { changed } from "./value";\nexport const mine = changed;\n';
	await Bun.write(consumer, changed);
	const result = await applyMoveModulePlan(plan);
	expect(result.success).toBe(false);
	expect(
		result.errors.some(
			(error) =>
				error.file === consumer && error.message.includes("does not match")
		)
	).toBe(true);
	expect(await Bun.file(consumer).text()).toBe(changed);
});

test("worker rename retains references from additional workspace projects", async () => {
	const { dir, source, project } = await fixture();
	const extraFile = path.join(dir, "extra/use.ts");
	await Bun.write(
		extraFile,
		'import { value } from "../src/value";\nexport const extra = value();\n'
	);
	const extraConfig = path.join(dir, "extra/tsconfig.json");
	await Bun.write(
		extraConfig,
		JSON.stringify({
			compilerOptions: {
				moduleResolution: "Bundler",
				module: "ESNext",
				types: [],
			},
			include: ["use.ts"],
		})
	);
	const extra = loadProject(extraConfig);
	const reference = await planRenameSymbol(
		source,
		"value",
		"renamed",
		project,
		false,
		[extra]
	);
	const preview = await renameSymbol(
		source,
		"value",
		"renamed",
		project,
		true,
		false,
		[extra]
	);
	expect(preview.success).toBe(true);
	expect(preview).toEqual(reference.result);
	expect(preview.edits.some((edit) => edit.file === extraFile)).toBe(true);
	const result = await renameSymbol(
		source,
		"value",
		"renamed",
		project,
		false,
		false,
		[extra]
	);
	expect(result).toEqual(preview);
	expect(await Bun.file(extraFile).text()).toBe(
		'import { renamed as value } from "../src/value";\nexport const extra = value();\n'
	);
});

test("worker conflicts, missing exports and destinations leave files intact and preserve warnings", async () => {
	const { source, target, project, consumer, files } = await fixture();
	const conflict = await renameSymbol(
		source,
		"value",
		"local",
		project,
		false,
		false
	);
	expect(conflict.success).toBe(false);
	expect(conflict.edits).toEqual([]);
	const missing = await renameSymbol(
		source,
		"absent",
		"renamed",
		project,
		false,
		false
	);
	expect(missing.errors[0]?.message).toContain('Export "absent" not found');
	const warnings: string[] = [];
	const warn = spyOn(logger, "warn").mockImplementation((message) => {
		warnings.push(message);
	});
	try {
		await renameSymbol(
			source,
			"value",
			"local",
			project,
			true,
			false,
			[],
			true
		);
	} finally {
		warn.mockRestore();
	}
	expect(
		warnings.some((message) => message.includes("Proceeding past conflict"))
	).toBe(true);
	await Bun.write(target, "export const existing = 1;\n");
	const move = await planMoveModule(source, target, project, false);
	expect(move.result.success).toBe(false);
	expect(move.writes).toEqual([]);
	expect(move.result.errors[0]?.message).toBe("Target file already exists");
	expect(await Bun.file(source).text()).toBe(files["src/value.ts"] ?? "");
	expect(await Bun.file(consumer).text()).toBe(files["src/use.ts"] ?? "");
});

test("rename application retains fatal source failures and recoverable importer errors", async () => {
	const { source, project } = await fixture();
	const plan = await planRenameSymbol(
		source,
		"value",
		"renamed",
		project,
		false
	);
	const writes: string[] = [];
	const parseFailure = { file: "later.ts", message: "Could not parse file" };
	plan.result.errors.push(parseFailure);
	setRuntime({
		...bunRuntime,
		fs: {
			...bunRuntime.fs,
			writeFile: async (file) => {
				writes.push(file);
				throw new Error("write rejected");
			},
		},
	});
	let failure: unknown;
	try {
		await applyRenamePlan(plan);
	} catch (error) {
		failure = error;
	}
	expect(failure).toEqual(new Error("write rejected"));
	expect(writes).toEqual([source]);
	writes.length = 0;
	setRuntime({
		...bunRuntime,
		fs: {
			...bunRuntime.fs,
			writeFile: async (file) => {
				writes.push(file);
				if (file !== source) {
					throw new Error("importer rejected");
				}
			},
		},
	});
	await applyRenamePlan(plan);
	expect(writes).toEqual(plan.writes.map((write) => write.file));
	expect(plan.result.success).toBe(false);
	expect(plan.result.errors).toHaveLength(plan.writes.length);
	expect(plan.result.errors.at(-1)).toEqual(parseFailure);
});
