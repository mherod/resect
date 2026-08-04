import path from "node:path";
import type {
	ConsumerDependencyContract,
	DependencyContractChange,
	DependencyContractConflict,
	DependencyContractConflictRequirement,
	DependencyContractIssue,
	DependencyContractPolicy,
	DependencyContractReport,
	DependencyContractRequirement,
	DependencyRequirementKind,
	DependencyRequirementReason,
	DependencySection,
} from "../types/deps.ts";
import { DEPENDENCY_SECTIONS } from "../types/deps.ts";
import type { WorkspaceInfo, WorkspacePackage } from "./workspace.ts";

interface DependencyEntry {
	section: DependencySection;
	specifier: string;
}

interface NormalizedPolicyResult {
	policy?: DependencyContractPolicy;
	issues: DependencyContractIssue[];
}

interface PendingRequirement extends DependencyContractRequirement {
	requirementDetails: DependencyContractConflictRequirement[];
}

const dependencyEntry = (
	pkg: WorkspacePackage,
	dependencyName: string
): DependencyEntry | null => {
	for (const section of DEPENDENCY_SECTIONS) {
		const specifier = pkg[section]?.[dependencyName];
		if (specifier !== undefined) {
			return { section, specifier };
		}
	}
	return null;
};

const isDependencySection = (value: unknown): value is DependencySection =>
	typeof value === "string" &&
	(DEPENDENCY_SECTIONS as readonly string[]).includes(value);

function invalidPolicyIssue(
	pkg: WorkspacePackage,
	code: DependencyContractIssue["code"],
	message: string
): DependencyContractIssue {
	return {
		code,
		packageName: pkg.name,
		manifestPath: pkg.packageJsonPath,
		message,
	};
}

function normalizeContractEntry(
	pkg: WorkspacePackage,
	value: unknown,
	index: number
): { contract?: ConsumerDependencyContract; issue?: DependencyContractIssue } {
	if (typeof value === "string" && value.trim().length > 0) {
		return { contract: { name: value.trim() } };
	}
	if (!(value && typeof value === "object" && !Array.isArray(value))) {
		return {
			issue: invalidPolicyIssue(
				pkg,
				"invalid-policy-entry",
				`resect.consumerDependencies[${index}] must be a package name or contract object`
			),
		};
	}

	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.name !== "string" ||
		candidate.name.trim().length === 0
	) {
		return {
			issue: invalidPolicyIssue(
				pkg,
				"invalid-policy-entry",
				`resect.consumerDependencies[${index}].name must be a non-empty string`
			),
		};
	}
	if (
		candidate.section !== undefined &&
		!isDependencySection(candidate.section)
	) {
		return {
			issue: invalidPolicyIssue(
				pkg,
				"invalid-policy-entry",
				`resect.consumerDependencies[${index}].section is not a supported dependency section`
			),
		};
	}
	if (
		candidate.specifier !== undefined &&
		(typeof candidate.specifier !== "string" ||
			candidate.specifier.trim().length === 0)
	) {
		return {
			issue: invalidPolicyIssue(
				pkg,
				"invalid-policy-entry",
				`resect.consumerDependencies[${index}].specifier must be a non-empty string`
			),
		};
	}
	if (
		candidate.includeWorkspaceClosure !== undefined &&
		typeof candidate.includeWorkspaceClosure !== "boolean"
	) {
		return {
			issue: invalidPolicyIssue(
				pkg,
				"invalid-policy-entry",
				`resect.consumerDependencies[${index}].includeWorkspaceClosure must be boolean`
			),
		};
	}

	return {
		contract: {
			name: candidate.name.trim(),
			...(candidate.section === undefined
				? {}
				: { section: candidate.section }),
			...(candidate.specifier === undefined
				? {}
				: { specifier: candidate.specifier.trim() }),
			...(candidate.includeWorkspaceClosure === undefined
				? {}
				: {
						includeWorkspaceClosure: candidate.includeWorkspaceClosure,
					}),
		},
	};
}

function normalizePolicy(pkg: WorkspacePackage): NormalizedPolicyResult {
	const rawPolicy = pkg.resect?.consumerDependencies;
	if (rawPolicy === undefined) {
		return { issues: [] };
	}
	if (!Array.isArray(rawPolicy)) {
		return {
			issues: [
				invalidPolicyIssue(
					pkg,
					"invalid-policy",
					"resect.consumerDependencies must be an array"
				),
			],
		};
	}

	const consumerDependencies: ConsumerDependencyContract[] = [];
	const issues: DependencyContractIssue[] = [];
	for (const [index, entry] of rawPolicy.entries()) {
		const normalized = normalizeContractEntry(pkg, entry, index);
		if (normalized.contract) {
			consumerDependencies.push(normalized.contract);
		}
		if (normalized.issue) {
			issues.push(normalized.issue);
		}
	}

	return {
		policy: {
			packageName: pkg.name,
			manifestPath: pkg.packageJsonPath,
			consumerDependencies,
		},
		issues,
	};
}

