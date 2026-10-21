import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import {
	applyStructuredEdits,
	type StructuredEdit,
} from "../../src/core/text-changes.ts";
import { gitOutput, validateFixture } from "./vscode.ts";

export interface MutationFixture {
	original: string;
	fixture: string;
	source: string;
	target: string;
	project: string;
}

export async function assertAppliedEdits(
	options: MutationFixture,
	edits: StructuredEdit[],
	isMove: boolean
): Promise<void> {
	const { original, fixture, source, target, project } = options;
	const editsByFile = new Map<string, StructuredEdit[]>();
	for (const edit of edits) {
		const file = path.resolve(path.dirname(project), edit.file);
		const grouped = editsByFile.get(file) ?? [];
		grouped.push(edit);
		editsByFile.set(file, grouped);
	}
	for (const [file, changes] of editsByFile) {
		const beforeFile = isMove && file === target ? source : file;
		const before = await Bun.file(
			path.join(original, path.relative(fixture, beforeFile))
		).text();
		if (
			(await Bun.file(file).text()) !== applyStructuredEdits(before, changes)
		) {
			throw new Error(`Applied bytes differ from preview: ${file}`);
		}
	}
	if (
		isMove &&
		((await Bun.file(source).exists()) || !(await Bun.file(target).exists()))
	) {
		throw new Error("Move did not relocate the file");
	}
	const expected = new Set(editsByFile.keys());
	if (isMove) {
		expected.add(source);
		expected.add(target);
	}
	const changed = (
		await gitOutput(fixture, [
			"diff",
			"HEAD",
			"--name-only",
			"--no-renames",
			"-z",
		])
	)
		.split("\0")
		.filter(Boolean);
	if (changed.some((file) => !expected.has(path.resolve(fixture, file)))) {
		throw new Error("Mutation changed an unplanned file");
	}
}

export async function restoreMutationFixture(
	options: MutationFixture
): Promise<void> {
	const { original, fixture, source, target } = options;
	const changed = (
		await gitOutput(fixture, [
			"diff",
			"HEAD",
			"--name-only",
			"--no-renames",
			"-z",
		])
	)
		.split("\0")
		.filter(Boolean);
	for (const relative of changed) {
		const file = path.resolve(fixture, relative);
		if (!file.startsWith(`${fixture}${path.sep}`)) {
			throw new Error("Unexpected changed path");
		}
		if (file === target) {
			continue;
		}
		if (
			(await Bun.file(file).exists()) &&
			(await lstat(file)).isSymbolicLink()
		) {
			throw new Error("Refusing to restore through a symlink");
		}
		await Bun.write(file, Bun.file(path.join(original, relative)));
	}
	if (await Bun.file(target).exists()) {
		await unlink(target);
	}
	if (changed.length > 0) {
		await gitOutput(fixture, [
			"restore",
			"--staged",
			"--",
			...new Set([...changed, path.relative(fixture, source)]),
		]);
	}
	await validateFixture(fixture);
}
