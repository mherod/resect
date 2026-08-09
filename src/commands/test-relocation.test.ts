import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
	captureOutput,
	cleanup,
	makeFixture as makeFixtureBase,
	readRegistrationSource,
} from "./__test-helpers";
import { testRelocationCommand } from "./test-relocation.ts";

async function makeFixture(name: string, files: Record<string, string>) {
	return makeFixtureBase(`test-relocation-${name}`, files, {
		tsconfig: true,
		outsideRepo: true,
	});
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

describe("test-relocation command", () => {
	test("reports stranded tests and suggests __tests__ placement", async () => {
		const dir = await makeFixture("stranded", {
			"src/core/cookies/foo.ts": "export const foo = 1;\n",
			"src/tests/foo.test.ts":
				'import { foo } from "../core/cookies/foo";\nexport const result = foo;\n',
		});

		const result = await captureOutput(async () =>
			testRelocationCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout);
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0].reasons).toEqual(["stranded"]);
		expect(report.findings[0].currentLocation).toBe("tests/foo.test.ts");
		expect(report.findings[0].suggestedLocation).toBe(
			"core/cookies/__tests__/foo.test.ts"
		);

		await cleanup(dir);
	});

	test("reports misnamed tests based on the imported subject module", async () => {
		const dir = await makeFixture("misnamed", {
			"src/utils/jwt.ts":
				"export const isJWT = (value: string) => value.length > 0;\n",
			"src/utils/__tests__/readGithubCookies.test.ts":
				'import { isJWT } from "../jwt";\nexport const result = isJWT("token");\n',
		});

		const result = await captureOutput(async () =>
			testRelocationCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout);
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0].reasons).toEqual(["misnamed"]);
		expect(report.findings[0].suggestedLocation).toBe(
			"utils/__tests__/jwt.test.ts"
		);

		await cleanup(dir);
	});

	test("skips tests that import subjects from multiple directories", async () => {
		const dir = await makeFixture("multi-dir", {
			"src/core/cookies/foo.ts": "export const foo = 1;\n",
			"src/utils/jwt.ts": "export const isJWT = () => true;\n",
			"src/tests/mixed.test.ts":
				'import { foo } from "../core/cookies/foo";\nimport { isJWT } from "../utils/jwt";\nexport const result = foo + Number(isJWT());\n',
		});

		const result = await captureOutput(async () =>
			testRelocationCommand({ directory: path.join(dir, "src"), json: true })
		);
		const report = JSON.parse(result.stdout);
		expect(report.findings).toHaveLength(0);

		await cleanup(dir);
	});

	test("uses alongside placement when __tests__ convention is below threshold", async () => {
		const dir = await makeFixture("alongside-convention", {
			"src/core/cookies/foo.ts": "export const foo = 1;\n",
			"src/core/cookies/bar.ts": "export const bar = 2;\n",
			"src/core/cookies/bar.test.ts":
				'import { bar } from "./bar";\nexport const result = bar;\n',
			"src/tests/foo.test.ts":
				'import { foo } from "../core/cookies/foo";\nexport const result = foo;\n',
		});

		const result = await captureOutput(async () =>
			testRelocationCommand({
				directory: path.join(dir, "src"),
				json: true,
				conventionThreshold: 0.8,
			})
		);
		const report = JSON.parse(result.stdout);
		expect(report.summary.convention).toBe("alongside");
		expect(report.findings[0].suggestedLocation).toBe(
			"core/cookies/foo.test.ts"
		);

		await cleanup(dir);
	});

	test("--fix moves tests through the relocation path", async () => {
		const dir = await makeFixture("fix", {
			"src/core/cookies/foo.ts": "export const foo = 1;\n",
			"src/tests/foo.test.ts":
				'import { foo } from "../core/cookies/foo";\nexport const result = foo;\n',
		});

		const result = await captureOutput(async () =>
			testRelocationCommand({
				directory: path.join(dir, "src"),
				fix: true,
				force: true,
				json: true,
			})
		);
		const report = JSON.parse(result.stdout);
		expect(report.success).toBe(true);
		const target = path.join(dir, "src/core/cookies/__tests__/foo.test.ts");
		expect(await exists(target)).toBe(true);
		expect(await exists(path.join(dir, "src/tests/foo.test.ts"))).toBe(false);
		expect(await readFile(target, "utf8")).toContain(
			'import { foo } from "../foo";'
		);

		await cleanup(dir);
	});

	test("registers the MCP tool", async () => {
		// Registrations moved to per-domain modules in #187; they sit inside
		// `register<Domain>Tools(server)`, hence the extra tab.
		const registrationSource = await readRegistrationSource();
		const toolSource = await readFile(
			path.resolve(import.meta.dir, "../mcp-tools/read-only.ts"),
			"utf8"
		);
		expect(registrationSource).toContain(
			'\tserver.registerTool(\n\t\t"test-relocation"'
		);
		expect(toolSource).toContain("buildTestRelocationReport");
	});
});