type WorkspaceProtocol = "file" | "link" | "workspace";

function workspaceProtocol(specifier: string): WorkspaceProtocol | null {
	if (specifier.startsWith("file:")) {
		return "file";
	}
	if (specifier.startsWith("link:")) {
		return "link";
	}
	if (specifier.startsWith("workspace:")) {
		return "workspace";
	}
	return null;
}

function relativeWorkspaceSpecifier(
	protocol: "file" | "link",
	consumer: WorkspacePackage,
	dependency: WorkspacePackage
): string {
	const relativePath = path
		.relative(consumer.path, dependency.path)
		.split(path.sep)
		.join(path.posix.sep);
	const normalizedPath = relativePath.startsWith(".")
		? relativePath
		: `./${relativePath}`;
	return `${protocol}:${normalizedPath}`;
}

function consumerWorkspaceProtocol(
	consumer: WorkspacePackage,
	packagesByName: Map<string, WorkspacePackage>
): WorkspaceProtocol | null {
	const protocols = new Set<WorkspaceProtocol>();
	for (const section of DEPENDENCY_SECTIONS) {
		for (const [name, specifier] of Object.entries(consumer[section] ?? {})) {
			if (!packagesByName.has(name)) {
				continue;
			}
			const protocol = workspaceProtocol(specifier);
			if (protocol) {
				protocols.add(protocol);
			}
		}
	}
	return protocols.size === 1 ? ([...protocols][0] ?? null) : null;
}

function expectedWorkspaceSpecifier(
	consumer: WorkspacePackage,
	dependency: WorkspacePackage,
	sourceSpecifier: string,
	packagesByName: Map<string, WorkspacePackage>
): string {
	const current = dependencyEntry(consumer, dependency.name);
	const protocol = current
		? workspaceProtocol(current.specifier)
		: consumerWorkspaceProtocol(consumer, packagesByName);
	if (protocol === "file" || protocol === "link") {
		return relativeWorkspaceSpecifier(protocol, consumer, dependency);
	}
	if (protocol === "workspace") {
		if (current?.specifier.startsWith("workspace:")) {
			return current.specifier;
		}
		return sourceSpecifier.startsWith("workspace:")
			? sourceSpecifier
			: "workspace:*";
	}
	if (sourceSpecifier.startsWith("file:")) {
		return relativeWorkspaceSpecifier("file", consumer, dependency);
	}
	if (sourceSpecifier.startsWith("link:")) {
		return relativeWorkspaceSpecifier("link", consumer, dependency);
	}
	return sourceSpecifier.startsWith("workspace:")
		? sourceSpecifier
		: "workspace:*";
}

function sortReasons(
	reasons: DependencyRequirementReason[]
): DependencyRequirementReason[] {
	return [...reasons].sort((left, right) =>
		`${left.kind}:${left.chain.join("->")}`.localeCompare(
			`${right.kind}:${right.chain.join("->")}`
		)
	);
}

function requirementKey(
	requirement: DependencyContractConflictRequirement
): string {
	return `${requirement.requiredBy}:${requirement.section}:${requirement.specifier}:${requirement.reason.kind}:${requirement.reason.chain.join("->")}`;
}

function addRequirementDetail(
	details: DependencyContractConflictRequirement[],
	detail: DependencyContractConflictRequirement
): void {
	const key = requirementKey(detail);
	if (!details.some((candidate) => requirementKey(candidate) === key)) {
		details.push(detail);
	}
}

