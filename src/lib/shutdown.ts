export class ShutdownController {
	private readonly controller = new AbortController();

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	abort(): void {
		this.controller.abort();
	}
}

export const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Server shutting down"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("Server shutting down"));
		});
	});
