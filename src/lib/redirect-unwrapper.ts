// Well-known tracking/redirect URL patterns. Each regex captures the
// destination URL in group 1. Patterns are applied in order; first match wins.
const REDIRECT_PATTERNS: RegExp[] = [
	// Yahoo click-tracking: host is srd.yahoo.com or rd.yahoo.com, path
	// contains *{actual_url}. The greedy .* finds the last * in the path so
	// chained redirects (/*a/*http://...) still resolve correctly.
	/^https?:\/\/(?:srd|rd)\.yahoo\.com\/.*\*(https?:\/\/.+)$/i,
];

/**
 * If rawUrl matches a known tracking/redirect pattern, returns the embedded
 * destination URL. Otherwise returns rawUrl unchanged.
 */
export function unwrapRedirectUrl(rawUrl: string): string {
	for (const pattern of REDIRECT_PATTERNS) {
		const m = rawUrl.match(pattern);
		if (m?.[1]) return m[1];
	}
	return rawUrl;
}
