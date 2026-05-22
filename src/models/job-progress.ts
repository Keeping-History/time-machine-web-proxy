import { QUEUE_CRAWL, QUEUE_EXACT } from "../queue/jobs";

export type JobProgressStage =
	| "picked_up"
	| "availability_start"
	| "resolved"
	| "no_snapshot"
	| "download_start"
	| "download_file"
	| "download_done"
	| "error";

export type JobProgressQueue = typeof QUEUE_EXACT | typeof QUEUE_CRAWL;

export interface JobProgress {
	stage: JobProgressStage;
	jobId: string;
	queue: JobProgressQueue;
	ts: number;
	url?: string;
	host?: string;
	time?: string;
	resolved?: string;
	file?: string;
	filesSeen?: number;
	error?: string;
}

export const isJobProgress = (v: unknown): v is JobProgress => {
	if (v === null || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.stage === "string" &&
		typeof o.jobId === "string" &&
		typeof o.queue === "string" &&
		typeof o.ts === "number"
	);
};
