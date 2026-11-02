import { describe, expect, it } from "vitest";
import {
  createLimits,
  decide,
  nextDay,
  nextMonth,
  startOfDay,
  startOfMonth,
  usageReport
} from "../src/limits.js";

const LIMITS = {
  perUserHour: 10,
  perUserDay: 40,
  tableDayUsd: 5,
  tableMonthUsd: 25,
  messageChars: 4000
};
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** Local times, as the box keeps its calendar. */
const at = (y, m, d, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s);

const calls = (n, userId, from, stepMs, cost = 0) =>
  Array.from({ length: n }, (_, i) => ({ at: from.getTime() + i * stepMs, userId, cost }));

describe("the calendar", () => {
  it("knows the day and month boundaries in local time", () => {
    const d = at(2026, 11, 30, 23, 59, 59);
    expect(startOfDay(d)).toEqual(at(2026, 11, 30));
    expect(nextDay(d)).toEqual(at(2026, 12, 1));
    expect(startOfMonth(d)).toEqual(at(2026, 11, 1));
    expect(nextMonth(at(2026, 12, 15))).toEqual(at(2027, 1, 1));
  });
});

describe("decide", () => {
  const now = at(2026, 11, 2, 12, 0);

  it("lets a message through under every cap", () => {
    expect(decide({ limits: LIMITS, calls: [], userId: "a", message: "hello", now })).toBeNull();
  });

  it("refuses a message over the length with the limit named", () => {
    expect(
      decide({ limits: LIMITS, calls: [], userId: "a", message: "x".repeat(4001), now })
    ).toEqual({
      status: 413,
      body: { error: "too-long", limit: 4000 }
    });
    expect(
      decide({ limits: LIMITS, calls: [], userId: "a", message: "x".repeat(4000), now })
    ).toBeNull();
  });

  it("caps a user's rolling hour, and says when the oldest call leaves it", () => {
    const list = calls(10, "a", new Date(now.getTime() - 50 * MIN), MIN);
    expect(decide({ limits: LIMITS, calls: list, userId: "a", message: "m", now })).toEqual({
      status: 429,
      body: { error: "limit", scope: "hour", retryAfter: 10 * 60 }
    });
    expect(decide({ limits: LIMITS, calls: list, userId: "b", message: "m", now })).toBeNull();
  });

  it("forgets a call once it is an hour old", () => {
    const list = calls(10, "a", new Date(now.getTime() - HOUR - 1000), 0);
    expect(decide({ limits: LIMITS, calls: list, userId: "a", message: "m", now })).toBeNull();
  });

  it("caps a user's calendar day until local midnight", () => {
    const list = calls(40, "a", at(2026, 11, 2, 0, 5), 10 * MIN);
    const now2 = at(2026, 11, 2, 22, 0);
    expect(decide({ limits: LIMITS, calls: list, userId: "a", message: "m", now: now2 })).toEqual({
      status: 429,
      body: { error: "limit", scope: "day", retryAfter: 2 * 3600 }
    });
    expect(
      decide({ limits: LIMITS, calls: list, userId: "a", message: "m", now: at(2026, 11, 3, 0, 1) })
    ).toBeNull();
  });

  it("caps the table's day in dollars, whoever spent it", () => {
    const list = calls(5, "a", at(2026, 11, 2, 8), MIN, 1);
    expect(decide({ limits: LIMITS, calls: list, userId: "b", message: "m", now })).toEqual({
      status: 429,
      body: { error: "limit", scope: "table-day", retryAfter: 12 * 3600 }
    });
  });

  it("caps the table's month, and the month turning frees it", () => {
    const list = [
      ...calls(20, "a", at(2026, 11, 1, 1), HOUR, 1),
      ...calls(5, "b", at(2026, 11, 2, 1), MIN, 1)
    ];
    const end = at(2026, 11, 30, 23, 0);
    expect(decide({ limits: LIMITS, calls: list, userId: "c", message: "m", now: end })).toEqual({
      status: 429,
      body: { error: "limit", scope: "table-month", retryAfter: 3600 }
    });
    expect(
      decide({
        limits: LIMITS,
        calls: list,
        userId: "c",
        message: "m",
        now: at(2026, 12, 1, 0, 0, 1)
      })
    ).toBeNull();
  });

  it("names the longest wait first: the month before the day before the hour", () => {
    const list = calls(40, "a", at(2026, 11, 2, 11, 10), MIN, 1);
    const result = decide({ limits: LIMITS, calls: list, userId: "a", message: "m", now });
    expect(result.body.scope).toBe("table-month");
  });
});

describe("usageReport", () => {
  it("counts the user's hour and day and the table's day and month", () => {
    const now = at(2026, 11, 2, 12, 0);
    const list = [
      ...calls(3, "a", new Date(now.getTime() - 30 * MIN), MIN, 0.5),
      ...calls(2, "a", at(2026, 11, 2, 1), MIN, 0.25),
      ...calls(1, "b", at(2026, 11, 1, 9), MIN, 2)
    ];
    expect(usageReport({ limits: LIMITS, calls: list, userId: "a", now })).toEqual({
      user: { hour: 3, day: 5 },
      table: { day: { messages: 5, cost: 2 }, month: { messages: 6, cost: 4 } },
      limits: { perUserHour: 10, perUserDay: 40, tableDayUsd: 5, tableMonthUsd: 25 },
      remaining: { hour: 7, day: 35 }
    });
  });
});

describe("the store", () => {
  it("is seeded from the ledger and holds a slot for a call in flight", () => {
    let clock = at(2026, 11, 2, 12, 0);
    const store = createLimits({ limits: { ...LIMITS, perUserHour: 2 }, now: () => clock });
    store.seed([
      { at: new Date(clock.getTime() - 10 * MIN).toISOString(), userId: "a", cost: 0.1 },
      { at: "not a date", userId: "a" }
    ]);
    expect(store.report("a").user).toEqual({ hour: 1, day: 1 });
    const t = store.reserve("a");
    expect(store.check("a", "m")).toMatchObject({ status: 429, body: { scope: "hour" } });
    store.release(t);
    expect(store.check("a", "m")).toBeNull();
    const t2 = store.reserve("a");
    store.commit(t2, 0.2);
    expect(store.report("a").table.day).toEqual({ messages: 2, cost: 0.30000000000000004 });
    clock = new Date(clock.getTime() + HOUR);
    expect(store.check("a", "m")).toBeNull();
  });

  it("keeps a committed ticket once only", () => {
    const store = createLimits({ limits: LIMITS, now: () => at(2026, 11, 2, 12) });
    const t = store.reserve("a");
    store.commit(t, 1);
    store.commit(t, 1);
    store.release(t);
    expect(store.report("a").table.day).toEqual({ messages: 1, cost: 1 });
  });
});
