import { dayWindow } from "../../src/lib/archive-time";

describe("dayWindow", () => {
	it("widens a 14-digit timestamp to the full calendar day", () => {
		expect(dayWindow("20210315123045")).toEqual({
			from: "20210315000000",
			to: "20210315235959",
		});
	});

	it("preserves the YYYYMMDD prefix at the start of the day", () => {
		expect(dayWindow("20210315000000")).toEqual({
			from: "20210315000000",
			to: "20210315235959",
		});
	});

	it("preserves the YYYYMMDD prefix at the end of the day", () => {
		expect(dayWindow("20210315235959")).toEqual({
			from: "20210315000000",
			to: "20210315235959",
		});
	});
});
