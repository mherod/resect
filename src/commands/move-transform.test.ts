import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import { loadTransformConfig } from "../core/transform-config.ts";
import type { TransformRule } from "../types/transform.ts";
import { cleanup, makeFixture } from "./__test-helpers.ts";
import { moveModule } from "./move.ts";
import type { PreferStrategy } from "./option-domains.ts";

// Track every fixture and clean up once at the end: an afterEach that drained a
// shared list would delete a fixture another test is still using under
// `bun test --concurrent`.
const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) {
		await cleanup(dir);
	}
});

const TRANSFORMS_JS =
	"module.exports = { transforms: [{ from: 'import.meta.env.VITE_API_URL', to: 'process.env.NEXT_PUBLIC_API_URL' }] };\n";

const SOURCE_WITH_ACCESSOR =
	"export const apiUrl = import.meta.env.VITE_API_URL;\n";
const API_TRANSFORM_RULES: TransformRule[] = [
	{
		from: "import.meta.env.VITE_API_URL",
		to: "process.env.NEXT_PUBLIC_API_URL",
	},
];

async function moveWithTransform(
	dir: string,
	source: string,
	target: string,
	rules: TransformRule[],
	dryRun = false,
	prefer?: PreferStrategy
) {
	const absSource = path.join(dir, source);
	const tsconfigPath = resolveTsConfig(dir, path.dirname(absSource));
	if (!tsconfigPath) {
		throw new Error("tsconfig not found");
	}
	const project = loadProject(tsconfigPath, absSource);
	return moveModule(
		absSource,
		path.join(dir, target),
		project,
		dryRun,
		false,
		undefined,
		false,
		rules,
		prefer
	);
}

async function makeAliasedTransformFixture(
	name: string,
	importSpecifier: string
): Promise<string> {
	const dir = await makeFixture(name, {
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				baseUrl: ".",
				module: "ESNext",
				moduleResolution: "Bundler",
				paths: { "@/*": ["src/*"] },
				target: "ESNext",
			},
			include: ["src/**/*.ts"],
		}),
		"src/config.ts": [
			`import { format } from "${importSpecifier}";`,
			"export const apiUrl = format(import.meta.env.VITE_API_URL);",
			"",
		].join("\n"),
		"src/utils.ts": "export const format = (value: string) => value;\n",
	});
	dirs.push(dir);
	return dir;
}

describe("move --transform application (#124)", () => {
	test("rewrites a matched accessor in the moved file", async () => {
		const dir = await makeFixture(
			"move-transform",
			{
				"src/config.ts": SOURCE_WITH_ACCESSOR,
				".resect/transforms.js": TRANSFORMS_JS,
			},
			{ tsconfig: true }
		);
		dirs.push(dir);

		const rules = await loadTransformConfig(dir, ".resect/transforms.js");
		const result = await moveWithTransform(
			dir,
			"src/config.ts",
			"src/env/config.ts",
			rules
		);

		expect(result.success).toBe(true);
		const moved = await Bun.file(path.join(dir, "src/env/config.ts")).text();
		expect(moved).toContain("process.env.NEXT_PUBLIC_API_URL");
		expect(moved).not.toContain("import.meta.env.VITE_API_URL");
		expect(result.transformRewrites).toHaveLength(1);
		expect(result.transformRewrites?.[0]).toMatchObject({
			from: "import.meta.env.VITE_API_URL",
			to: "process.env.NEXT_PUBLIC_API_URL",
		});
	});

	test("a move with no rule set leaves the file content unchanged", async () => {
		const dir = await makeFixture(
			"move-no-transform",
			{ "src/config.ts": SOURCE_WITH_ACCESSOR },
			{ tsconfig: true }
		);
		dirs.push(dir);

		const result = await moveWithTransform(
			dir,
			"src/config.ts",
			"src/env/config.ts",
			[]
		);

		expect(result.success).toBe(true);
		expect(result.transformRewrites).toBeUndefined();
		const moved = await Bun.file(path.join(dir, "src/env/config.ts")).text();
		expect(moved).toBe(SOURCE_WITH_ACCESSOR);
	});

	test("--dry-run reports rewrites and writes nothing", async () => {
		const dir = await makeFixture(
			"move-transform-dry",
			{
				"src/config.ts": SOURCE_WITH_ACCESSOR,
				".resect/transforms.js": TRANSFORMS_JS,
			},
			{ tsconfig: true }
		);
		dirs.push(dir);

		const rules = await loadTransformConfig(dir, ".resect/transforms.js");
		const result = await moveWithTransform(
			dir,
			"src/config.ts",
			"src/env/config.ts",
			rules,
			true
		);

		expect(result.transformRewrites).toHaveLength(1);
		// Nothing written: destination absent, source untouched.
		expect(await Bun.file(path.join(dir, "src/env/config.ts")).exists()).toBe(
			false
		);
		const original = await Bun.file(path.join(dir, "src/config.ts")).text();
		expect(original).toBe(SOURCE_WITH_ACCESSOR);
	});

	test("--prefer=alias normalizes the transformed file to a matching alias", async () => {
		const dir = await makeAliasedTransformFixture(
			"move-transform-alias",
			"./utils"
		);

		const result = await moveWithTransform(
			dir,
			"src/config.ts",
			"src/env/config.ts",
			API_TRANSFORM_RULES,
			false,
			"alias"
		);

		expect(result.success).toBe(true);
		const moved = await Bun.file(path.join(dir, "src/env/config.ts")).text();
		expect(moved).toContain('from "@/utils"');
		expect(moved).toContain("process.env.NEXT_PUBLIC_API_URL");
	});

	test("a transform without --prefer keeps the relative default", async () => {
		const dir = await makeAliasedTransformFixture(
			"move-transform-relative-default",
			"@/utils"
		);

		const result = await moveWithTransform(
			dir,
			"src/config.ts",
			"src/env/config.ts",
			API_TRANSFORM_RULES
		);

		expect(result.success).toBe(true);
		const moved = await Bun.file(path.join(dir, "src/env/config.ts")).text();
		expect(moved).toContain('from "../utils"');
		expect(moved).not.toContain('from "@/utils"');
	});
});
