import { describe, expect, it } from "vitest";
import {
  canObserve,
  defaultLevelOf,
  everyoneObserves,
  explicitLevelOf,
  isGM,
  levelOf,
  ownsExplicitly,
  seesSecrets
} from "../src/permission.js";

const player = { _id: "playerA", role: 1 };
const other = { _id: "playerB", role: 1 };
const trusted = { _id: "trusted", role: 2 };
const assistant = { _id: "assist", role: 3 };
const gm = { _id: "gm", role: 4 };

describe("levelOf (Foundry's testUserPermission level)", () => {
  it("takes the user's own grant over the default, even a lower one", () => {
    const doc = { ownership: { default: 2, playerA: 0 } };
    expect(levelOf(doc, "playerA")).toBe(0);
    expect(levelOf(doc, "playerB")).toBe(2);
  });

  it("is NONE when the document names nothing", () => {
    expect(levelOf({}, "playerA")).toBe(0);
    expect(levelOf({ ownership: {} }, "playerA")).toBe(0);
  });

  it("inherits the entry's level for a page at -1, per user", () => {
    const entry = { ownership: { default: 0, playerA: 2 } };
    const page = { ownership: { default: -1 } };
    expect(levelOf(page, "playerA", entry)).toBe(2);
    expect(levelOf(page, "playerB", entry)).toBe(0);
  });

  it("inherits for a user whose own grant on the page is -1", () => {
    const entry = { ownership: { default: 3 } };
    expect(levelOf({ ownership: { default: 0, playerA: -1 } }, "playerA", entry)).toBe(3);
  });

  it("treats -1 with no parent as NONE", () => {
    expect(levelOf({ ownership: { default: -1 } }, "playerA")).toBe(0);
  });
});

describe("defaultLevelOf and explicitLevelOf", () => {
  it("reads the default through an inheriting page", () => {
    expect(defaultLevelOf({ ownership: { default: -1 } }, { ownership: { default: 2 } })).toBe(2);
    expect(defaultLevelOf({ ownership: { default: 1 } }, { ownership: { default: 2 } })).toBe(1);
  });

  it("finds a grant by name on the page or, inheriting, on the entry", () => {
    const entry = { ownership: { default: 0, gm: 3 } };
    expect(explicitLevelOf({ ownership: { default: -1 } }, "gm", entry)).toBe(3);
    expect(explicitLevelOf({ ownership: { default: 0, gm: 2 } }, "gm", entry)).toBe(2);
    expect(explicitLevelOf({ ownership: { default: 0 } }, "gm", entry)).toBeNull();
    expect(explicitLevelOf({ ownership: { default: 2 } }, "gm")).toBeNull();
  });
});

describe("canObserve", () => {
  const shared = { ownership: { default: 2 } };
  const limited = { ownership: { default: 1 } };
  const hidden = { ownership: { default: 0 } };
  const grantedA = { ownership: { default: 0, playerA: 2 } };
  const gmGranted = { ownership: { default: 0, gm: 3 } };

  it("passes a player at OBSERVER or above, never below", () => {
    expect(canObserve(shared, player)).toBe(true);
    expect(canObserve({ ownership: { default: 3 } }, player)).toBe(true);
    expect(canObserve(limited, player)).toBe(false);
    expect(canObserve(hidden, player)).toBe(false);
    expect(canObserve(grantedA, player)).toBe(true);
    expect(canObserve(grantedA, other)).toBe(false);
  });

  it("gives a trusted player no more than a player", () => {
    expect(canObserve(hidden, trusted)).toBe(false);
  });

  it("lets a GM see everything under gmGaze all", () => {
    for (const u of [gm, assistant]) {
      expect(canObserve(hidden, u, { gmGaze: "all" })).toBe(true);
      expect(canObserve(grantedA, u, { gmGaze: "all" })).toBe(true);
    }
  });

  it("narrows a GM to the players' view plus their own grants under gmGaze player", () => {
    expect(canObserve(shared, gm, { gmGaze: "player" })).toBe(true);
    expect(canObserve(hidden, gm, { gmGaze: "player" })).toBe(false);
    expect(canObserve(grantedA, gm, { gmGaze: "player" })).toBe(false);
    expect(canObserve(gmGranted, gm, { gmGaze: "player" })).toBe(true);
    expect(canObserve(gmGranted, assistant, { gmGaze: "player" })).toBe(false);
  });

  it("defaults to the player's view for a GM", () => {
    expect(canObserve(hidden, gm)).toBe(false);
  });

  it("follows an inheriting page for a GM under gmGaze player", () => {
    const entry = { ownership: { default: 0, gm: 3 } };
    expect(
      canObserve({ ownership: { default: -1 } }, gm, { gmGaze: "player", parent: entry })
    ).toBe(true);
    expect(
      canObserve({ ownership: { default: -1 } }, gm, {
        gmGaze: "player",
        parent: { ownership: { default: 0 } }
      })
    ).toBe(false);
  });

  it("refuses a missing document or user", () => {
    expect(canObserve(null, player)).toBe(false);
    expect(canObserve(shared, null)).toBe(false);
    expect(canObserve(shared, {})).toBe(false);
  });
});

describe("the helpers", () => {
  it("names GMs by role", () => {
    expect([player, trusted, assistant, gm].map(isGM)).toEqual([false, false, true, true]);
  });

  it("says when every player observes", () => {
    expect(everyoneObserves({ ownership: { default: 2 } })).toBe(true);
    expect(everyoneObserves({ ownership: { default: 0, playerA: 3 } })).toBe(false);
    expect(everyoneObserves({ ownership: { default: -1 } }, { ownership: { default: 2 } })).toBe(
      true
    );
  });

  it("counts only an explicit owner grant as owning", () => {
    expect(ownsExplicitly({ ownership: { default: 3 } }, "playerA")).toBe(false);
    expect(ownsExplicitly({ ownership: { default: 0, playerA: 3 } }, "playerA")).toBe(true);
    expect(ownsExplicitly({ ownership: { default: 0, playerA: 2 } }, "playerA")).toBe(false);
  });

  it("shows secrets to owners, and to a GM with the whole world in view", () => {
    const doc = { ownership: { default: 2, playerA: 3 } };
    expect(seesSecrets(doc, player)).toBe(true);
    expect(seesSecrets(doc, other)).toBe(false);
    expect(seesSecrets(doc, gm)).toBe(false);
    expect(seesSecrets(doc, gm, { gmGaze: "all" })).toBe(true);
  });
});