export function analyzeDependencyContracts(
	workspace: WorkspaceInfo
): DependencyContractReport {
	const issues: DependencyContractIssue[] = [];
	const packagesByName = new Map<string, WorkspacePackage>();
	for (const pkg of workspace.packages) {
		const existing = packagesByName.get(pkg.name);
		if (existing) {
			issues.push(
				invalidPolicyIssue(
					pkg,
					"duplicate-package-name",
					`Workspace package name ${pkg.name} is also declared by ${existing.packageJsonPath}`
				)
			);
			continue;
		}
		packagesByName.set(pkg.name, pkg);
	}

	const policiesByName = new Map<string, DependencyContractPolicy>();
	for (const pkg of workspace.packages) {
		if (packagesByName.get(pkg.name) !== pkg) {
			continue;
		}
		const normalized = normalizePolicy(pkg);
		issues.push(...normalized.issues);
		if (normalized.policy) {
			policiesByName.set(pkg.name, normalized.policy);
		}
	}

	const requirements: DependencyContractRequirement[] = [];
	const conflicts: DependencyContractConflict[] = [];
	const changes: DependencyContractChange[] = [];

	for (const consumer of workspace.packages) {
		const pending = new Map<string, PendingRequirement>();
		const expandedPolicies = new Set<string>();
		const expandedWorkspaceClosures = new Set<string>();
		const conflictDetails = new Map<
			string,
			DependencyContractConflictRequirement[]
		>();

		const addRequirement = (
			source: WorkspacePackage,
			contract: ConsumerDependencyContract,
			kind: DependencyRequirementKind,
			chain: string[]
		): void => {
			if (contract.name === consumer.name) {
				return;
			}
			const sourceEntry = dependencyEntry(source, contract.name);
			if (!(sourceEntry || contract.specifier)) {
				issues.push(
					invalidPolicyIssue(
						source,
						"missing-provider-dependency",
						`${source.name} requires consumers to declare ${contract.name} but does not declare it or provide a specifier`
					)
				);
				return;
			}

			const dependency = packagesByName.get(contract.name);
			const baseSpecifier = contract.specifier ?? sourceEntry?.specifier ?? "";
			const specifier =
				dependency && contract.specifier === undefined
					? expectedWorkspaceSpecifier(
							consumer,
							dependency,
							baseSpecifier,
							packagesByName
						)
					: baseSpecifier;
			const section =
				contract.section ?? sourceEntry?.section ?? "dependencies";
			const reason: DependencyRequirementReason = { kind, chain };
			const detail: DependencyContractConflictRequirement = {
				requiredBy: source.name,
				section,
				specifier,
				reason,
			};
			const existing = pending.get(contract.name);
			if (!existing) {
				pending.set(contract.name, {
					consumerName: consumer.name,
					manifestPath: consumer.packageJsonPath,
					dependencyName: contract.name,
					section,
					specifier,
					requiredBy: [source.name],
					reasons: [reason],
					requirementDetails: [detail],
				});
				return;
			}

			addRequirementDetail(existing.requirementDetails, detail);
			const existingConflict = conflictDetails.get(contract.name);
			if (existingConflict) {
				addRequirementDetail(existingConflict, detail);
			}
			if (existing.section !== section || existing.specifier !== specifier) {
				const details = conflictDetails.get(contract.name) ?? [
					...existing.requirementDetails,
				];
				addRequirementDetail(details, detail);
				conflictDetails.set(contract.name, details);
				return;
			}
			if (!existing.requiredBy.includes(source.name)) {
				existing.requiredBy.push(source.name);
			}
			if (
				!existing.reasons.some(
					(candidate) =>
						candidate.kind === reason.kind &&
						candidate.chain.join("\0") === reason.chain.join("\0")
				)
			) {
				existing.reasons.push(reason);
			}
		};

		const expandPolicy = (
			sourceName: string,
			chain: string[],
			rootProvider: string,
			stack: Set<string>
		): void => {
			const expansionKey = `${rootProvider}\0${sourceName}`;
			if (stack.has(sourceName) || expandedPolicies.has(expansionKey)) {
				return;
			}
			expandedPolicies.add(expansionKey);
			const source = packagesByName.get(sourceName);
			const policy = policiesByName.get(sourceName);
			if (!(source && policy)) {
				return;
			}
			const nextStack = new Set(stack).add(sourceName);
			for (const contract of policy.consumerDependencies) {
				const nextChain = [...chain, contract.name];
				addRequirement(source, contract, "contract", nextChain);
				const dependency = packagesByName.get(contract.name);
				if (!dependency) {
					if (contract.includeWorkspaceClosure) {
						issues.push(
							invalidPolicyIssue(
								source,
								"workspace-closure-target-not-workspace",
								`${contract.name} enables includeWorkspaceClosure but is not a workspace package`
							)
						);
					}
					continue;
				}
				expandPolicy(contract.name, nextChain, rootProvider, nextStack);
				if (contract.includeWorkspaceClosure) {
					expandWorkspaceClosure(
						contract.name,
						nextChain,
						rootProvider,
						new Set<string>()
					);
				}
			}
		};

		const expandWorkspaceClosure = (
			sourceName: string,
			chain: string[],
			rootProvider: string,
			stack: Set<string>
		): void => {
			const expansionKey = `${rootProvider}\0${sourceName}`;
			if (
				stack.has(sourceName) ||
				expandedWorkspaceClosures.has(expansionKey)
			) {
				return;
			}
			expandedWorkspaceClosures.add(expansionKey);
			const source = packagesByName.get(sourceName);
			if (!source) {
				return;
			}
			const nextStack = new Set(stack).add(sourceName);
			for (const dependencyName of Object.keys(source.dependencies ?? {})) {
				if (!packagesByName.has(dependencyName)) {
					continue;
				}
				const nextChain = [...chain, dependencyName];
				addRequirement(
					source,
					{ name: dependencyName, section: "dependencies" },
					"workspace-closure",
					nextChain
				);
				expandWorkspaceClosure(
					dependencyName,
					nextChain,
					rootProvider,
					nextStack
				);
				expandPolicy(
					dependencyName,
					nextChain,
					rootProvider,
					new Set<string>()
				);
			}
		};

		const directWorkspaceDependencies = new Set<string>();
		for (const section of DEPENDENCY_SECTIONS) {
			for (const dependencyName of Object.keys(consumer[section] ?? {})) {
				if (policiesByName.has(dependencyName)) {
					directWorkspaceDependencies.add(dependencyName);
				}
			}
		}
		for (const providerName of [...directWorkspaceDependencies].sort()) {
			expandPolicy(
				providerName,
				[providerName],
				providerName,
				new Set<string>()
			);
		}

		for (const [dependencyName, details] of conflictDetails) {
			conflicts.push({
				consumerName: consumer.name,
				manifestPath: consumer.packageJsonPath,
				dependencyName,
				requirements: [...details].sort((left, right) =>
					requirementKey(left).localeCompare(requirementKey(right))
				),
			});
		}

		for (const requirement of pending.values()) {
			const normalized: DependencyContractRequirement = {
				consumerName: requirement.consumerName,
				manifestPath: requirement.manifestPath,
				dependencyName: requirement.dependencyName,
				section: requirement.section,
				specifier: requirement.specifier,
				requiredBy: [...requirement.requiredBy].sort(),
				reasons: sortReasons(requirement.reasons),
			};
			requirements.push(normalized);
			if (conflictDetails.has(requirement.dependencyName)) {
				continue;
			}
			const current = dependencyEntry(consumer, requirement.dependencyName);
			if (
				current?.section === requirement.section &&
				current.specifier === requirement.specifier
			) {
				continue;
			}
			let changeType: DependencyContractChange["type"] = "move";
			if (current === null) {
				changeType = "add";
			} else if (current.section === requirement.section) {
				changeType = "align";
			}
			changes.push({
				...normalized,
				type: changeType,
				fromSection: current?.section ?? null,
				fromSpecifier: current?.specifier ?? null,
			});
		}
	}

	const policies = [...policiesByName.values()].sort((left, right) =>
		left.packageName.localeCompare(right.packageName)
	);
	requirements.sort((left, right) =>
		`${left.manifestPath}:${left.dependencyName}`.localeCompare(
			`${right.manifestPath}:${right.dependencyName}`
		)
	);
	changes.sort((left, right) =>
		`${left.manifestPath}:${left.dependencyName}`.localeCompare(
			`${right.manifestPath}:${right.dependencyName}`
		)
	);
	conflicts.sort((left, right) =>
		`${left.manifestPath}:${left.dependencyName}`.localeCompare(
			`${right.manifestPath}:${right.dependencyName}`
		)
	);
	const uniqueIssues = [
		...new Map(
			issues.map((issue) => [
				`${issue.code}:${issue.manifestPath}:${issue.message}`,
				issue,
			])
		).values(),
	].sort((left, right) =>
		`${left.manifestPath}:${left.code}:${left.message}`.localeCompare(
			`${right.manifestPath}:${right.code}:${right.message}`
		)
	);

	return {
		schemaVersion: "1",
		workspaceRoot: workspace.root,
		workspaceType: workspace.type,
		policies,
		requirements,
		changes,
		conflicts,
		issues: uniqueIssues,
		taskChanges: [],
		summary: {
			packages: workspace.packages.length,
			policies: policies.length,
			requirements: requirements.length,
			changes: changes.length,
			conflicts: conflicts.length,
			issues: uniqueIssues.length,
			taskChanges: 0,
		},
	};
}
