import { describe, expect, test } from "bun:test";
import path from "node:path";

const PRE_COMMIT_HOOK = path.join(import.meta.dir, "../.husky/pre-commit");

describe("pre-commit hook", () => {
	test("uses a supported local-package global install command (#152)", async () => {
		const hook = await Bun.file(PRE_COMMIT_HOOK).text();

		expect(hook).toContain("pnpm add --global .");
		expect(hook).not.toContain("pnpm link --global");
	});
});
