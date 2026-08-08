import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { makeTempDir, runCli } from "./__test-helpers.ts";
import { renameInSourceFile } from "./rename";

const tempDirs: string[] = [];

afterAll(async () => {
	for (const dir of tempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
});

async function makeRenameCliProject(): Promise<{
	apiPath: string;
	consumerPath: string;
	tsconfigPath: string;
}> {
	const dir = await makeTempDir("rename");
	tempDirs.push(dir);
	const srcDir = path.join(dir, "src");
	await mkdir(srcDir, { recursive: true });
	const tsconfigPath = path.join(dir, "tsconfig.json");
	await writeFile(
		tsconfigPath,
		JSON.stringify({
			compilerOptions: {
				module: "ESNext",
				moduleResolution: "Bundler",
				noEmit: true,
				strict: true,
				target: "ESNext",
				types: [],
			},
			include: ["src/**/*.ts"],
		})
	);
	const apiPath = path.join(srcDir, "api.ts");
	const consumerPath = path.join(srcDir, "consumer.ts");
	await writeFile(apiPath, "export const foo = 1;\n");
	await writeFile(
		consumerPath,
		'import * as api from "./api";\nexport const value: 1 = api.foo;\n'
	);
	return { apiPath, consumerPath, tsconfigPath };
}

async function makeCommonJsRenameProject(): Promise<{
	apiPath: string;
	consumerPath: string;
	tsconfigPath: string;
}> {
	const dir = await makeTempDir("rename-commonjs");
	tempDirs.push(dir);
	const srcDir = path.join(dir, "src");
	await mkdir(srcDir, { recursive: true });
	const tsconfigPath = path.join(dir, "tsconfig.json");
	await writeFile(
		tsconfigPath,
		JSON.stringify({
			compilerOptions: {
				module: "CommonJS",
				moduleResolution: "Node",
				noEmit: true,
				strict: true,
				target: "ESNext",
				types: [],
			},
			include: ["src/**/*.ts"],
		})
	);
	const apiPath = path.join(srcDir, "api.ts");
	const consumerPath = path.join(srcDir, "consumer.ts");
	await writeFile(apiPath, "function Thing() { return 1; }\nexport = Thing;\n");
	await writeFile(
		consumerPath,
		'import Thing = require("./api");\nexport const value = Thing();\n'
	);
	return { apiPath, consumerPath, tsconfigPath };
}

function buildProgram(source: string): {
	program: ts.Program;
	sourceFile: ts.SourceFile;
} {
	const fileName = "/virtual/test.ts";
	const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext };
	const host = ts.createCompilerHost(options, true);
	host.getSourceFile = (name, languageVersion) => {
		if (name === fileName) {
			return ts.createSourceFile(name, source, languageVersion, true);
		}
		return undefined;
	};
	host.readFile = (name) => (name === fileName ? source : undefined);
	host.fileExists = (name) => name === fileName;
	host.writeFile = () => undefined;

	const program = ts.createProgram([fileName], options, host);
	const sourceFile = program.getSourceFile(fileName);
	if (!sourceFile) {
		throw new Error("Failed to create source file");
	}
	return { program, sourceFile };
}

