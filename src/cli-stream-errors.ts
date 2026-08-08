function hasErrorCode(error: unknown): error is { code: unknown } {
	return typeof error === "object" && error !== null && "code" in error;
}

export function isBrokenPipeError(error: unknown): boolean {
	return hasErrorCode(error) && error.code === "EPIPE";
}

export function handleCliStdoutError(error: Error): void {
	if (isBrokenPipeError(error)) {
		process.exit(0);
	}

	throw error;
}

export function installCliStdoutErrorHandler(): void {
	process.stdout.on("error", handleCliStdoutError);
}
