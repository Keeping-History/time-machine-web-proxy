export const errorHasStatus = (e: unknown): e is { status: number } =>
	e !== null &&
	typeof e === "object" &&
	"status" in e &&
	typeof (e as Record<string, unknown>).status === "number";
