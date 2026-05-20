// Convert a 14-digit YYYYMMDDhhmmss timestamp into the calendar-day window
// it falls within. Shared between the domain crawler (so CDX returns ALL
// captures of the host on that day rather than only the exact requested
// second) and the CDX size-preflight in ProxyService (so the page count
// reflects the same window the crawler will actually fetch).
export function dayWindow(time: string): { from: string; to: string } {
	const day = time.slice(0, 8);
	return { from: `${day}000000`, to: `${day}235959` };
}
