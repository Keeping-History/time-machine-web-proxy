export type ResourceType = "document" | "image" | "style";

export interface QueueEntry {
	execute: () => Promise<Response>;
	resolve: (value: Response) => void;
	reject: (reason: unknown) => void;
}
