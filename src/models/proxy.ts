export interface ProxyResult {
	contentType: string;
	archiveUrl: string;
	originalUrl: string;
	archiveTime: string;
	body: string | Buffer;
	cache: "HIT" | "MISS";
}
