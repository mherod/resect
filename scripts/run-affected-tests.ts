#!/usr/bin/env bun
import { affected } from "../src/commands/affected.ts";

const diff =
	await Bun.$`git diff --cached --name-only --diff-filter=ACMR`.text();
const stagedFiles = diff
	.split("\n")
	.map((f) => f.trim())
	.filter((f) => f.length > 0);

if (stagedFiles.length === 0) {
	console.log("No staged files detected. Skipping test execution.");
	process.exit(0);
}

// Critical configuration files or directories that should trigger a full run.
const configFiles = [
	"tsconfig.json",
	"tsconfig.build.json",
	"package.json",
	"pnpm-lock.yaml",
	"biome.json",
	"eslint.config.js",
	"pnpm-workspace.yaml",
];

const hasConfigOrNonSourceChanges = stagedFiles.some((file) => {
	// If any config file changed
	if (configFiles.includes(file) || file.startsWith(".husky/")) {
		return true;
	}
	// If any file has non-source extensions (excluding markdown/documentation)
	const ext = file.split(".").pop();
	if (ext && !["ts", "tsx", "js", "jsx", "vue", "md"].includes(ext)) {
		return true;
	}
	return false;
});

if (hasConfigOrNonSourceChanges) {
	console.log(
		"Configuration or non-source changes detected. Running full test suite..."
	);
	const proc = await Bun.$`bun test --timeout=20000`;
	process.exit(proc.exitCode);
}

try {
	console.log("Calculating affected files for staged changes...");
	const affectedFiles = await affected({
		files: stagedFiles,
		workspace: true,
	});

	const testFiles = affectedFiles.filter(
		(f) => f.endsWith(".test.ts") || f.endsWith(".spec.ts")
	);

	if (testFiles.length === 0) {
		console.log("No affected test files found. Skipping tests.");
		process.exit(0);
	}

	console.log(
		`Running ${testFiles.length} affected test file(s):\n${testFiles.map((f) => `  - ${f}`).join("\n")}`
	);

	// Run only the affected test files
	const proc = await Bun.$`bun test --timeout=20000 ${testFiles}`;
	process.exit(proc.exitCode);
} catch (error) {
	console.error(
		"Error calculating affected files. Falling back to full test suite...",
		error
	);
	const proc = await Bun.$`bun test --timeout=20000`;
	process.exit(proc.exitCode);
}
