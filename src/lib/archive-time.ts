export const TIMESTAMP_RE = /^\d{14}$/;

// Convert a 14-digit YYYYMMDDhhmmss timestamp into the calendar-day window
// it falls within. Shared between the domain crawler (so CDX returns ALL
// captures of the host on that day rather than only the exact requested
// second) and the CDX size-preflight in ProxyService (so the page count
// reflects the same window the crawler will actually fetch).
export function dayWindow(time: string): { from: string; to: string } {
	const day = time.slice(0, 8);
	return { from: `${day}000000`, to: `${day}235959` };
}

function parseTimestamp(time: string): Date {
	return new Date(
		Date.UTC(
			Number(time.slice(0, 4)),
			Number(time.slice(4, 6)) - 1,
			Number(time.slice(6, 8)),
			Number(time.slice(8, 10)),
			Number(time.slice(10, 12)),
			Number(time.slice(12, 14)),
		),
	);
}

function formatDate(date: Date, timeSuffix: string): string {
	const y = String(date.getUTCFullYear()).padStart(4, "0");
	const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
	const d = String(date.getUTCDate()).padStart(2, "0");
	return `${y}${mo}${d}${timeSuffix}`;
}

export function windowAround(time: string, days: number): { from: string; to: string } {
	const ts = parseTimestamp(time);
	const fromDate = new Date(ts.getTime() - days * 86_400_000);
	const toDate = new Date(ts.getTime() + days * 86_400_000);
	return { from: formatDate(fromDate, "000000"), to: formatDate(toDate, "235959") };
}
