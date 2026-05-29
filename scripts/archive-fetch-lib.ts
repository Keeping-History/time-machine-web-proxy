import { createHash } from "node:crypto";
import { Agent, type Headers, ProxyAgent, fetch } from "undici";

export interface FetchResult {
	label: string;
	url: string;
	ok: boolean;
	status: number | null;
	statusText: string;
	contentType: string | null;
	contentLength: number | null;
	bodyBytes: number;
	bodySha256: string | null;
	bodyPreview: string;
	durationMs: number;
	error: string | null;
	headers: Record<string, string>;
}

export const TEST_URLS: readonly string[] = [
	"https://archive.org/wayback/available?url=example.com&timestamp=2000",
	"https://web.archive.org/web/2000id_/http://example.com/",
	"https://web.archive.org/web/20000301000000id_/http://example.com/",
];

const DEFAULT_TIMEOUT_MS = 30_000;
const PREVIEW_CHARS = 200;

function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

export async function fetchOne(
	label: string,
	url: string,
	dispatcher: Agent | ProxyAgent,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FetchResult> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, {
			dispatcher,
			signal: controller.signal,
			redirect: "manual",
			headers: {
				"user-agent":
					"time-machine-web-proxy/test (+https://github.com/robbiebyrd/time-machine-web-proxy)",
				accept: "*/*",
			},
		});
		const buf = Buffer.from(await response.arrayBuffer());
		const contentLengthHeader = response.headers.get("content-length");
		const contentLength =
			contentLengthHeader != null ? Number(contentLengthHeader) : null;
		const preview = buf
			.subarray(0, PREVIEW_CHARS)
			.toString("utf8")
			.replace(/\s+/g, " ")
			.trim();

		return {
			label,
			url,
			ok: response.ok,
			status: response.status,
			statusText: response.statusText,
			contentType: response.headers.get("content-type"),
			contentLength: Number.isFinite(contentLength) ? contentLength : null,
			bodyBytes: buf.length,
			bodySha256: createHash("sha256").update(buf).digest("hex"),
			bodyPreview: preview,
			durationMs: Date.now() - started,
			error: null,
			headers: headersToRecord(response.headers),
		};
	} catch (err) {
		const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		return {
			label,
			url,
			ok: false,
			status: null,
			statusText: "",
			contentType: null,
			contentLength: null,
			bodyBytes: 0,
			bodySha256: null,
			bodyPreview: "",
			durationMs: Date.now() - started,
			error: message,
			headers: {},
		};
	} finally {
		clearTimeout(timer);
	}
}

export function buildProxyAgent(proxyUrl: string): ProxyAgent {
	const username = process.env.OUTBOUND_PROXY_USERNAME;
	const password = process.env.OUTBOUND_PROXY_PASSWORD;
	const token =
		username && password
			? Buffer.from(`${username}:${password}`).toString("base64")
			: null;
	return new ProxyAgent({
		uri: proxyUrl,
		token: token ? `Basic ${token}` : undefined,
	});
}

export function buildDirectAgent(): Agent {
	return new Agent({ connect: { timeout: 10_000 } });
}

export function printResult(result: FetchResult): void {
	console.log(`\n--- [${result.label}] ${result.url} ---`);
	if (result.error) {
		console.log(`  ERROR: ${result.error}`);
		console.log(`  duration: ${result.durationMs} ms`);
		return;
	}
	console.log(`  status:        ${result.status} ${result.statusText}`);
	console.log(`  content-type:  ${result.contentType ?? "(none)"}`);
	console.log(
		`  content-length:${result.contentLength != null ? ` ${result.contentLength}` : " (none)"}`,
	);
	console.log(`  body-bytes:    ${result.bodyBytes}`);
	console.log(`  sha256:        ${result.bodySha256}`);
	console.log(`  duration:      ${result.durationMs} ms`);
	const proxymeshError = result.headers["x-proxymesh-error"];
	const proxymeshIp = result.headers["x-proxymesh-ip"];
	if (proxymeshError) console.log(`  x-proxymesh-error: ${proxymeshError}`);
	if (proxymeshIp) console.log(`  x-proxymesh-ip:    ${proxymeshIp}`);
	if (result.bodyPreview) console.log(`  preview: ${result.bodyPreview}`);
}
