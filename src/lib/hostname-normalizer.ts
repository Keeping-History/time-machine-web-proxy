export const CDN_SUFFIXES = [
	".edgesuite.net",
	".edgekey.net",
	".akamaiedge.net",
	".akamaihd.net",
	".akamai.net",
];

export function parseDomainRemap(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	const result: Record<string, string> = {};
	for (const pair of raw.split(",")) {
		const trimmed = pair.trim();
		const eq = trimmed.indexOf("=");
		if (eq < 1) continue;
		const from = trimmed.slice(0, eq).trim();
		const to = trimmed.slice(eq + 1).trim();
		if (from && to) result[from] = to;
	}
	return result;
}

/**
 * Rewrites the hostname of a target URL using two mechanisms, in priority order:
 *   1. Explicit domain remap (config-driven, exact match)
 *   2. CDN suffix stripping (e.g. www.example.com.edgesuite.net → www.example.com)
 *
 * Returns the original string unchanged if the URL is unparseable or no rule matches.
 */
export function normalizeHostname(rawUrl: string, domainRemap: Record<string, string>): string {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return rawUrl;
	}

	const { hostname } = parsed;

	const remapped = domainRemap[hostname];
	if (remapped) {
		parsed.hostname = remapped;
		return parsed.toString();
	}

	for (const suffix of CDN_SUFFIXES) {
		if (hostname.endsWith(suffix)) {
			const stripped = hostname.slice(0, -suffix.length);
			if (stripped) {
				parsed.hostname = stripped;
				return parsed.toString();
			}
		}
	}

	return rawUrl;
}
