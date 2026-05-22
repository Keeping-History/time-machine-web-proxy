import type { JobProgress } from "./job-progress";

export interface WsRequest {
	type: "fetch";
	id?: string;
	url: string;
	time?: string;
}

export const isWsRequest = (v: unknown): v is WsRequest => {
	if (v === null || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return o.type === "fetch" && typeof o.url === "string";
};

export interface WsResponse {
	type: "result" | "error" | "progress";
	id?: string;
	html?: string;
	contentType?: string;
	archiveUrl?: string;
	originalUrl?: string;
	archiveTime?: string;
	cache?: "HIT" | "MISS";
	status?: number;
	message?: string;
	progress?: JobProgress;
}
