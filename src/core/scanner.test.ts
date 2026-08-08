import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { ProjectConfig } from "../types";
import { scanExports, scanModuleReferences } from "./scanner";
import { withSourceFile } from "./source-file";

// Snapshot the real resolver exports BEFORE any mock is installed so the
// afterAll restore cannot accidentally capture the mocked implementation.
// A dynamic import() is used instead of `import * as` to satisfy the
// ultracite noNamespaceImport lint rule.
const realResolverExports = { ...(await import("./resolver")) };

// Stub the resolver during THIS file's tests only — installed in beforeAll
// and restored in afterAll. bun's mock.module is process-global and
// persistent, so a top-level mock here would poison module resolution for
// every other test file that builds a fresh dependency graph afterwards
// (e.g. organise.test.ts saw empty importedBy maps → false-negative results).
beforeAll(async () => {
	await mock.module("./resolver", () => ({
		...realResolverExports,
		resolveModuleSpecifier: (specifier: string) => ({
			kind: "resolved",
			path: `/resolved/${specifier}`,
		}),
	}));
});

afterAll(async () => {
	await mock.module("./resolver", () => realResolverExports);
});

describe("scanModuleReferences", () => {
	const project = {
		compilerOptions: {},
		pathAliases: new Map(),
		rootDir: "/",
		tsconfigPath: "/tsconfig.json",
	} as ProjectConfig;

	test("scans jest.mock calls", () => {
		const sourceCode = `
            import { something } from './local';
            jest.mock('./mocked');
            vi.mock('./vi-mocked');
			vitest.mock('./vitest-mocked');
			mock.module('./bun-mocked', () => ({ foo: () => 1 }));
        `;
		const sourceFile = ts.createSourceFile(
			"test.ts",
			sourceCode,
			ts.ScriptTarget.Latest
		);
		const refs = scanModuleReferences(sourceFile, project);

		expect(refs).toContainEqual(
			expect.objectContaining({ specifier: "./mocked", type: "jest-mock" })
		);
		expect(refs).toContainEqual(
			expect.objectContaining({ specifier: "./vi-mocked", type: "jest-mock" })
		);
		expect(refs).toContainEqual(
			expect.objectContaining({
				specifier: "./vitest-mocked",
				type: "jest-mock",
			})
		);
		expect(refs).toContainEqual(
			expect.objectContaining({
				specifier: "./bun-mocked",
				type: "jest-mock",
				factoryEntries: [
					expect.objectContaining({ key: "foo", valueNodeKind: "other" }),
				],
			})
		);
	});

	test("extracts mock factory entries for object literal factories", () => {
		const sourceCode = `
			jest.mock('./mocked', () => ({
				foo: jest.fn(),
				bar: vi.fn(),
				answer: 42,
			}));
        `;
		const sourceFile = ts.createSourceFile(
			"test.ts",
			sourceCode,
			ts.ScriptTarget.Latest
		);
		const refs = scanModuleReferences(sourceFile, project);
		const mockRef = refs.find((ref) => ref.specifier === "./mocked");

		expect(mockRef?.factoryEntries?.map((entry) => entry.key)).toEqual([
			"foo",
			"bar",
			"answer",
		]);
		expect(
			mockRef?.factoryEntries?.map((entry) => entry.valueNodeKind)
		).toEqual(["jest.fn", "vi.fn", "literal"]);
	});

	test("skips unsupported mock factory shapes without empty factory entries", () => {
		const sourceCode = `
			const factory = () => ({ foo: vi.fn() });
			vi.mock('./mocked', factory);
        `;
		const sourceFile = ts.createSourceFile(
			"test.ts",
			sourceCode,
			ts.ScriptTarget.Latest
		);
		const refs = scanModuleReferences(sourceFile, project);
		const mockRef = refs.find((ref) => ref.specifier === "./mocked");

		expect(mockRef?.factoryEntries).toBeUndefined();
		expect(mockRef?.mockFactorySkip?.reason).toBe("unsupported-factory");
	});

	test("scans external import-equals declarations as namespace imports", () => {
		const sourceFile = ts.createSourceFile(
			"test.ts",
			[
				'import Thing = require("./thing");',
				"import Alias = Namespace.Thing;",
			].join("\n"),
			ts.ScriptTarget.Latest
		);

		expect(scanModuleReferences(sourceFile, project)).toEqual([
			expect.objectContaining({
				bindings: [{ isType: false, name: "Thing" }],
				isTypeOnly: false,
				specifier: "./thing",
				type: "import-namespace",
			}),
		]);
	});
});

describe("scanExports", () => {
	test("includes named re-export aliases in the visible export surface", () => {
		const sourceFile = ts.createSourceFile(
			"barrel.ts",
			'export { foo as bar } from "./inner";\nexport * as ns from "./inner";',
			ts.ScriptTarget.Latest
		);

		expect(scanExports(sourceFile).map((entry) => entry.name)).toEqual([
			"bar",
			"ns",
		]);
	});

	test("recognizes export-equals assignments", () => {
		const sourceFile = ts.createSourceFile(
			"commonjs.ts",
			"const Thing = {};\nexport = Thing;",
			ts.ScriptTarget.Latest
		);

		expect(scanExports(sourceFile)).toContainEqual({
			isType: false,
			line: 2,
			name: "default",
			type: "default",
		});
	});
});

describe("withSourceFile", () => {
	test("runs the callback for a readable file", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-scanner-"));
		const filePath = path.join(dir, "sample.ts");
		await Bun.write(filePath, "export const value = 1;\n");

		try {
			const statementCount = withSourceFile(
				filePath,
				(sourceFile) => sourceFile.statements.length,
				-1
			);

			expect(statementCount).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns the fallback when the file cannot be read", () => {
		const statementCount = withSourceFile(
			"/tmp/resect-missing-source-file.ts",
			(sourceFile) => sourceFile.statements.length,
			-1
		);

		expect(statementCount).toBe(-1);
	});
	test("runs the callback for a source file already loaded in a program", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-program-"));
		const filePath = path.join(dir, "program-source.ts");
		await Bun.write(filePath, "export const loaded = true;\n");

		try {
			const program = ts.createProgram([filePath], {
				target: ts.ScriptTarget.ES2020,
			});
			const statementCount = withSourceFile(
				program,
				filePath,
				(sourceFile) => sourceFile.statements.length,
				-1
			);

			expect(statementCount).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns the fallback when the program has no matching source file", () => {
		const program = ts.createProgram([], {
			target: ts.ScriptTarget.ES2020,
		});
		const statementCount = withSourceFile(
			program,
			"/tmp/resect-missing-program-source.ts",
			(sourceFile) => sourceFile.statements.length,
			-1
		);

		expect(statementCount).toBe(-1);
	});
});
