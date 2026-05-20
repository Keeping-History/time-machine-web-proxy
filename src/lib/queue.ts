interface QueueEntry {
	execute: () => Promise<Response>;
	resolve: (value: Response) => void;
	reject: (reason: unknown) => void;
}

export class ArchiveRequestQueue {
	private queue: QueueEntry[] = [];
	private active = 0;
	private rateTokens: number;
	private rateLastRefill = Date.now();
	private drainScheduled = false;

	constructor(
		private readonly maxConcurrent: number,
		private readonly ratePerSec: number,
		private readonly burst: number,
		private readonly maxQueueSize: number = 200,
	) {
		this.rateTokens = burst;
	}

	enqueue(execute: () => Promise<Response>): Promise<Response> {
		if (this.queue.length >= this.maxQueueSize) {
			const err = Object.assign(new Error("Too many pending requests"), { status: 503 });
			return Promise.reject(err);
		}
		return new Promise<Response>((resolve, reject) => {
			this.queue.push({ execute, resolve, reject });
			this.drain();
		});
	}

	get pending(): number {
		return this.queue.length;
	}

	get running(): number {
		return this.active;
	}

	private scheduleDrain(): void {
		if (this.drainScheduled) return;
		this.drainScheduled = true;
		queueMicrotask(() => {
			this.drainScheduled = false;
			this.drain();
		});
	}

	private drain(): void {
		while (this.queue.length > 0 && this.active < this.maxConcurrent) {
			this.refillTokens();
			if (this.rateTokens < 1) {
				const waitMs = Math.ceil(((1 - this.rateTokens) / this.ratePerSec) * 1000);
				setTimeout(() => this.drain(), waitMs);
				return;
			}

			this.rateTokens -= 1;
			const entry = this.queue.shift();
			if (!entry) break;
			this.active++;

			entry
				.execute()
				.then(
					(res) => entry.resolve(res),
					(err) => entry.reject(err),
				)
				.finally(() => {
					this.active--;
					this.scheduleDrain();
				});
		}
	}

	abort(): void {
		const err = new Error("Server shutting down");
		for (const entry of this.queue) entry.reject(err);
		this.queue = [];
	}

	private refillTokens(): void {
		const now = Date.now();
		this.rateTokens = Math.min(
			this.burst,
			this.rateTokens + ((now - this.rateLastRefill) / 1000) * this.ratePerSec,
		);
		this.rateLastRefill = now;
	}
}
