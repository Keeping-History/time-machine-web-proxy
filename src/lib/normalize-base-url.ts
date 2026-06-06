/**
 * Normalize an arbitrary user-supplied base URL into the canonical form and
 * the set of host/protocol variants the snapshot resolver queries against
 * CDX. `variants` is the cartesian product of {http, https} × {bareHost,
 * www.bareHost}, plus the original host if it differed from bareHost. The
 * resolver hits one CDX query per variant and aggregates the results.
 */
import { domainToUnicode } from "node:url";

export interface NormalizedBaseUrl {
	canonicalUrl: string;
	variants: string[];
	bareHost: string;
	unicodeHost: string;
}

export function normalizeBaseUrlInput(input: string): NormalizedBaseUrl {
	if (!input || typeof input !== "string") {
		throw new Error("Base URL must be a non-empty string");
	}

	let raw = input.trim();
	if (!raw) {
		throw new Error("Base URL must not be empty");
	}

	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
		raw = `https://${raw}`;
	}

	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch (e) {
		throw new Error(`Invalid URL: ${e instanceof Error ? e.message : String(e)}`);
	}

	if (!/^https?:$/i.test(parsed.protocol)) {
		throw new Error("Only http and https protocols are supported");
	}

	const asciiHost = parsed.hostname.toLowerCase();
	if (!asciiHost) {
		throw new Error("URL must contain a hostname");
	}

	const bareHost = asciiHost.replace(/^www\./, "");
	const unicodeHost = domainToUnicode(bareHost);
	const port = parsed.port ? `:${parsed.port}` : "";
	const basePath =
		parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/, "") : "";

	const canonicalUrl = `https://${bareHost}${port}${basePath}`;

	const hostSet = new Set<string>([`${bareHost}${port}`]);
	if (asciiHost !== bareHost) {
		hostSet.add(`${asciiHost}${port}`);
	} else if (bareHost?.includes(".")) {
		hostSet.add(`www.${bareHost}${port}`);
	}

	const protocols = ["https:", "http:"];
	const variants = new Set<string>();
	for (const protocol of protocols) {
		for (const host of hostSet) {
			variants.add(`${protocol}//${host}${basePath}`);
		}
	}

	return {
		canonicalUrl,
		variants: Array.from(variants),
		bareHost,
		unicodeHost,
	};
}
