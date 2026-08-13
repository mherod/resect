import { describe, expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";
import { createSourceFileFromText } from "../core/source-file.ts";
import { cleanup, makeFixture } from "./__test-helpers";
import {
	classifyFreeVariables,
	componentNamesFromNewFile,
	executeExtractComponent,
	generateComponentModule,
	type LocatedJsxNode,
	locateExtractComponentTarget,
	locateJsxNode,
	parseSelector,
	resolveJsxTsNode,
	toPascalCase,
} from "./extract-component.ts";

const SAMPLE = `export function App() {
	const title = "hi";
	return (
		<div className="root">
			<Card title={title}>
				<span>body</span>
			</Card>
			<Footer />
		</div>
	);
}
`;

function parse(text = SAMPLE) {
	return createSourceFileFromText("sample.tsx", text);
}

describe("parseSelector", () => {
	test("parses an L-prefixed line range", () => {
		expect(parseSelector("L12-40")).toEqual({
			type: "range",
			start: 12,
			end: 40,
		});
	});

	test("parses a bare line range", () => {
		expect(parseSelector("3-9")).toEqual({ type: "range", start: 3, end: 9 });
	});

	test("treats a tag name as a name selector", () => {
		expect(parseSelector("Card")).toEqual({ type: "name", name: "Card" });
	});

	test("rejects an empty selector", () => {
		expect(() => parseSelector("   ")).toThrow(/must not be empty/);
	});

	test("rejects an inverted line range", () => {
		expect(() => parseSelector("L40-12")).toThrow(/must not exceed end/);
	});
});

describe("locateJsxNode — name selector", () => {
	test("locates a named element with children", () => {
		const node = locateJsxNode(parse(), "Card");
		expect(node.kind).toBe("element");
		expect(node.tagName).toBe("Card");
		expect(node.startLine).toBe(5);
	});

	test("locates a self-closing element", () => {
		const node = locateJsxNode(parse(), "Footer");
		expect(node.kind).toBe("self-closing");
		expect(node.tagName).toBe("Footer");
	});

	test("throws when no element matches the name", () => {
		expect(() => locateJsxNode(parse(), "Nope")).toThrow(
			/No JSX element named/
		);
	});

	test("throws an ambiguous error when a name matches twice", () => {
		const text = `export const A = () => (
	<div>
		<Card a={1} />
		<Card a={2} />
	</div>
);
`;
		expect(() => locateJsxNode(parse(text), "Card")).toThrow(
			/ambiguous — 2 matches/
		);
	});
});

describe("locateJsxNode — line-range selector", () => {
	test("selects the outermost node fully contained in the range", () => {
		// Lines 4-9 wrap the whole <div> subtree.
		const node = locateJsxNode(parse(), "L4-9");
		expect(node.kind).toBe("element");
		expect(node.tagName).toBe("div");
		expect(node.startLine).toBe(4);
	});

	test("selects an inner node when the range only covers it", () => {
		// Line 6 is just <span>body</span>.
		const node = locateJsxNode(parse(), "6-6");
		expect(node.tagName).toBe("span");
	});

	test("locates a fragment subtree", () => {
		const text = `export const F = () => (
	<>
		<a href="/">home</a>
	</>
);
`;
		const node: LocatedJsxNode = locateJsxNode(parse(text), "2-4");
		expect(node.kind).toBe("fragment");
		expect(node.tagName).toBeNull();
	});

	test("throws when nothing is contained in the range", () => {
		expect(() => locateJsxNode(parse(), "1-1")).toThrow(
			/No JSX element fully contained/
		);
	});

	test("throws when the file has no JSX at all", () => {
		const node = parse("export const x = 1;\n");
		expect(() => locateJsxNode(node, "Card")).toThrow(/No JSX elements found/);
	});
});

describe("locateExtractComponentTarget", () => {
	test("reads a file from disk and reports the located node", async () => {
		const dir = await makeFixture(
			"extract-locate",
			{ "App.tsx": SAMPLE },
			{ outsideRepo: true }
		);
		try {
			const file = path.join(dir, "App.tsx");
			const report = locateExtractComponentTarget(file, "Card", "Card.tsx");
			expect(report.file).toBe(file);
			expect(report.newFile).toBe("Card.tsx");
			expect(report.located.tagName).toBe("Card");
		} finally {
			await cleanup(dir);
		}
	});

	test("rejects an empty destination", async () => {
		const dir = await makeFixture(
			"extract-locate-empty",
			{ "App.tsx": SAMPLE },
			{ outsideRepo: true }
		);
		try {
			const file = path.join(dir, "App.tsx");
			expect(() => locateExtractComponentTarget(file, "Card", "  ")).toThrow(
				/must not be empty/
			);
		} finally {
			await cleanup(dir);
		}
	});

	test("throws when the file cannot be parsed/read", () => {
		expect(() =>
			locateExtractComponentTarget("/no/such/file-xyz.tsx", "Card", "Card.tsx")
		).toThrow(/Could not parse file/);
	});
});

/**
 * Build an in-memory, type-bound program for a single `.tsx` source so the
 * checker-based classifier can be exercised without disk fixtures. The source
 * file is genuinely bound (parent pointers + a working checker), which is what
 * symbol-identity resolution requires.
 */
function buildProgram(text: string): {
	sourceFile: ts.SourceFile;
	checker: ts.TypeChecker;
} {
	const fileName = "sample.tsx";
	const options: ts.CompilerOptions = {
		jsx: ts.JsxEmit.ReactJSX,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		strict: true,
		noEmit: true,
		skipLibCheck: true,
	};
	const host = ts.createCompilerHost(options);
	const originalGetSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (name, langVersion, onError, shouldCreate) => {
		if (name === fileName) {
			return ts.createSourceFile(
				name,
				text,
				ts.ScriptTarget.ESNext,
				true,
				ts.ScriptKind.TSX
			);
		}
		return originalGetSourceFile(name, langVersion, onError, shouldCreate);
	};
	const originalReadFile = host.readFile.bind(host);
	host.readFile = (name) => (name === fileName ? text : originalReadFile(name));
	const originalFileExists = host.fileExists.bind(host);
	host.fileExists = (name) => name === fileName || originalFileExists(name);
	const program = ts.createProgram([fileName], options, host);
	const sourceFile = program.getSourceFile(fileName);
	if (!sourceFile) {
		throw new Error("Failed to build in-memory program");
	}
	return { sourceFile, checker: program.getTypeChecker() };
}

function classify(text: string, selector: string) {
	const { sourceFile, checker } = buildProgram(text);
	const node = resolveJsxTsNode(sourceFile, selector);
	return classifyFreeVariables(node, sourceFile, checker);
}

describe("classifyFreeVariables — prop candidates", () => {
	test("collects a free param referenced in the subtree with its type", () => {
		const text = `function Greeting({ name }: { name: string }) {
	return <h1>Hello {name}</h1>;
}
`;
		const report = classify(text, "h1");
		expect(report.propCandidates).toEqual([{ name: "name", type: "string" }]);
		expect(report.unliftableHooks).toEqual([]);
		expect(report.blocked).toBe(false);
	});

	test("captures a destructured object-prop's resolved type", () => {
		const text = `function Profile({ user }: { user: { name: string } }) {
	return <div>{user.name}</div>;
}
`;
		const report = classify(text, "div");
		expect(report.propCandidates).toHaveLength(1);
		const [prop] = report.propCandidates;
		expect(prop?.name).toBe("user");
		expect(prop?.type).toContain("name");
		expect(report.blocked).toBe(false);
	});

	test("a member name is not surfaced as a free variable", () => {
		const text = `function Profile({ user }: { user: { name: string } }) {
	return <div>{user.name}</div>;
}
`;
		const report = classify(text, "div");
		expect(report.propCandidates.map((p) => p.name)).not.toContain("name");
	});
});

describe("classifyFreeVariables — unliftable hooks", () => {
	test("flags hook-derived values as unliftable, not props", () => {
		const text = `declare function useState<T>(init: T): [T, (next: T) => void];
function Counter() {
	const [count, setCount] = useState(0);
	return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
`;
		const report = classify(text, "button");
		const hookNames = report.unliftableHooks.map((h) => h.name);
		expect(hookNames).toContain("count");
		expect(hookNames).toContain("setCount");
		for (const hook of report.unliftableHooks) {
			expect(hook.derivedFrom).toBe("useState");
		}
		expect(report.propCandidates.map((p) => p.name)).not.toContain("count");
		expect(report.blocked).toBe(true);
	});
});

describe("classifyFreeVariables — shadowing", () => {
	test("resolves to the inner binding, surfacing no false prop", () => {
		const text = `function List({ rows }: { rows: string[] }) {
	const label = "outer";
	return (
		<ul>
			{rows.map((label) => (
				<li>{label}</li>
			))}
		</ul>
	);
}
`;
		const report = classify(text, "ul");
		const propNames = report.propCandidates.map((p) => p.name);
		// `rows` is the genuine free variable; the inner `label` map param shadows
		// the outer `const label`, and is declared inside the subtree → bound.
		expect(propNames).toContain("rows");
		expect(propNames).not.toContain("label");
		expect(report.unliftableHooks).toEqual([]);
		expect(report.blocked).toBe(false);
	});
});

function generate(text: string, selector: string, newFile: string) {
	const { sourceFile, checker } = buildProgram(text);
	const jsxNode = resolveJsxTsNode(sourceFile, selector);
	const classification = classifyFreeVariables(jsxNode, sourceFile, checker);
	return generateComponentModule({
		jsxNode,
		sourceFile,
		checker,
		classification,
		newFile,
	});
}

describe("componentNamesFromNewFile", () => {
	test("derives PascalCase component + Props names from the basename", () => {
		expect(componentNamesFromNewFile("src/user-card.tsx")).toEqual({
			componentName: "UserCard",
			interfaceName: "UserCardProps",
		});
	});

	test("normalizes camelCase and dotted basenames", () => {
		expect(componentNamesFromNewFile("panel.view.tsx").componentName).toBe(
			"PanelView"
		);
		expect(componentNamesFromNewFile("fooBar.tsx").componentName).toBe(
			"FooBar"
		);
	});
});

describe("toPascalCase", () => {
	test("falls back to Component for a nameless basename", () => {
		expect(toPascalCase("---")).toBe("Component");
	});
});

describe("generateComponentModule — codegen", () => {
	test("emits a typed Props interface + component for a pure-prop subtree", () => {
		const text = `function Greeting({ name }: { name: string }) {
	return <h1>Hello {name}</h1>;
}
`;
		const result = generate(text, "h1", "src/Greeting.tsx");
		expect(result.componentName).toBe("Greeting");
		expect(result.interfaceName).toBe("GreetingProps");
		expect(result.moduleText).toContain("interface GreetingProps {");
		expect(result.moduleText).toContain("name: string;");
		expect(result.moduleText).toContain(
			"export function Greeting({ name }: GreetingProps) {"
		);
		expect(result.moduleText).toContain("<h1>Hello {name}</h1>");
		expect(result.moduleText.endsWith("\n")).toBe(true);
	});

	test("omits the interface and destructure for a zero-prop subtree", () => {
		const text = `function Logo() {
	return <span className="logo">resect</span>;
}
`;
		const result = generate(text, "span", "src/Logo.tsx");
		expect(result.props).toEqual([]);
		expect(result.moduleText).not.toContain("interface");
		expect(result.moduleText).toContain("export function Logo() {");
		expect(result.moduleText).toContain('<span className="logo">resect</span>');
	});

	test("preserves a fragment root and its nested children verbatim", () => {
		const text = `function Nav({ label }: { label: string }) {
	return (
		<>
			<a href="/">home</a>
			<span>{label}</span>
		</>
	);
}
`;
		const result = generate(text, "2-6", "src/Nav.tsx");
		expect(result.moduleText).toContain(
			"export function Nav({ label }: NavProps)"
		);
		expect(result.moduleText).toContain('<a href="/">home</a>');
		expect(result.moduleText).toContain("<span>{label}</span>");
		// Fragment delimiters preserved verbatim.
		expect(result.moduleText).toContain("<>");
		expect(result.moduleText).toContain("</>");
	});

	test("renders multi-prop interfaces with union and object types", () => {
		const text = `function Badge({ status, meta }: { status: "on" | "off"; meta: { id: number } }) {
	return <div data-status={status}>{meta.id}</div>;
}
`;
		const result = generate(text, "div", "src/Badge.tsx");
		const propNames = result.props.map((p) => p.name).sort();
		expect(propNames).toEqual(["meta", "status"]);
		expect(result.moduleText).toContain('status: "on" | "off";');
		expect(result.moduleText).toContain("meta:");
		expect(result.moduleText).toContain("id: number");
	});
});

// End-to-end mutation (#110): write + call-site rewrite + tsc verify/rollback.
// Fixtures live under the OS tmpdir (outside the repo) so the closing tsc gate
// resolves the repo's own `tsc` binary via process.cwd(); a minimal ambient JSX
// namespace keeps them type-checkable without a real React dependency.
const EC_TSCONFIG = JSON.stringify({
	compilerOptions: {
		jsx: "preserve",
		strict: false,
		noEmit: true,
		skipLibCheck: true,
		module: "esnext",
		moduleResolution: "bundler",
		target: "esnext",
	},
	include: ["**/*.ts", "**/*.tsx"],
});

const EC_JSX_SHIM = `declare namespace JSX {
	interface IntrinsicElements {
		[elemName: string]: unknown;
	}
	interface Element {}
}
`;

async function makeEcFixture(
	name: string,
	files: Record<string, string>
): Promise<string> {
	return makeFixture(
		`extract-exec-${name}`,
		{
			"tsconfig.json": EC_TSCONFIG,
			"globals.d.ts": EC_JSX_SHIM,
			...files,
		},
		{ outsideRepo: true }
	);
}

describe("executeExtractComponent — apply", () => {
	test("happy-path: writes the new module and rewrites the call site", async () => {
		const dir = await makeEcFixture("happy", {
			"Panel.tsx": `export function Panel() {
	const title = "hello";
	return (
		<section>
			<div className="body">
				<span>{title}</span>
			</div>
		</section>
	);
}
`,
		});
		try {
			const result = await executeExtractComponent({
				file: path.join(dir, "Panel.tsx"),
				selector: "div",
				newFile: path.join(dir, "PanelBody.tsx"),
			});

			expect(result.blocked).toBe(false);
			expect(result.conflict).toBeNull();
			expect(result.rolledBack).toBe(false);
			expect(result.success).toBe(true);
			expect(result.componentName).toBe("PanelBody");
			expect(result.callSite).toBe("<PanelBody title={title} />");
			expect(result.typecheck?.newErrors).toEqual([]);

			const created = await Bun.file(path.join(dir, "PanelBody.tsx")).text();
			expect(created).toContain(
				"export function PanelBody({ title }: PanelBodyProps)"
			);
			expect(created).toContain("interface PanelBodyProps");

			const rewritten = await Bun.file(path.join(dir, "Panel.tsx")).text();
			expect(rewritten).toContain('import { PanelBody } from "./PanelBody";');
			expect(rewritten).toContain("<PanelBody title={title} />");
			expect(rewritten).not.toContain('<div className="body">');
		} finally {
			await cleanup(dir);
		}
	});

	test("hook-block: refuses to write when the subtree references hook state", async () => {
		const dir = await makeEcFixture("hook", {
			"Counter.tsx": `function useState<T>(value: T): [T, (next: T) => void] {
	return [value, () => undefined];
}

export function Counter() {
	const [count, setCount] = useState(0);
	return (
		<div>
			<span>{count}</span>
		</div>
	);
}
`,
		});
		try {
			const result = await executeExtractComponent({
				file: path.join(dir, "Counter.tsx"),
				selector: "div",
				newFile: path.join(dir, "CounterBody.tsx"),
			});

			expect(result.blocked).toBe(true);
			expect(result.success).toBe(false);
			expect(result.modifiedFiles).toEqual([]);
			expect(result.unliftableHooks.map((hook) => hook.name)).toContain(
				"count"
			);

			expect(await Bun.file(path.join(dir, "CounterBody.tsx")).exists()).toBe(
				false
			);
			const original = await Bun.file(path.join(dir, "Counter.tsx")).text();
			expect(original).toContain("const [count, setCount] = useState(0);");
			expect(original).not.toContain("CounterBody");
		} finally {
			await cleanup(dir);
		}
	});

	test("rollback: restores originals when extraction introduces a type error", async () => {
		const dir = await makeEcFixture("rollback", {
			"Panel.tsx": `export function Panel() {
	interface Local {
		label: string;
	}
	const data: Local = { label: "x" };
	return (
		<div>
			<span>{data.label}</span>
		</div>
	);
}
`,
		});
		const panelPath = path.join(dir, "Panel.tsx");
		const before = await Bun.file(panelPath).text();
		try {
			const result = await executeExtractComponent({
				file: panelPath,
				selector: "div",
				newFile: path.join(dir, "PanelBody.tsx"),
			});

			// The lifted prop's type references a function-local interface that the
			// child module cannot see → a new tsc error → automatic rollback.
			expect(result.success).toBe(false);
			expect(result.rolledBack).toBe(true);
			expect(result.errors.length).toBeGreaterThan(0);

			expect(await Bun.file(path.join(dir, "PanelBody.tsx")).exists()).toBe(
				false
			);
			expect(await Bun.file(panelPath).text()).toBe(before);
		} finally {
			await cleanup(dir);
		}
	});

	test("keeps the extraction when a pre-existing error only shifts line", async () => {
		// Regression for #209: the inserted import shifts a pre-existing error
		// down one line; raw-string diffing misreported the shifted diagnostic as
		// new and rolled back a correct extraction (#128).
		const dir = await makeEcFixture("shifted-preexisting", {
			"Panel.tsx": `export const wrong: number = "shifted";
export function Panel() {
	const title = "hello";
	return (
		<section>
			<div className="body">
				<span>{title}</span>
			</div>
		</section>
	);
}
`,
		});
		try {
			const result = await executeExtractComponent({
				file: path.join(dir, "Panel.tsx"),
				selector: "div",
				newFile: path.join(dir, "PanelBody.tsx"),
			});

			expect(result.success).toBe(true);
			expect(result.rolledBack).toBe(false);
			expect(result.typecheck?.newErrors).toEqual([]);
			expect(await Bun.file(path.join(dir, "PanelBody.tsx")).exists()).toBe(
				true
			);
			const rewritten = await Bun.file(path.join(dir, "Panel.tsx")).text();
			expect(rewritten).toContain('const wrong: number = "shifted"');
			expect(rewritten).toContain("<PanelBody title={title} />");
		} finally {
			await cleanup(dir);
		}
	});
});
