export interface ProxyResult {
	contentType: string;
	archiveUrl: string;
	originalUrl: string;
	archiveTime: string;
	/** Defined for text/html and text/css (loaded for transforms). Undefined when bodyPath is set. */
	body?: string | Buffer;
	/** Defined for binary content types; body is undefined. Caller streams via createReadStream. */
	bodyPath?: string;
	cache: "HIT" | "MISS_DIRECT" | "MISS_WORKER";
	/** Set when the page is a meta-refresh redirect stub; the ORIGINAL destination
	 * URL + timestamp. The handler re-validates and follows it. body/bodyPath still
	 * hold the fully-rewritten stub as a fallback. */
	redirect?: { url: string; time: string };
}
