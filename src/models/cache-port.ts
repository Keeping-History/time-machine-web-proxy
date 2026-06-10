/** Minimal cache operations required by the archive workers. */
export interface CachePort {
	cacheDirForJob(time: string, host: string): string;
	writeFile(url: string, time: string, data: Buffer): Promise<void>;
	writeContentTypeSidecar(url: string, time: string, contentType: string): Promise<void>;
	writeNotFoundSentinel(time: string, url: string): Promise<void>;
	writeTentativeNotFoundSentinel(time: string, url: string): Promise<void>;
	writeResolvedTimeSidecar(time: string, url: string, resolvedTime: string): Promise<void>;
	lookup(url: string, time: string): Promise<{ absPath: string; contentType: string; archiveTime?: string } | null>;
}
