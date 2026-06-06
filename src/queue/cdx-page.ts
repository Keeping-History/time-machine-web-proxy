import { z } from "zod";

const CdxRowSchema = z.tuple([
	z.string(),
	z.string(),
	z.string(),
	z.string(),
	z.string(),
	z.string(),
	z.string(),
]);
const CdxResponseSchema = z.array(CdxRowSchema);

export interface CdxCapture {
	url: string;
	timestamp: string;
}

export interface CdxRow {
	urlkey: string;
	timestamp: string;
	original: string;
	statuscode: string;
}

export function parseCdxPage(json: unknown): CdxRow[] {
	const rows = CdxResponseSchema.parse(json);
	if (rows.length === 0) return [];
	return rows.slice(1).map((row) => ({
		urlkey: row[0],
		timestamp: row[1],
		original: row[2],
		statuscode: row[4],
	}));
}

export function pickClosestPerUrl(rows: CdxRow[], target: string): CdxCapture[] {
	const tgt = Number(target);
	const best = new Map<string, { ts: string; diff: number }>();
	for (const r of rows) {
		if (r.statuscode.startsWith("4") || r.statuscode.startsWith("5")) continue;
		const diff = Math.abs(Number(r.timestamp) - tgt);
		const existing = best.get(r.original);
		if (!existing || diff < existing.diff) best.set(r.original, { ts: r.timestamp, diff });
	}
	return [...best].map(([url, { ts }]) => ({ url, timestamp: ts }));
}
