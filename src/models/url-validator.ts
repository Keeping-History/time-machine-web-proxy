/** Port for URL validation used by the time-machine service and the dependency graph. */
export interface UrlValidatorModule {
	validateTargetUrl: (url: string) => string;
	isHostWhitelisted: (url: string, whitelistHosts: string[]) => boolean;
}
