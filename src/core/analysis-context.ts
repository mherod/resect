import { AsyncLocalStorage } from "node:async_hooks";
import { isMainThread } from "node:worker_threads";

const workerContext = new AsyncLocalStorage<boolean>();

export function isAnalysisProcessHost(): boolean {
	return process.env.RESECT_ANALYSIS_PROCESS === "1" && !!process.send;
}

export function isAnalysisWorkerContext(): boolean {
	return !isMainThread || workerContext.getStore() === true;
}

export function withAnalysisWorkerContext<T>(work: () => T): T {
	return workerContext.run(true, work);
}
