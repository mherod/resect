import { makeProject } from "./__test-helpers.ts";

type ModuleStyle = "commonjs" | "esm";
type MutationOperation = "move" | "rename";

interface MutationProjectOptions {
	moduleStyle?: ModuleStyle;
	operation: MutationOperation;
}

export interface MutationCliProject {
	apiPath: string;
	consumerPath: string;
	sourcePath: string;
	targetPath: string;
	tsconfigPath: string;
}

function mutationSourceName(isCommonJs: boolean, isMove: boolean): string {
	if (!isMove) {
		return "api.ts";
	}
	return isCommonJs ? "thing.ts" : "source.ts";
}

function sourceFileContent(isCommonJs: boolean, isMove: boolean): string {
	if (isCommonJs) {
		return "function Thing() { return 1; }\nexport = Thing;\n";
	}
	return isMove ? "export const value = 1;\n" : "export const foo = 1;\n";
}

function consumerFileContent(
	isCommonJs: boolean,
	isMove: boolean,
	sourceName: string
): string {
	if (isCommonJs) {
		return `import Thing = require("./${sourceName.replace(/\.ts$/, "")}");\nexport const value = Thing();\n`;
	}
	if (isMove) {
		return 'import { value } from "./source";\nexport const result = value;\n';
	}
	return 'import * as api from "./api";\nexport const value: 1 = api.foo;\n';
}

export async function makeMutationCliProject(
	options: MutationProjectOptions
): Promise<MutationCliProject> {
	const isCommonJs = options.moduleStyle === "commonjs";
	const isMove = options.operation === "move";
	const sourceName = mutationSourceName(isCommonJs, isMove);
	const sourceContent = sourceFileContent(isCommonJs, isMove);
	const consumerContent = consumerFileContent(isCommonJs, isMove, sourceName);
	const fixture = await makeProject({
		name: `${options.operation}-${options.moduleStyle ?? "esm"}`,
		files: {
			"src/consumer.ts": consumerContent,
			...(isMove && !isCommonJs
				? { "src/preexisting.ts": "export const existing: string = 1;\n" }
				: {}),
			[`src/${sourceName}`]: sourceContent,
		},
		outsideRepo: true,
		tsconfig: {
			compilerOptions: {
				module: isCommonJs ? "CommonJS" : "ESNext",
				moduleResolution: isCommonJs ? "Node" : "Bundler",
				noEmit: true,
				strict: true,
				target: "ESNext",
				types: [],
			},
			include: ["src/**/*.ts"],
		},
	});
	const sourcePath = fixture.path(`src/${sourceName}`);
	return {
		apiPath: sourcePath,
		consumerPath: fixture.path("src/consumer.ts"),
		sourcePath,
		targetPath: fixture.path(`src/nested/${sourceName}`),
		tsconfigPath: fixture.path("tsconfig.json"),
	};
}
