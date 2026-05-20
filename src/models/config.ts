export interface Config {
	port: number;
	hostname: string;
	defaultTime: string;
	archivePrefix: string;
	cacheDir: string;
	cacheEnabled: boolean;
	allowedOrigins: string[];
	archiveRatePerSec: number;
	archiveBurst: number;
	archiveMaxRetries: number;
	archiveMaxConcurrent: number;
	whitelistHosts: string;
	proxyPrefix: string;
	proxyBase: string;
	proxyBaseHostname: string;
	cacheClearToken: string;
	wsKeepaliveMs: number;
}