function getExportedSymbol(
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
	name: string
): ts.Symbol | null {
	let found: ts.Symbol | null = null;
	const visit = (node: ts.Node) => {
		if (found) {
			return;
		}
		if (
			ts.isFunctionDeclaration(node) &&
			node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
			node.name?.text === name
		) {
			found = checker.getSymbolAtLocation(node.name) ?? null;
			return;
		}
		if (
			ts.isVariableStatement(node) &&
			node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
		) {
			for (const decl of node.declarationList.declarations) {
				if (ts.isIdentifier(decl.name) && decl.name.text === name) {
					found = checker.getSymbolAtLocation(decl.name) ?? null;
					return;
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

function rename(source: string, oldName: string, newName: string): string {
	const { program, sourceFile } = buildProgram(source);
	const checker = program.getTypeChecker();
	const renamedSymbol = getExportedSymbol(sourceFile, checker, oldName);
	return renameInSourceFile(sourceFile, oldName, newName, {
		checker,
		renamedSymbol: renamedSymbol ?? undefined,
	}).newContent;
}

describe("renameInSourceFile — shadowing", () => {
	test("renames exported function declaration", () => {
		const src = "export function foo() { return 42; }";
		expect(rename(src, "foo", "bar")).toBe(
			"export function bar() { return 42; }"
		);
	});

	test("renames self-recursive exported function", () => {
		const src = "export function foo() { return foo(); }";
		expect(rename(src, "foo", "bar")).toBe(
			"export function bar() { return bar(); }"
		);
	});

	test("does not rename shadowed parameter declaration", () => {
		const src = [
			"export function foo() { return 42; }",
			"function bar(foo: number) { return foo * 2; }",
		].join("\n");
		const result = rename(src, "foo", "baz");
		// exported declaration renamed
		expect(result).toContain("export function baz()");
		// parameter declaration left unchanged
		expect(result).toContain("function bar(foo: number)");
		// parameter usage left unchanged
		expect(result).toContain("return foo * 2");
	});

	test("does not rename usages inside a function with shadowing parameter", () => {
		const src = [
			"export const foo = 1;",
			"function inner(foo: string) { return foo.length; }",
		].join("\n");
		const result = rename(src, "foo", "qux");
		expect(result).toContain("export const qux = 1");
		expect(result).toContain("function inner(foo: string)");
		expect(result).toContain("return foo.length");
	});

	test("does not rename destructured parameter with same name", () => {
		const src = [
			"export function foo() {}",
			"function bar({ foo }: { foo: number }) { return foo + 1; }",
		].join("\n");
		const result = rename(src, "foo", "baz");
		expect(result).toContain("export function baz()");
		expect(result).toContain("function bar({ foo }");
		expect(result).toContain("return foo + 1");
	});

	test("does not rename inner function declaration with same name", () => {
		const src = [
			"export function foo() { return 1; }",
			"function outer() { function foo() { return 2; } return foo(); }",
		].join("\n");
		const result = rename(src, "foo", "baz");
		expect(result).toContain("export function baz()");
		// inner function declaration not renamed
		expect(result).toContain("function foo()");
	});

	test("renames real references to export outside any shadowed scope", () => {
		const src = [
			"export function foo() {}",
			"const ref = foo;",
			"function bar(foo: number) { return foo; }",
		].join("\n");
		const result = rename(src, "foo", "baz");
		expect(result).toContain("export function baz()");
		expect(result).toContain("const ref = baz");
		expect(result).toContain("function bar(foo: number)");
		expect(result).toContain("return foo");
	});

	test("does not rename variable declaration with same name", () => {
		const src = [
			"export const foo = 1;",
			"function bar() { const foo = 2; return foo; }",
		].join("\n");
		const result = rename(src, "foo", "baz");
		expect(result).toContain("export const baz = 1");
		// inner declaration left unchanged
		expect(result).toContain("const foo = 2");
	});

	test("renames shorthand object properties that reference the export", () => {
		const src = ["export const foo = 1;", "const obj = { foo };"].join("\n");
		const result = rename(src, "foo", "bar");
		expect(result).toContain("export const bar = 1");
		expect(result).toContain("const obj = { bar }");
	});
});

describe("rename CLI verification", () => {
	test("renames the identifier behind an export-equals assignment", async () => {
		const { apiPath, consumerPath, tsconfigPath } =
			await makeCommonJsRenameProject();

		const result = await runCli([
			"rename",
			apiPath,
			"Thing",
			"RenamedThing",
			"--no-verify",
			"-p",
			tsconfigPath,
		]);

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(apiPath).text()).toBe(
			"function RenamedThing() { return 1; }\nexport = RenamedThing;\n"
		);
		expect(await Bun.file(consumerPath).text()).toContain(
			'import Thing = require("./api");'
		);
	});

	test("dry-run edits reproduce the real rename without writing", async () => {
		const { apiPath, tsconfigPath } = await makeRenameCliProject();
		const before = await Bun.file(apiPath).text();

		const human = await runCli([
			"rename",
			apiPath,
			"foo",
			"bar",
			"--dry-run",
			"-p",
			tsconfigPath,
		]);
		expect(human.exitCode).toBe(0);
		expect(human.stdout).toContain("--- a/src/api.ts");
		expect(human.stdout).toContain("-export const foo = 1;");
		expect(human.stdout).toContain("+export const bar = 1;");

		const json = await runCli([
			"rename",
			apiPath,
			"foo",
			"bar",
			"--dry-run",
			"--json",
			"-p",
			tsconfigPath,
		]);
		const payload = JSON.parse(json.stdout) as {
			edits: Array<{
				file: string;
				start: number;
				end: number;
				oldText: string;
				newText: string;
			}>;
		};
		expect(json.exitCode).toBe(0);
		expect(payload.edits).toEqual([
			{
				file: "src/api.ts",
				start: 0,
				end: 22,
				oldText: "export const foo = 1;\n",
				newText: "export const bar = 1;\n",
			},
		]);
		expect(await Bun.file(apiPath).text()).toBe(before);

		const edit = payload.edits[0];
		if (!edit) {
			throw new Error("Expected an API edit");
		}
		const previewed =
			before.slice(0, edit.start) + edit.newText + before.slice(edit.end);
		const applied = await runCli([
			"rename",
			apiPath,
			"foo",
			"bar",
			"--no-verify",
			"-p",
			tsconfigPath,
		]);
		expect(applied.exitCode).toBe(0);
		expect(await Bun.file(apiPath).text()).toBe(previewed);
	});

	test("fails by default when the rename introduces a typecheck delta", async () => {
		const { apiPath, consumerPath, tsconfigPath } =
			await makeRenameCliProject();

		const result = await runCli([
			"rename",
			apiPath,
			"foo",
			"bar",
			"--force",
			"-p",
			tsconfigPath,
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("Renamed successfully");
		expect(result.stderr).toContain("Type checking failed");
		expect(result.stderr).toContain("Property 'foo' does not exist");
		expect(await Bun.file(apiPath).text()).toContain("export const bar = 1");
		expect(await Bun.file(consumerPath).text()).toContain("api.foo");
	});

	test("--no-verify preserves the legacy unchecked CLI path", async () => {
		const { apiPath, consumerPath, tsconfigPath } =
			await makeRenameCliProject();

		const result = await runCli([
			"rename",
			apiPath,
			"foo",
			"bar",
			"--force",
			"--no-verify",
			"-p",
			tsconfigPath,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Renamed successfully");
		expect(result.stderr).not.toContain("Type checking failed");
		expect(await Bun.file(apiPath).text()).toContain("export const bar = 1");
		expect(await Bun.file(consumerPath).text()).toContain("api.foo");
	});
});
