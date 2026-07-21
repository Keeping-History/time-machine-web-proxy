import { promises as fs } from "node:fs";
import { join } from "node:path";
import type pino from "pino";

// Operator-managed config file at the root of the shared cache bucket (the
// GCS bucket is FUSE-mounted at Config.cacheDir, so the bucket root IS the
// cache dir). Expected shape:
//
//   { "blocked_domains": ["example.com", "*.ads.example.net"] }
//
// `*.host` matches every subdomain plus the apex — the same wildcard
// semantics as WHITELIST_HOSTS. A missing file means "no blocklist".
const CONFIG_FILENAME = "config.json";
// How long a loaded list is trusted before re-reading the file. Bounds the
// GCS FUSE reads to one per interval while letting bucket edits take effect
// without a restart.
const RELOAD_INTERVAL_MS = 60_000;

/**
 * Loads and caches the blocked-domain list from `<cacheDir>/config.json`.
 *
 * Failure policy:
 *   - ENOENT → empty list (deleting the file deliberately unblocks everything)
 *   - unreadable / malformed JSON → keep the previously loaded list and warn,
 *     so a transient read glitch on the shared mount can't silently drop the
 *     blocklist
 */
export class BlocklistService {
	private patterns: readonly string[] = [];
	private loadedAtMs = Number.NEGATIVE_INFINITY;
	private loadInflight: Promise<void> | null = null;

	constructor(
		private readonly cacheDir: string,
		private readonly logger: pino.Logger,
		private readonly reloadIntervalMs: number = RELOAD_INTERVAL_MS,
	) {}

	async isBlocked(hostname: string): Promise<boolean> {
		await this.ensureFresh();
		const host = hostname.toLowerCase();
		return this.patterns.some((pattern) => {
			if (pattern.startsWith("*.")) {
				return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
			}
			return host === pattern;
		});
	}

	/** Reload at most once per interval; concurrent callers share one read. */
	private async ensureFresh(): Promise<void> {
		if (Date.now() - this.loadedAtMs < this.reloadIntervalMs) return;
		if (!this.loadInflight) {
			this.loadInflight = this.load().finally(() => {
				this.loadInflight = null;
			});
		}
		await this.loadInflight;
	}

	private async load(): Promise<void> {
		const path = join(this.cacheDir, CONFIG_FILENAME);
		let raw: string;
		try {
			raw = await fs.readFile(path, "utf-8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") {
				this.patterns = [];
			} else {
				this.logger.warn(
					{ err: e, path },
					"[blocklist] config.json unreadable — keeping previous list",
				);
			}
			this.loadedAtMs = Date.now();
			return;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			const domains = (parsed as { blocked_domains?: unknown })?.blocked_domains;
			if (domains !== undefined && !Array.isArray(domains)) {
				throw new Error("blocked_domains is not an array");
			}
			this.patterns = (domains ?? [])
				.filter((d): d is string => typeof d === "string")
				.map((d) => d.trim().toLowerCase())
				.filter(Boolean);
		} catch (e) {
			this.logger.warn(
				{ err: e, path },
				"[blocklist] malformed config.json — keeping previous list",
			);
		}
		this.loadedAtMs = Date.now();
	}
}
