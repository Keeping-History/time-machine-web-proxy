export interface CacheEntry {
	contentType: string;
	archiveUrl: string;
	archiveTime: string;
	body: string;
	isHtml: boolean;
	isCss: boolean;
}

export const isCacheEntry = (v: unknown): v is CacheEntry => {
	if (v === null || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.contentType === "string" &&
		typeof o.archiveUrl === "string" &&
		typeof o.archiveTime === "string" &&
		typeof o.body === "string" &&
		typeof o.isHtml === "boolean" &&
		typeof o.isCss === "boolean"
	);
};
