export class ShutdownController {
	private readonly controller = new AbortController();

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	abort(): void {
		this.controller.abort();
	}
}

