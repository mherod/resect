import path from "node:path";
import { getRuntime } from "../runtime/index.ts";
import type {
	DependencyContractIssue,
	DependencyContractRequirement,
	TurboDependencyChange,
} from "../types/deps.ts";
import { createStructuredEdit, type StructuredEdit } from "./text-changes.ts";
import type { WorkspaceInfo, WorkspacePackage } from "./workspace.ts";

interface TurboTask {
	dependsOn?: string[];
	[key: string]: unknown;
}

interface TurboJson {
	tasks?: Record<string, TurboTask>;
	[key: string]: unknown;
}

interface TurboConfig {
	absolutePath: string;
	json: TurboJson;
	packageName: string;
}

export interface TurboDependencyAnalysis {
	changes: TurboDependencyChange[];
	issues: DependencyContractIssue[];
}

function assertTurboConfigShape(value: unknown): asserts value is TurboJson {
	if (!(value && typeof value === "object" && !Array.isArray(value))) {
		throw new Error("expected a JSON object");
	}
	const tasks = (value as Record<string, unknown>).tasks;
	if (tasks === undefined) {
		return;
	}
	if (!(tasks && typeof tasks === "object" && !Array.isArray(tasks))) {
		throw new Error("tasks must be an object");
	}
	for (const [taskName, task] of Object.entries(tasks)) {
		if (!(task && typeof task === "object" && !Array.isArray(task))) {
			throw new Error(`tasks.${taskName} must be an object`);
		}
		const dependsOn = (task as Record<string, unknown>).dependsOn;
		if (
			dependsOn !== undefined &&
			(!Array.isArray(dependsOn) ||
				dependsOn.some((dependency) => typeof dependency !== "string"))
		) {
			throw new Error(
				`tasks.${taskName}.dependsOn must be an array of strings`
			);
		}
	}
}

async function readTurboConfig(
	absolutePath: string,
	packageName: string
): Promise<{ config?: TurboConfig; issue?: DependencyContractIssue }> {
	const runtime = getRuntime();
	if (!(await runtime.fs.exists(absolutePath))) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(await runtime.fs.readFile(absolutePath));
		assertTurboConfigShape(parsed);
		return { config: { absolutePath, json: parsed, packageName } };
	} catch (error) {
		return {
			issue: {
				code: "invalid-turbo-config",
				packageName,
				manifestPath: absolutePath,
				message: `Could not parse ${absolutePath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			},
		};
	}
}

function buildableWorkspaceRequirements(
	requirements: DependencyContractRequirement[],
	packagesByName: Map<string, WorkspacePackage>
): DependencyContractRequirement[] {
	return requirements.filter((requirement) => {
		const dependency = packagesByName.get(requirement.dependencyName);
		return dependency?.scripts?.build !== undefined;
	});
}

function changesForTask(
	consumer: WorkspacePackage,
	requirements: DependencyContractRequirement[],
	config: TurboConfig,
	taskName: string
): TurboDependencyChange[] {
	const task = config.json.tasks?.[taskName];
	if (!task) {
		return [];
	}
	const declared = new Set(task.dependsOn ?? []);
	if (declared.has("^build")) {
		return [];
	}
	const changes: TurboDependencyChange[] = [];
	for (const requirement of requirements) {
		const turboDependency = `${requirement.dependencyName}#build`;
		if (declared.has(turboDependency)) {
			continue;
		}
		changes.push({
			consumerName: consumer.name,
			dependencyName: requirement.dependencyName,
			taskName,
			turboDependency,
			turboPath: config.absolutePath,
		});
	}
	return changes;
}

export async function analyzeTurboDependencyContracts(
	workspace: WorkspaceInfo,
	requirements: DependencyContractRequirement[]
): Promise<TurboDependencyAnalysis> {
	const issues: DependencyContractIssue[] = [];
	const changes: TurboDependencyChange[] = [];
	const packagesByName = new Map(
		workspace.packages.map((pkg) => [pkg.name, pkg])
	);
	const groupedRequirements = new Map<
		string,
		DependencyContractRequirement[]
	>();
	for (const requirement of requirements) {
		const consumerRequirements = groupedRequirements.get(
			requirement.consumerName
		);
		if (consumerRequirements) {
			consumerRequirements.push(requirement);
		} else {
			groupedRequirements.set(requirement.consumerName, [requirement]);
		}
	}
	const rootResult = await readTurboConfig(
		path.join(workspace.root, "turbo.json"),
		"//"
	);
	if (rootResult.issue) {
		issues.push(rootResult.issue);
	}

	for (const consumer of workspace.packages) {
		const buildRequirements = buildableWorkspaceRequirements(
			groupedRequirements.get(consumer.name) ?? [],
			packagesByName
		);
		if (buildRequirements.length === 0) {
			continue;
		}
		if (rootResult.config) {
			changes.push(
				...changesForTask(
					consumer,
					buildRequirements,
					rootResult.config,
					`${consumer.name}#build`
				)
			);
		}

		const localResult = await readTurboConfig(
			path.join(consumer.path, "turbo.json"),
			consumer.name
		);
		if (localResult.issue) {
			issues.push(localResult.issue);
		}
		if (localResult.config) {
			changes.push(
				...changesForTask(
					consumer,
					buildRequirements,
					localResult.config,
					"build"
				)
			);
		}
	}

	changes.sort((left, right) =>
		`${left.turboPath}:${left.taskName}:${left.turboDependency}`.localeCompare(
			`${right.turboPath}:${right.taskName}:${right.turboDependency}`
		)
	);
	issues.sort((left, right) =>
		`${left.manifestPath}:${left.message}`.localeCompare(
			`${right.manifestPath}:${right.message}`
		)
	);
	return { changes, issues };
}

function sortTaskDependencies(dependencies: string[]): string[] {
	return [...new Set(dependencies)].sort((left, right) =>
		left.localeCompare(right)
	);
}

export async function planTurboDependencyEdits(
	changes: TurboDependencyChange[]
): Promise<StructuredEdit[]> {
	const changesByPath = new Map<string, TurboDependencyChange[]>();
	for (const change of changes) {
		const current = changesByPath.get(change.turboPath) ?? [];
		current.push(change);
		changesByPath.set(change.turboPath, current);
	}

	const edits: StructuredEdit[] = [];
	for (const [turboPath, configChanges] of changesByPath) {
		const before = await getRuntime().fs.readFile(turboPath);
		const json = JSON.parse(before) as TurboJson;
		for (const change of configChanges) {
			const task = json.tasks?.[change.taskName];
			if (!task) {
				throw new Error(
					`Could not find Turbo task ${change.taskName} in ${turboPath}`
				);
			}
			task.dependsOn = sortTaskDependencies([
				...(task.dependsOn ?? []),
				change.turboDependency,
			]);
		}
		const edit = createStructuredEdit(
			turboPath,
			before,
			`${JSON.stringify(json, null, 2)}\n`
		);
		if (edit) {
			edits.push(edit);
		}
	}
	return edits.sort((left, right) => left.file.localeCompare(right.file));
}
