export const errorHasStatus = (e: unknown): e is { status: number } =>
	e !== null &&
	typeof e === "object" &&
	"status" in e &&
	typeof (e as Record<string, unknown>).status === "number";

/**
 * Unwraps a fetch failure into a human-readable string. Handles undici's
 * `TypeError: fetch failed` (which puts the real cause on `.cause`) plus
 * AbortError (timeout) and plain Error fallbacks.
 */
export function describeFetchError(e: unknown): string {
	if (e instanceof Error && e.name === "TimeoutError") return "timed out";
	const cause = (e as { cause?: unknown })?.cause;
	if (cause instanceof Error) {
		// Common system-error shapes from libc/undici. The `code` is the most
		// useful single token (ENOTFOUND, ECONNREFUSED, EAI_AGAIN, ECONNRESET);
		// the message adds the address/port when present.
		const code = (cause as { code?: string }).code;
		return code ? `${code} (${cause.message})` : cause.message;
	}
	if (e instanceof Error) return e.message;
	return String(e);
}
