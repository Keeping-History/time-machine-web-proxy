// Ambient declarations for `wayback-machine-downloader@0.5.0`.
// The package ships no types. The shape below is verified against the installed
// tarball at `node_modules/wayback-machine-downloader/lib/utils.js` (see
// `normalizeBaseUrlInput` return statement) and `lib/downloader.js`
// (constructor + `download_files`).
//
// Note on `normalizeBaseUrlInput`: the plan's original declaration claimed
// `{ canonicalUrl, host }`. The real return shape is
// `{ canonicalUrl, variants, bareHost, unicodeHost }`. The latter is what
// callers must use (`base.bareHost`, not `base.host`).
declare module "wayback-machine-downloader" {
	export interface DownloaderOptions {
		base_url: string;
		normalized_base?: {
			canonicalUrl: string;
			variants: string[];
			bareHost: string;
			unicodeHost: string;
		};
		from_timestamp: number | string;
		to_timestamp: number | string;
		threads_count: number;
		rewrite_mode: "as-is" | "relative";
		canonical_action: "keep" | "remove";
		exact_url: boolean;
		download_external_assets: boolean;
		directory: string | null;
	}
	export class WaybackMachineDownloader {
		constructor(opts: DownloaderOptions);
		download_files(): Promise<void>;
	}
	export function setDebugMode(on: boolean): void;
}

declare module "wayback-machine-downloader/lib/utils.js" {
	export function normalizeBaseUrlInput(input: string): {
		canonicalUrl: string;
		variants: string[];
		bareHost: string;
		unicodeHost: string;
	};
}
