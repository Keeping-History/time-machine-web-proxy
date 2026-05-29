import { buildProxyAgent, fetchOne, printResult, TEST_URLS } from "./archive-fetch-lib.js";

const DEFAULT_PROXY_URL = "http://us-ca.proxymesh.com:31280";

async function main(): Promise<void> {
	const proxyUrl =
		process.env.OUTBOUND_PROXY_URL ??
		process.env.OUTBOUND_PROXY_URLS?.split(",")[0]?.trim() ??
		DEFAULT_PROXY_URL;

	console.log(`=== VIA PROXYMESH (${proxyUrl}) ===`);
	const agent = buildProxyAgent(proxyUrl);
	try {
		for (const url of TEST_URLS) {
			const result = await fetchOne("proxymesh", url, agent);
			printResult(result);
		}
	} finally {
		await agent.close();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
