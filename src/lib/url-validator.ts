const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const PRIVATE_HOST_RE =
	/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?|\[?::ffff:|\[?fe[89ab][0-9a-f]|\[?f[cd][0-9a-f]{2})/i;

export const parseWhitelist = (raw: string): string[] => {
	if (raw.trim() === "*") return ["*"];
	return raw
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean);
};

export const isHostWhitelisted = (targetUrl: string, whitelistHosts: string[]): boolean => {
	if (whitelistHosts.includes("*")) return true;
	if (whitelistHosts.length === 0) return false;
	try {
		const { hostname: targetHost } = new URL(targetUrl);
		return whitelistHosts.some((pattern) => {
			if (pattern.startsWith("*.")) {
				const suffix = pattern.slice(1);
				return targetHost.endsWith(suffix) || targetHost === pattern.slice(2);
			}
			return targetHost === pattern;
		});
	} catch {
		return false;
	}
};

export const validateTargetUrl = (raw: string): string => {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("Invalid URL");
	}
	if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
		throw new Error("Disallowed protocol");
	}
	if (PRIVATE_HOST_RE.test(parsed.hostname)) {
		throw new Error("Private/internal hosts disallowed");
	}
	return raw;
};
