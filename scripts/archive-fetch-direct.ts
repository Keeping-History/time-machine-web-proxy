import {
	TEST_URLS,
	buildDirectAgent,
	fetchOne,
	printResult,
} from "./archive-fetch-lib.js";

async function main(): Promise<void> {
	const agent = buildDirectAgent();
	console.log("=== DIRECT (no proxy) ===");
	try {
		for (const url of TEST_URLS) {
			const result = await fetchOne("direct", url, agent);
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
