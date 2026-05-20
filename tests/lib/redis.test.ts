jest.mock("ioredis", () => {
	const mockCtor = jest.fn();
	return { __esModule: true, default: mockCtor };
});

import IORedis from "ioredis";
import { createRedis } from "../../src/lib/redis";

const MockIORedis = IORedis as unknown as jest.Mock;

describe("createRedis", () => {
	beforeEach(() => {
		MockIORedis.mockClear();
	});

	it("constructs IORedis with the BullMQ-required options", () => {
		createRedis("redis://localhost:6379");
		expect(MockIORedis).toHaveBeenCalledTimes(1);
		expect(MockIORedis).toHaveBeenCalledWith("redis://localhost:6379", {
			maxRetriesPerRequest: null,
			enableReadyCheck: false,
		});
	});

	it("passes the url through unchanged", () => {
		createRedis("redis://memorystore.internal:6379/0");
		expect(MockIORedis).toHaveBeenCalledWith(
			"redis://memorystore.internal:6379/0",
			expect.objectContaining({
				maxRetriesPerRequest: null,
				enableReadyCheck: false,
			}),
		);
	});
});
