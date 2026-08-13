import path from "node:path";

export const REGISTRATION_MODULES = [
	"register-analysis.ts",
	"register-hygiene.ts",
	"register-mutation.ts",
] as const;

export async function readRegistrationSource(): Promise<string> {
	const sources = await Promise.all(
		REGISTRATION_MODULES.map(async (module) =>
			Bun.file(path.resolve(import.meta.dir, module)).text()
		)
	);
	return sources.join("\n");
}
