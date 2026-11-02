import { describe, expect, it } from "vitest";
import {
  darkReason,
  failureOf,
  MESSAGE_LIMIT,
  modelLabel,
  serviceBase,
  sessionIdFrom,
  waitOf
} from "../scripts/decide/session.js";

describe("the session cookie", () => {
  it("reads the session cookie's value, decoded", () => {
    expect(sessionIdFrom("session=abc123")).toBe("abc123");
    expect(sessionIdFrom("theme=dark; session=a%20b; other=1")).toBe("a b");
  });

  it("is null without a session cookie, or with an empty one", () => {
    expect(sessionIdFrom("")).toBeNull();
    expect(sessionIdFrom(undefined)).toBeNull();
    expect(sessionIdFrom("theme=dark")).toBeNull();
    expect(sessionIdFrom("session=")).toBeNull();
    expect(sessionIdFrom("session")).toBeNull();
    expect(sessionIdFrom("sessionx=1; xsession=2")).toBeNull();
  });

  it("splits as Foundry's getCookies does: a later cookie of the name wins, a broken escape is none", () => {
    expect(sessionIdFrom("session=first; session=second")).toBe("second");
    expect(sessionIdFrom("session=%E0%A4%A")).toBeNull();
  });
});

describe("the Seer's base URL", () => {
  const origin = "https://foundry.example.com";

  it("resolves a path against the page's origin", () => {
    expect(serviceBase("/crystalball", origin)).toBe("https://foundry.example.com/crystalball");
    expect(serviceBase("crystalball/", origin)).toBe("https://foundry.example.com/crystalball");
  });

  it("uses a full URL as it is, without a trailing slash", () => {
    expect(serviceBase("http://localhost:30001", "http://localhost:30000")).toBe(
      "http://localhost:30001"
    );
    expect(serviceBase("http://localhost:30001/", "http://localhost:30000")).toBe(
      "http://localhost:30001"
    );
    expect(serviceBase("http://localhost:30001/crystalball//", "http://localhost:30000")).toBe(
      "http://localhost:30001/crystalball"
    );
  });

  it("takes the default for a blank setting, and refuses what is not http(s)", () => {
    expect(serviceBase("", origin)).toBe("https://foundry.example.com/crystalball");
    expect(serviceBase("   ", origin)).toBe("https://foundry.example.com/crystalball");
    expect(serviceBase(undefined, origin)).toBe("https://foundry.example.com/crystalball");
    expect(serviceBase("javascript:alert(1)", origin)).toBeNull();
    expect(serviceBase("/x", "not an origin")).toBeNull();
  });
});

describe("the model's name", () => {
  it("names the family from the id", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus");
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet");
    expect(modelLabel("stub")).toBe("stub");
    expect(modelLabel("some-other-model")).toBe("some-other-model");
    expect(modelLabel("")).toBeNull();
    expect(modelLabel(null)).toBeNull();
  });
});

describe("the line a failure shows", () => {
  it("maps each of the contract's error bodies", () => {
    expect(failureOf(401, { error: "unknown-session" })).toEqual({ key: "unknownSession" });
    expect(failureOf(403, { error: "not-allowed" })).toEqual({ key: "notAllowed" });
    expect(failureOf(413, { error: "too-long", limit: 3000 })).toEqual({
      key: "tooLong",
      limit: 3000
    });
    expect(failureOf(429, { error: "limit", scope: "hour", retryAfter: 120 })).toEqual({
      key: "limit.hour",
      retryAfter: 120
    });
    expect(failureOf(429, { error: "limit", scope: "table-month", retryAfter: 9 })).toEqual({
      key: "limit.tableMonth",
      retryAfter: 9
    });
    expect(failureOf(503, { error: "dark", reason: "world-closed" })).toEqual({
      key: "dark.worldClosed"
    });
    expect(failureOf(503, { error: "dark", reason: "foundry-disconnected" })).toEqual({
      key: "dark.foundryDisconnected"
    });
    expect(failureOf(503, { error: "dark", reason: "model" })).toEqual({ key: "dark.model" });
    expect(failureOf(500, { error: "seer", message: "boom" })).toEqual({
      key: "seer",
      message: "boom"
    });
  });

  it("falls back on the status when the body says nothing, and on safe defaults", () => {
    expect(failureOf(401, null)).toEqual({ key: "unknownSession" });
    expect(failureOf(413, {})).toEqual({ key: "tooLong", limit: MESSAGE_LIMIT });
    expect(failureOf(429, { error: "limit", scope: "week" })).toEqual({
      key: "limit.hour",
      retryAfter: 0
    });
    expect(failureOf(503, { error: "dark", reason: "?" })).toEqual({ key: "dark.model" });
    expect(failureOf(503, { error: "dark", reason: "constructor" })).toEqual({ key: "dark.model" });
    expect(failureOf(429, { error: "limit", scope: "toString" }).key).toBe("limit.hour");
    expect(failureOf(500, { error: "seer" })).toEqual({ key: "seerQuiet" });
    expect(failureOf(502, "<html>")).toEqual({ key: "status", status: 502 });
  });

  it("reads a stream's error event by its code", () => {
    expect(failureOf(0, { error: "dark", reason: "model", message: "timeout" })).toEqual({
      key: "dark.model"
    });
    expect(failureOf(0, { error: "seer", message: "unreadable" })).toEqual({
      key: "seer",
      message: "unreadable"
    });
    expect(failureOf(0, {})).toEqual({ key: "seerQuiet" });
  });
});

describe("a wait", () => {
  it("counts seconds, minutes, then hours, rounding up", () => {
    expect(waitOf(1)).toEqual({ n: 1, unit: "second" });
    expect(waitOf(0)).toEqual({ n: 1, unit: "second" });
    expect(waitOf(45)).toEqual({ n: 45, unit: "seconds" });
    expect(waitOf(60 * 30)).toEqual({ n: 30, unit: "minutes" });
    expect(waitOf(61 * 60)).toEqual({ n: 61, unit: "minutes" });
    expect(waitOf(61 * 60 + 1)).toEqual({ n: 62, unit: "minutes" });
    expect(waitOf(3600 * 5 + 1)).toEqual({ n: 6, unit: "hours" });
    expect(waitOf(5400)).toEqual({ n: 2, unit: "hours" });
  });
});

describe("why the ball is dark", () => {
  it("reads healthz", () => {
    expect(darkReason(null)).toBe("unreachable");
    expect(darkReason({ foundry: { connected: false, worldOpen: false } })).toBe("foundry");
    expect(darkReason({ foundry: { connected: true, worldOpen: false } })).toBe("world");
    expect(darkReason({ foundry: { connected: true, worldOpen: true }, model: "stub" })).toBeNull();
  });
});
