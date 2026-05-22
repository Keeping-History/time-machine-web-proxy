/** Shape returned by GET /status — operational health snapshot. */
export interface SystemStatus {
	redis: {
		/** ioredis connection state string. "ready" means commands are accepted;
		 * "connecting"/"reconnecting" means in-flight reconnect; "end"/"close"
		 * means the connection is gone (typically only seen during shutdown). */
		status: string;
	};
	outboundProxies: {
		/** false when OUTBOUND_PROXY_URLS is empty — all egress goes direct. */
		configured: boolean;
		agents: Array<{
			host: string;
			healthy: boolean;
			cooldownRemainingMs: number;
		}>;
	};
	queues: Record<string, JobCounts>;
}

export interface JobCounts {
	failed: number;
	waiting: number;
	active: number;
	completed: number;
	delayed: number;
}
