// Type-only test for the `wayback-machine-downloader` ambient declarations
// at `src/types/wayback-machine-downloader.d.ts`.
//
// The runtime package is pure ESM and cannot be `require()`d under the
// CommonJS test harness (ts-jest + tsconfig.jest.json sets module=CommonJS).
// To exercise the type declaration without loading the ESM runtime we use
// `import type` (erased at compile time) and assert the public surface via
// the `Expect`/`Equal` pattern. The test body has a single runtime
// assertion so jest counts the suite as passing.
import type { DownloaderOptions, WaybackMachineDownloader } from "wayback-machine-downloader";
import type { normalizeBaseUrlInput } from "wayback-machine-downloader/lib/utils.js";

// Compile-time helpers (TS-only; erased at runtime).
type Expect<T extends true> = T;
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// 1. DownloaderOptions has the documented fields with the documented types.
type _OptsBaseUrlIsString = Expect<Equal<DownloaderOptions["base_url"], string>>;
type _OptsFromTimestamp = Expect<Equal<DownloaderOptions["from_timestamp"], number | string>>;
type _OptsRewriteMode = Expect<Equal<DownloaderOptions["rewrite_mode"], "as-is" | "relative">>;
type _OptsCanonicalAction = Expect<Equal<DownloaderOptions["canonical_action"], "keep" | "remove">>;
type _OptsExactUrl = Expect<Equal<DownloaderOptions["exact_url"], boolean>>;
type _OptsDirectory = Expect<Equal<DownloaderOptions["directory"], string | null>>;

// 2. `normalized_base` (when present) has the corrected shape:
// `{ canonicalUrl, variants, bareHost, unicodeHost }`. The plan's original
// declaration claimed `{ canonicalUrl, host }` — that was wrong against the
// real tarball source at `node_modules/wayback-machine-downloader/lib/utils.js`.
type NormalizedBase = NonNullable<DownloaderOptions["normalized_base"]>;
type _NormalizedShape = Expect<
	Equal<
		NormalizedBase,
		{
			canonicalUrl: string;
			variants: string[];
			bareHost: string;
			unicodeHost: string;
		}
	>
>;

// 3. `download_files` returns `Promise<void>`.
type DownloadFilesReturn = ReturnType<
	InstanceType<typeof WaybackMachineDownloader>["download_files"]
>;
type _DownloadFilesIsPromiseVoid = Expect<Equal<DownloadFilesReturn, Promise<void>>>;

// 4. `normalizeBaseUrlInput` returns the corrected shape.
type NormalizeReturn = ReturnType<typeof normalizeBaseUrlInput>;
type _NormalizeShape = Expect<
	Equal<
		NormalizeReturn,
		{
			canonicalUrl: string;
			variants: string[];
			bareHost: string;
			unicodeHost: string;
		}
	>
>;

// Anchor the compile-time assertions to a runtime test so jest reports a pass.
describe("wayback-machine-downloader types", () => {
	it("compiles with the corrected declaration shape", () => {
		const _proofs: [
			_OptsBaseUrlIsString,
			_OptsFromTimestamp,
			_OptsRewriteMode,
			_OptsCanonicalAction,
			_OptsExactUrl,
			_OptsDirectory,
			_NormalizedShape,
			_DownloadFilesIsPromiseVoid,
			_NormalizeShape,
		] = [true, true, true, true, true, true, true, true, true];
		expect(_proofs.every((p) => p === true)).toBe(true);
	});
});
