import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULTS_FILE,
  loadConfig,
  readEnv,
  readVersion,
  REPO_DIR,
  stripBom
} from "../src/config.js";
import { mayAsk, moduleSettings, SETTING_DEFAULTS } from "../src/settings.js";
import { tempDir } from "./helpers.js";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("the committed config", () => {
  it("holds the contract's defaults", () => {
    expect(loadConfig(DEFAULTS_FILE)).toEqual({
      model: "claude-opus-5-5",
      effort: "medium",
      maxOutputTokens: 4096,
      cacheTtl: "5m",
      refusalFallback: true,
      callTimeoutMs: 60000,
      sittingRetentionDays: 90,
      limits: {
        perUserHour: 10,
        perUserDay: 40,
        tableDayUsd: 5,
        tableMonthUsd: 25,
        messageChars: 4000,
        sittingTurns: 24,
        gazeBudgetTokens: 120000
      },
      prices: {
        "claude-opus-5-5": {
          input: 4,
          cacheWrite5m: 5,
          cacheWrite1h: 8,
          cacheRead: 0.2,
          output: 20
        },
        "claude-sonnet-5-5": {
          input: 2,
          cacheWrite5m: 2.5,
          cacheWrite1h: 4,
          cacheRead: 0.2,
          output: 10
        }
      }
    });
  });

  it("takes an override file key by key over the defaults", () => {
    const dir = tempDir("config");
    dirs.push(dir);
    const file = path.join(dir, "config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ model: "claude-sonnet-5-5", cacheTtl: "1h", limits: { perUserHour: 3 } })
    );
    const config = loadConfig(file);
    expect(config.model).toBe("claude-sonnet-5-5");
    expect(config.cacheTtl).toBe("1h");
    expect(config.limits.perUserHour).toBe(3);
    expect(config.limits.perUserDay).toBe(40);
    expect(config.prices["claude-opus-5-5"].input).toBe(4);
  });

  it("refuses a config it cannot run", () => {
    const dir = tempDir("config");
    dirs.push(dir);
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ effort: "extreme", cacheTtl: "2h" }));
    expect(() => loadConfig(file)).toThrow(/effort, cacheTtl/);
  });

  it("falls back to the defaults when the CONFIG file is missing", () => {
    expect(loadConfig(path.join(REPO_DIR, "seer", "no-such-config.json")).model).toBe(
      "claude-opus-5-5"
    );
  });
});

describe("the environment", () => {
  it("has the contract's defaults", () => {
    const env = readEnv({});
    expect(env).toMatchObject({
      apiKey: "",
      stub: false,
      foundryUrl: "http://localhost:30000",
      ballUser: "Crystal Ball",
      ballPassword: "",
      port: 30001,
      bind: "127.0.0.1",
      basePath: "/crystalball",
      corsOrigin: "",
      logLevel: "info"
    });
    expect(env.dataDir).toBe(path.join(REPO_DIR, "seer", "data"));
    expect(env.configFile).toBe(DEFAULTS_FILE);
  });

  it("reads each variable, a bare slash meaning no base path", () => {
    const env = readEnv({
      ANTHROPIC_API_KEY: " k ",
      MODEL_STUB: "1",
      PORT: "4000",
      BASE_PATH: "/",
      CORS_ORIGIN: "http://localhost:30000",
      DATA_DIR: path.join(REPO_DIR, "elsewhere")
    });
    expect(env).toMatchObject({
      apiKey: "k",
      stub: true,
      port: 4000,
      basePath: "",
      corsOrigin: "http://localhost:30000"
    });
    expect(env.dataDir).toBe(path.join(REPO_DIR, "elsewhere"));
  });

  it("reports module.json's version", () => {
    expect(readVersion()).toBe(
      JSON.parse(fs.readFileSync(path.join(REPO_DIR, "module.json"), "utf8")).version
    );
  });
});

