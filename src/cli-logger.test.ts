import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CLILogger } from "./cli-logger.ts";

describe("CLILogger", () => {
	let logger: CLILogger;
	let stdoutCalls: string[];
	let stderrCalls: string[];
	let originalStdout: typeof process.stdout.write;
	let originalStderr: typeof process.stderr.write;

	beforeEach(() => {
		logger = new CLILogger();
		stdoutCalls = [];
		stderrCalls = [];
		originalStdout = process.stdout.write.bind(process.stdout);
		originalStderr = process.stderr.write.bind(process.stderr);
		process.stdout.write = (chunk: string) => {
			stdoutCalls.push(chunk);
			return true;
		};
		process.stderr.write = (chunk: string) => {
			stderrCalls.push(chunk);
			return true;
		};
	});

	afterEach(() => {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
	});

	describe("info", () => {
		test("writes message with newline to stdout", () => {
			logger.info("hello world");
			expect(stdoutCalls).toEqual(["hello world\n"]);
			expect(stderrCalls).toEqual([]);
		});

		test("preserves leading/trailing whitespace", () => {
			logger.info("  indented message  ");
			expect(stdoutCalls).toEqual(["  indented message  \n"]);
		});

		test("handles empty string", () => {
			logger.info("");
			expect(stdoutCalls).toEqual(["\n"]);
		});
	});

	describe("success", () => {
		test("writes message with newline to stdout", () => {
			logger.success("✅ Done!");
			expect(stdoutCalls).toEqual(["✅ Done!\n"]);
			expect(stderrCalls).toEqual([]);
		});
	});

	describe("error", () => {
		test("writes message with newline to stderr", () => {
			logger.error("something went wrong");
			expect(stderrCalls).toEqual(["something went wrong\n"]);
			expect(stdoutCalls).toEqual([]);
		});

		test("does not write to stdout", () => {
			logger.error("❌ Failed");
			expect(stdoutCalls).toHaveLength(0);
		});
	});

	describe("file scan progress", () => {
		test("updates stderr in place on a TTY and throttles intermediate writes", () => {
			let now = 0;
			logger = new CLILogger({
				now: () => now,
				stderrIsTTY: () => true,
			});
			const onProgress = logger.createFileScanProgress({ enabled: true });

			expect(onProgress).toBeDefined();
			onProgress?.(1, 500);
			now = 50;
			onProgress?.(2, 500);
			now = 100;
			onProgress?.(3, 500);
			now = 101;
			onProgress?.(500, 500);

			expect(stderrCalls).toEqual([
				"\r1/500 files…",
				"\r3/500 files…",
				"\r500/500 files…\n",
			]);
			expect(stdoutCalls).toEqual([]);
		});

		test("is disabled for JSON output even on a TTY", () => {
			logger = new CLILogger({ stderrIsTTY: () => true });

			expect(logger.createFileScanProgress({ enabled: false })).toBeUndefined();
		});

		test("is disabled when stderr is not a TTY", () => {
			logger = new CLILogger({ stderrIsTTY: () => false });

			expect(logger.createFileScanProgress({ enabled: true })).toBeUndefined();
		});
	});

	describe("empty", () => {
		test("writes a bare newline to stdout", () => {
			logger.empty();
			expect(stdoutCalls).toEqual(["\n"]);
			expect(stderrCalls).toEqual([]);
		});
	});

	describe("structured", () => {
		test("emits operation line and trailing empty line", () => {
			logger.structured({ operation: "Moving module" });
			expect(stdoutCalls).toEqual(["⚡ Moving module...\n", "\n"]);
		});

		test("uses dry-run prefix when dryRun is true", () => {
			logger.structured({ operation: "Moving module", dryRun: true });
			expect(stdoutCalls[0]).toBe("🔍 Dry run: Moving module...\n");
		});

		test("uses custom symbol when provided", () => {
			logger.structured({ operation: "Renaming", symbol: "🚀" });
			expect(stdoutCalls[0]).toBe("🚀 Renaming...\n");
		});

		test("includes target line when target is set", () => {
			logger.structured({ operation: "op", target: "src/foo.ts" });
			expect(stdoutCalls).toContain("   Target: src/foo.ts\n");
		});

		test("omits target line when target is not set", () => {
			logger.structured({ operation: "op" });
			const hasTarget = stdoutCalls.some((c) => c.includes("Target:"));
			expect(hasTarget).toBe(false);
		});

		test("includes strategy line when strategy is set", () => {
			logger.structured({ operation: "op", strategy: "alias" });
			expect(stdoutCalls).toContain("   Strategy: alias\n");
		});

		test("includes verification line when verification is true", () => {
			logger.structured({ operation: "op", verification: true });
			expect(stdoutCalls).toContain("   Verification: enabled\n");
		});

		test("omits verification line when verification is false", () => {
			logger.structured({ operation: "op", verification: false });
			const hasVerification = stdoutCalls.some((c) =>
				c.includes("Verification:")
			);
			expect(hasVerification).toBe(false);
		});

		test("all optional fields together produce correct order", () => {
			logger.structured({
				operation: "Normalizing",
				target: "src/",
				strategy: "shortest",
				verification: true,
				symbol: "🔧",
			});
			expect(stdoutCalls).toEqual([
				"🔧 Normalizing...\n",
				"   Target: src/\n",
				"   Strategy: shortest\n",
				"   Verification: enabled\n",
				"\n",
			]);
		});
	});

	describe("complete", () => {
		test("success writes to stdout with empty trailing line", () => {
			logger.complete({ operation: "move", success: true, dryRun: false });
			expect(stdoutCalls).toEqual(["✅  move successfully!\n", "\n"]);
			expect(stderrCalls).toEqual([]);
		});

		test("failure writes to stderr with empty trailing line", () => {
			logger.complete({ operation: "move", success: false, dryRun: false });
			expect(stderrCalls).toEqual(["❌  move failed\n"]);
			expect(stdoutCalls).toEqual(["\n"]);
		});

		test("dry-run success prefixes verb", () => {
			logger.complete({ operation: "move", success: true, dryRun: true });
			expect(stdoutCalls[0]).toBe("✅ Would move successfully!\n");
		});

		test("dry-run failure prefixes verb", () => {
			logger.complete({ operation: "move", success: false, dryRun: true });
			expect(stderrCalls[0]).toBe("❌ Would move failed\n");
		});

		test("includes count/type line when both provided", () => {
			logger.complete({
				operation: "rename",
				success: true,
				dryRun: false,
				count: 5,
				type: "import",
			});
			expect(stdoutCalls).toContain("📝  update 5 import(s)\n");
		});

		test("omits count/type line when count is missing", () => {
			logger.complete({
				operation: "rename",
				success: true,
				dryRun: false,
				type: "import",
			});
			const hasCount = stdoutCalls.some((c) => c.includes("update"));
			expect(hasCount).toBe(false);
		});

		test("omits count/type line when type is missing", () => {
			logger.complete({
				operation: "rename",
				success: true,
				dryRun: false,
				count: 3,
			});
			const hasCount = stdoutCalls.some((c) => c.includes("update"));
			expect(hasCount).toBe(false);
		});
	});

	describe("fileChanges", () => {
		test("emits file header, each change, and trailing empty line", () => {
			logger.fileChanges("src/foo.ts", [
				{ line: 10, oldSpecifier: "../old", newSpecifier: "@/new" },
			]);
			expect(stdoutCalls).toEqual([
				"📄 src/foo.ts\n",
				"   Line 10:\n",
				"      - ../old\n",
				"      + @/new\n",
				"\n",
			]);
		});

		test("emits one block per change", () => {
			logger.fileChanges("src/bar.ts", [
				{ line: 1, oldSpecifier: "a", newSpecifier: "b" },
				{ line: 2, oldSpecifier: "c", newSpecifier: "d" },
			]);
			// header + 4 lines per change + trailing newline
			expect(stdoutCalls).toHaveLength(1 + 3 * 2 + 1);
		});

		test("emits only header and empty line for zero changes", () => {
			logger.fileChanges("src/baz.ts", []);
			expect(stdoutCalls).toEqual(["📄 src/baz.ts\n", "\n"]);
		});
	});
});
