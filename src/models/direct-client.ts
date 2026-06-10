import type { RequestedResult, ResolvedResult } from "../clients/wayback-direct-client";

/** Canonical port for the direct-fetch client used by workers and the dependency graph. */
export interface DirectClientPort {
	fetchAtResolvedTime(url: string, ts: string): Promise<ResolvedResult>;
	fetchAtRequestedTime(url: string, ts: string): Promise<RequestedResult>;
}