describe("the module's settings", () => {
  it("are the contract's defaults when the world never saved them", () => {
    expect(moduleSettings({ settings: [] })).toEqual({ ...SETTING_DEFAULTS, askerIds: [] });
    expect(SETTING_DEFAULTS).toMatchObject({
      enabled: true,
      serviceUrl: "/crystalball",
      tableNotes: "",
      askers: "players",
      gmGaze: "player"
    });
  });

  it("parse the stored JSON strings and coerce what they must be", () => {
    const s = moduleSettings({
      settings: [
        { key: "fvtt-mod-crystalball.enabled", user: null, value: "false" },
        { key: "fvtt-mod-crystalball.askers", user: null, value: '"listed"' },
        { key: "fvtt-mod-crystalball.askerIds", user: null, value: '"a, b ,,c"' },
        { key: "fvtt-mod-crystalball.gmGaze", user: null, value: '"everything"' },
        { key: "fvtt-mod-crystalball.tableNotes", user: "someone", value: '"not the DM\'s"' }
      ]
    });
    expect(s).toMatchObject({
      enabled: false,
      askers: "listed",
      askerIds: ["a", "b", "c"],
      gmGaze: "player",
      tableNotes: ""
    });
  });
});

describe("a box's configuration", () => {
  it("keeps the data in systemd's state directory when DATA_DIR is unset", () => {
    const state = path.join(REPO_DIR, "state-dir-for-the-test");
    expect(readEnv({ STATE_DIRECTORY: state }).dataDir).toBe(state);
    expect(readEnv({ STATE_DIRECTORY: `${state}${path.delimiter}${state}-two` }).dataDir).toBe(
      state
    );
    expect(readEnv({ STATE_DIRECTORY: state, DATA_DIR: path.join(REPO_DIR, "mine") }).dataDir).toBe(
      path.join(REPO_DIR, "mine")
    );
  });

  it("reads a config file that opens with a byte-order mark", () => {
    const dir = tempDir("config");
    dirs.push(dir);
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, `﻿${JSON.stringify({ effort: "medium" })}`);
    expect(loadConfig(file).effort).toBe("medium");
    expect(stripBom("﻿{}")).toBe("{}");
    expect(stripBom("{}")).toBe("{}");
  });

  it("refuses a count cap of 0, and allows a dollar ceiling of 0 as an off switch", () => {
    const dir = tempDir("config");
    dirs.push(dir);
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ limits: { perUserHour: 0, perUserDay: 1.5 } }));
    expect(() => loadConfig(file)).toThrow(/limits\.perUserHour, limits\.perUserDay/);
    fs.writeFileSync(file, JSON.stringify({ limits: { tableDayUsd: 0 } }));
    expect(loadConfig(file).limits.tableDayUsd).toBe(0);
  });
});

describe("whose settings count", () => {
  const users = [
    { _id: "gmUser0000000001", role: 4 },
    { _id: "assistGm00000001", role: 3 },
    { _id: "playerAda0000001", role: 1 }
  ];

  it("ignores a world row a player last wrote (a forged user row) and keeps the DM's", () => {
    const s = moduleSettings({
      users,
      settings: [
        {
          key: "fvtt-mod-crystalball.tableNotes",
          user: null,
          value: '"forged"',
          _stats: { lastModifiedBy: "playerAda0000001" }
        },
        {
          key: "fvtt-mod-crystalball.tableNotes",
          user: null,
          value: '"the DM\'s"',
          _stats: { lastModifiedBy: "gmUser0000000001" }
        },
        {
          key: "fvtt-mod-crystalball.askers",
          user: null,
          value: '"listed"',
          _stats: { lastModifiedBy: "playerAda0000001" }
        },
        {
          key: "fvtt-mod-crystalball.gmGaze",
          user: null,
          value: '"all"',
          _stats: { lastModifiedBy: "assistGm00000001" }
        },
        {
          key: "fvtt-mod-crystalball.enabled",
          user: null,
          value: "false",
          _stats: { lastModifiedBy: "someoneGone00001" }
        }
      ]
    });
    expect(s).toMatchObject({
      tableNotes: "the DM's",
      askers: "players",
      gmGaze: "all",
      enabled: true
    });
  });

  it("trusts a row with no record of who wrote it", () => {
    expect(
      moduleSettings({
        users,
        settings: [{ key: "fvtt-mod-crystalball.tableNotes", user: null, value: '"x"' }]
      }).tableNotes
    ).toBe("x");
    expect(
      moduleSettings({
        users,
        settings: [
          {
            key: "fvtt-mod-crystalball.tableNotes",
            user: null,
            value: '"y"',
            _stats: { lastModifiedBy: null }
          }
        ]
      }).tableNotes
    ).toBe("y");
  });

  it("lets no banned user ask", () => {
    const open = moduleSettings({ settings: [] });
    expect(mayAsk(open, { _id: "a", role: 1 })).toBe(true);
    expect(mayAsk(open, { _id: "a", role: 0 })).toBe(false);
    expect(mayAsk(open, { _id: "a" })).toBe(false);
  });
});
