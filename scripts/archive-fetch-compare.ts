import {
	type FetchResult,
	TEST_URLS,
	buildDirectAgent,
	buildProxyAgent,
	fetchOne,
	printResult,
} from "./archive-fetch-lib.js";

const DEFAULT_PROXY_URL = "http://us-ca.proxymesh.com:31280";

function summarize(direct: FetchResult, proxied: FetchResult): string {
	if (direct.error && proxied.error) {
		return "BOTH FAILED";
	}
	if (direct.error) return "DIRECT FAILED, PROXY OK";
	if (proxied.error) return "DIRECT OK, PROXY FAILED";
	if (direct.status !== proxied.status) {
		return `STATUS DIFFERS (direct=${direct.status} vs proxy=${proxied.status})`;
	}
	if (direct.bodySha256 === proxied.bodySha256) {
		return "MATCH (identical body)";
	}
	const sizeDelta = proxied.bodyBytes - direct.bodyBytes;
	return `BODIES DIFFER (Δ${sizeDelta >= 0 ? "+" : ""}${sizeDelta} bytes)`;
}

async function main(): Promise<void> {
	const proxyUrl =
		process.env.OUTBOUND_PROXY_URL ??
		process.env.OUTBOUND_PROXY_URLS?.split(",")[0]?.trim() ??
		DEFAULT_PROXY_URL;

	const directAgent = buildDirectAgent();
	const proxyAgent = buildProxyAgent(proxyUrl);

	console.log(`Comparing DIRECT vs ${proxyUrl}\n`);

	const rows: Array<{ url: string; verdict: string; direct: FetchResult; proxied: FetchResult }> = [];

	try {
		for (const url of TEST_URLS) {
			const [direct, proxied] = await Promise.all([
				fetchOne("direct", url, directAgent),
				fetchOne("proxymesh", url, proxyAgent),
			]);
			printResult(direct);
			printResult(proxied);
			rows.push({ url, verdict: summarize(direct, proxied), direct, proxied });
		}
	} finally {
		await Promise.all([directAgent.close(), proxyAgent.close()]);
	}

	console.log("\n=== SUMMARY ===");
	for (const { url, verdict, direct, proxied } of rows) {
		console.log(
			`${verdict.padEnd(40)} | direct=${String(direct.status ?? direct.error).padEnd(20)} (${direct.durationMs}ms, ${direct.bodyBytes}B) | proxy=${String(proxied.status ?? proxied.error).padEnd(20)} (${proxied.durationMs}ms, ${proxied.bodyBytes}B) | ${url}`,
		);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
