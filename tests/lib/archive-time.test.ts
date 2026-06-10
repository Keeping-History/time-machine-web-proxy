import { windowAround } from "../../src/lib/archive-time";

describe("windowAround", () => {
	it("returns ±30 days around 1998-01-01 with year and month rollover", () => {
		expect(windowAround("19980101000000", 30)).toEqual({
			from: "19971202000000",
			to: "19980131235959",
		});
	});

	it("spans leap day going backward in a leap year (2000)", () => {
		// 2000-03-01 - 2 days = 2000-02-28 (Feb 2000 has 29 days)
		expect(windowAround("20000301000000", 2)).toEqual({
			from: "20000228000000",
			to: "20000303235959",
		});
	});

	it("skips leap day going backward in a non-leap year (1999)", () => {
		// 1999-03-01 - 2 days = 1999-02-27 (Feb 1999 has only 28 days)
		expect(windowAround("19990301000000", 2)).toEqual({
			from: "19990227000000",
			to: "19990303235959",
		});
	});

	it("handles a 1-day window", () => {
		expect(windowAround("20210315120000", 1)).toEqual({
			from: "20210314000000",
			to: "20210316235959",
		});
	});
});
