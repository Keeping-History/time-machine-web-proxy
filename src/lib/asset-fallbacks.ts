import { extractCdnEmbeddedUrl } from "./redirect-unwrapper";

/**
 * A single fallback rule. Given the original asset URL that failed to resolve
 * in the archive, `transform` returns an alternative URL to try, or `null` when
 * the rule does not apply to this URL.
 *
 * Rules are tried in array order *after* a direct/worker fetch misses (404).
 * The first rule that yields a distinct URL whose fetch succeeds wins, so order
 * the most specific rules first.
 */
export interface UrlFallbackRule {
	readonly name: string;
	readonly transform: (url: string) => string | null;
}

/**
 * Convenience builder for the common "rewrite this URL shape to that one" rule.
 * `pattern` is matched against the whole URL; on a match the `String.replace`
 * result is returned (so `$1` backreferences work), otherwise `null`.
 *
 * Example — serve a defunct image CDN from the origin instead:
 *   replaceRule("imgcdn", /^https?:\/\/images\.example\.net\//, "http://www.example.com/")
 */
export function replaceRule(name: string, pattern: RegExp, replacement: string): UrlFallbackRule {
	return {
		name,
		transform: (url) => (pattern.test(url) ? url.replace(pattern, replacement) : null),
	};
}

/**
 * Ordered fallback rules tried when an asset (image/CSS/script/…) is not found
 * in the archive under its requested URL. Add new CDN/redirect quirks here;
 * keep the most specific rules first.
 */
export const ASSET_URL_FALLBACKS: readonly UrlFallbackRule[] = [
	// Akamai & friends embed the origin host in the CDN *path*:
	//   a772.g.akamai.net/7/772/<hash>/www.apple.com/foo.gif → www.apple.com/foo.gif
	{ name: "cdn-embedded-origin", transform: extractCdnEmbeddedUrl },

	// --- Add static / pattern replacements below, e.g.: ---
	// replaceRule("akamai-images", /^https?:\/\/images\.apple\.com\//, "http://www.apple.com/images/"),
];

/**
 * Yields each distinct candidate URL produced by the fallback rules, in order.
 * Rules that don't apply (return null) are skipped, and candidates are
 * de-duplicated against the original URL and earlier candidates so two rules
 * that converge on the same URL don't trigger a redundant fetch. A rule that
 * throws is treated as "not applicable" — a malformed rule must never break the
 * foreground request.
 */
export function* candidateFallbackUrls(
	originalUrl: string,
	rules: readonly UrlFallbackRule[] = ASSET_URL_FALLBACKS,
): Generator<{ rule: string; url: string }> {
	const seen = new Set<string>([originalUrl]);
	for (const rule of rules) {
		let candidate: string | null;
		try {
			candidate = rule.transform(originalUrl);
		} catch {
			candidate = null;
		}
		if (candidate && !seen.has(candidate)) {
			seen.add(candidate);
			yield { rule: rule.name, url: candidate };
		}
	}
}
