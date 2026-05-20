import IORedis from "ioredis";

export function createRedis(url: string): IORedis {
	return new IORedis(url, {
		maxRetriesPerRequest: null,
		enableReadyCheck: false,
	});
}
