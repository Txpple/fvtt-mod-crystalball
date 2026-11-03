import fs from "node:fs";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import {
  createServer,
  createSse,
  HEARTBEAT_MS,
  KEEP_ALIVE_MS,
  normaliseBase,
  parseCorsOrigins,
  timeZone
} from "../src/http.js";
import { createLedger } from "../src/ledger.js";
import { createLimits } from "../src/limits.js";
import { DEFAULTS_FILE, loadConfig } from "../src/config.js";
import { createModel } from "../src/model.js";
import { createSittings } from "../src/sittings.js";
import { quietLog, tempDir, until, world } from "./helpers.js";

const CONFIG = loadConfig(DEFAULTS_FILE);
const ORIGIN = "http://localhost:30000";
const ADA = "adaSession00000000000001";
const CY = "cySession000000000000001";
const NEW = "newSession00000000000001";
const STRANGER = "strangerSess000000000001";

const running = [];
afterEach(() => {
  for (const { server, dir } of running.splice(0)) {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function start({
  w = world(),
  limits: caps = {},
  model,
  probe,
  worldFn,
  library,
  cors = ORIGIN
} = {}) {
  const dir = tempDir("http");
  const log = quietLog();
  const state = { connected: true, worldOpen: true, world: "test-world", ballUser: "Crystal Ball" };
  const sessions = {
    [ADA]: "playerAda0000001",
    [CY]: "playerCy00000001",
    [NEW]: "playerNew0000001"
  };
  const link = {
    state: () => ({ ...state }),
    probe: vi.fn(async id => (probe ? probe(id) : sessions[id] ? { userId: sessions[id] } : null)),
    world: vi.fn(async opts => (worldFn ? worldFn(opts) : w))
  };
  const config = { ...CONFIG, limits: { ...CONFIG.limits, ...caps } };
  const limits = createLimits({ limits: config.limits });
  const ledger = createLedger(dir);
  const sittings = createSittings({ dir, turnsWindow: config.limits.sittingTurns });
  const server = createServer({
    basePath: "/crystalball",
    corsOrigin: cors,
    link,
    model: model ?? createModel({ config, log }),
    limits,
    ledger,
    sittings,
    config,
    version: "9.9.9",
    log,
    library
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  running.push({ server, dir });
  const port = server.address().port;
  return { port, state, link, log, ledger, sittings, limits, w, server };
}

/** A request with Node's own client: `{ status, headers, text, json }`. */
function call(port, route, { method = "GET", session, body, origin, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? null : JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route.startsWith("/") ? route : `/crystalball/${route}`,
        headers: {
          ...(session ? { "X-Foundry-Session": session } : {}),
          ...(origin ? { Origin: origin } : {}),
          ...(data !== null
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {})
        }
      },
      res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", c => {
          text += c;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

/** The events of an event stream, comments skipped. */
function events(text) {
  return text
    .split("\n\n")
    .filter(block => block.trim() && !block.startsWith(":"))
    .map(block => {
      const lines = block.split("\n");
      const event = lines.find(l => l.startsWith("event: "))?.slice(7);
      const data = lines
        .filter(l => l.startsWith("data: "))
        .map(l => l.slice(6))
        .join("\n");
      return { event, data: JSON.parse(data) };
    });
}

const chat = (port, message, extra = {}) =>
  call(port, "chat", { method: "POST", session: ADA, body: { message }, ...extra });

describe("healthz", () => {
  it("reports the version, the link, the model and the uptime, no secrets", async () => {
    const { port, link } = await start();
    const res = await call(port, "healthz");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json).toEqual({
      version: "9.9.9",
      foundry: { connected: true, worldOpen: true, world: "test-world", ballUser: "Crystal Ball" },
      model: "stub",
      uptimeSeconds: 0,
      timeZone: timeZone()
    });
    expect(link.probe).not.toHaveBeenCalled();
  });

  it("is 200 while Foundry is dark, and says so", async () => {
    const { port, state } = await start();
    state.connected = false;
    expect((await call(port, "healthz")).json.foundry.connected).toBe(false);
  });

  it("lives under the base path only", async () => {
    const { port } = await start();
    expect((await call(port, "/healthz")).status).toBe(404);
    expect((await call(port, "/crystalball/healthz/")).status).toBe(200);
  });
});

describe("CORS", () => {
  it("answers the configured origin and no other", async () => {
    const { port } = await start();
    expect(
      (await call(port, "healthz", { origin: ORIGIN })).headers["access-control-allow-origin"]
    ).toBe(ORIGIN);
    expect(
      (await call(port, "healthz", { origin: "https://elsewhere.test" })).headers[
        "access-control-allow-origin"
      ]
    ).toBeUndefined();
  });

  it("answers a preflight", async () => {
    const { port } = await start();
    const res = await call(port, "chat", { method: "OPTIONS", origin: ORIGIN });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-headers"]).toBe("Content-Type, X-Foundry-Session");
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
    const other = await call(port, "chat", { method: "OPTIONS", origin: "https://elsewhere.test" });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers each origin of a list, as it was given, and no other", async () => {
    const { port } = await start({
      cors: `${ORIGIN}, http://192.168.1.20:30000/ http://sandbox.local:30000`
    });
    for (const origin of [ORIGIN, "http://192.168.1.20:30000", "http://sandbox.local:30000"]) {
      const res = await call(port, "healthz", { origin });
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers.vary).toBe("Origin");
    }
    expect(
      (await call(port, "healthz", { origin: "http://192.168.1.21:30000" })).headers[
        "access-control-allow-origin"
      ]
    ).toBeUndefined();
  });

  it("answers any origin with * when told to, and a request with no Origin with nothing", async () => {
    const { port } = await start({ cors: "*" });
    expect(
      (await call(port, "healthz", { origin: "https://elsewhere.test" })).headers[
        "access-control-allow-origin"
      ]
    ).toBe("*");
    const pre = await call(port, "chat", {
      method: "OPTIONS",
      origin: "http://192.168.1.20:30000"
    });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("*");
    expect(pre.headers["access-control-allow-headers"]).toBe("Content-Type, X-Foundry-Session");
    expect((await call(port, "healthz")).headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("is off with no origin configured", async () => {
    const { port } = await start({ cors: "" });
    expect(
      (await call(port, "healthz", { origin: ORIGIN })).headers["access-control-allow-origin"]
    ).toBeUndefined();
  });
});

describe("parseCorsOrigins", () => {
  it("reads one origin, a list, any, and nothing", () => {
    expect(parseCorsOrigins("http://localhost:30000")).toEqual({
      any: false,
      origins: new Set(["http://localhost:30000"])
    });
    expect(parseCorsOrigins(" http://a:1/, http://b:2 ")).toEqual({
      any: false,
      origins: new Set(["http://a:1", "http://b:2"])
    });
    expect(parseCorsOrigins("*")).toEqual({ any: true, origins: new Set() });
    expect(parseCorsOrigins("http://a:1 *")).toEqual({
      any: true,
      origins: new Set(["http://a:1"])
    });
    expect(parseCorsOrigins("")).toEqual({ any: false, origins: new Set() });
    expect(parseCorsOrigins(undefined)).toEqual({ any: false, origins: new Set() });
  });
});

describe("the chain's refusals", () => {
  it("is 404 for an unknown path and 405 for a wrong method", async () => {
    const { port } = await start();
    expect(await call(port, "nothing")).toMatchObject({ status: 404, json: { error: "seer" } });
    expect((await call(port, "chat", { session: ADA })).status).toBe(405);
  });

  it("is 401 without a session, with a malformed one, or one Foundry does not know", async () => {
    const { port, link } = await start();
    expect(await call(port, "usage/me")).toMatchObject({
      status: 401,
      json: { error: "unknown-session" }
    });
    expect(await call(port, "usage/me", { session: "not a session" })).toMatchObject({
      status: 401
    });
    expect(await call(port, "usage/me", { session: STRANGER })).toMatchObject({
      status: 401,
      json: { error: "unknown-session" }
    });
    expect(link.probe).toHaveBeenCalledTimes(1);
  });

  it("is 503 while Foundry is disconnected, the world closed, or the probe fails", async () => {
    const a = await start();
    a.state.connected = false;
    expect(await call(a.port, "usage/me", { session: ADA })).toMatchObject({
      status: 503,
      json: { error: "dark", reason: "foundry-disconnected" }
    });
    a.state.connected = true;
    a.state.worldOpen = false;
    expect(await call(a.port, "usage/me", { session: ADA })).toMatchObject({
      status: 503,
      json: { error: "dark", reason: "world-closed" }
    });
    const b = await start({
      probe: () => {
        throw new Error("ECONNREFUSED");
      }
    });
    expect(
      await call(b.port, "chat", { method: "POST", session: ADA, body: { message: "hi" } })
    ).toMatchObject({
      status: 503,
      json: { error: "dark", reason: "foundry-disconnected" }
    });
  });

  it("is 403 when the module is disabled, inactive, or the user is not a listed asker", async () => {
    const off = world();
    off.settings.push({ key: "fvtt-mod-crystalball.enabled", user: null, value: "false" });
    expect(await call((await start({ w: off })).port, "usage/me", { session: ADA })).toMatchObject({
      status: 403,
      json: { error: "not-allowed" }
    });
    const inactive = world();
    inactive.modules.find(m => m.id === "fvtt-mod-crystalball").active = false;
    expect(
      (await call((await start({ w: inactive })).port, "usage/me", { session: ADA })).status
    ).toBe(403);
    const listed = world();
    listed.settings.push(
      { key: "fvtt-mod-crystalball.askers", user: null, value: '"listed"' },
      {
        key: "fvtt-mod-crystalball.askerIds",
        user: null,
        value: '" playerAda0000001 , someoneElse00001"'
      }
    );
    const { port } = await start({ w: listed });
    expect((await call(port, "usage/me", { session: CY })).status).toBe(403);
    expect((await call(port, "usage/me", { session: ADA })).status).toBe(200);
  });

  it("ignores a user's own copy of a world setting", async () => {
    const { port } = await start();
    expect((await call(port, "usage/me", { session: ADA })).status).toBe(200);
  });

  it("refetches the world for a user made since the last fetch", async () => {
    const fresh = world();
    fresh.users.push({ _id: "playerNew0000001", name: "Newcomer", role: 1 });
    const { port, link } = await start({ worldFn: opts => (opts?.fresh ? fresh : world()) });
    expect((await call(port, "usage/me", { session: NEW })).status).toBe(200);
    expect(link.world).toHaveBeenLastCalledWith({ fresh: true });
  });

  it("is 413 for a message over the limit or a body over 16 KB", async () => {
    const { port } = await start();
    expect(await chat(port, "x".repeat(4001))).toMatchObject({
      status: 413,
      json: { error: "too-long", limit: 4000 }
    });
    expect(await chat(port, "x".repeat(17 * 1024))).toMatchObject({
      status: 413,
      json: { error: "too-long", limit: 4000 }
    });
  });

  it("is 400 for a body that is not JSON or has no message", async () => {
    const { port } = await start();
    expect((await call(port, "chat", { method: "POST", session: ADA, raw: "{nope" })).status).toBe(
      400
    );
    expect(
      (await call(port, "chat", { method: "POST", session: ADA, body: { message: "  " } })).status
    ).toBe(400);
  });

  it("is 429 with its scope and wait when a cap is hit", async () => {
    const { port } = await start({ limits: { perUserHour: 1 } });
    expect((await chat(port, "first")).status).toBe(200);
    const res = await chat(port, "second");
    expect(res.status).toBe(429);
    expect(res.json).toMatchObject({ error: "limit", scope: "hour" });
    expect(res.json.retryAfter).toBeGreaterThan(3500);
  });

  it("is 429 for the table's month once the ledger says it is spent", async () => {
    const s = await start();
    s.limits.seed([{ at: new Date().toISOString(), userId: "someoneElse00001", cost: 30 }]);
    expect((await chat(s.port, "hi")).json).toMatchObject({ error: "limit", scope: "table-month" });
  });
});

describe("POST chat", () => {
  it("streams meta, the deltas and done, then keeps the turn and the ledger line", async () => {
    const s = await start();
    const res = await chat(s.port, "Where is the vault?");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    const evs = events(res.text);
    expect(evs[0].event).toBe("meta");
    expect(Object.keys(evs[0].data.layers)).toEqual(["instructions", "lore", "party", "own"]);
    expect(evs[0].data.model).toBe("stub");
    expect(evs[0].data.gazeTokens).toBe(
      Object.values(evs[0].data.layers).reduce((a, b) => a + b, 0)
    );
    const done = evs.at(-1);
    expect(done.event).toBe("done");
    const expected =
      'The Crystal Ball is clouded (stub). I see 4 shared pages, 2 clues, 2 party members\nand your character Ada Stone (Fighter 3). You asked: "Where is the vault?".';
    expect(done.data.text).toBe(expected);
    expect(
      evs
        .filter(e => e.event === "delta")
        .map(e => e.data.text)
        .join("")
    ).toBe(expected);
    expect(done.data.usage).toMatchObject({ cacheWrite: 0, cacheRead: 0 });
    expect(done.data.cost).toBe(0);
    expect(done.data.remaining).toEqual({ hour: 9, day: 39 });
    expect(done.data.stop).toBe("end_turn");

    const lines = s.ledger.read();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      userId: "playerAda0000001",
      userName: "Ada",
      model: "stub",
      cost: 0,
      stub: true
    });
    expect(Object.keys(lines[0].layers)).toEqual(["instructions", "lore", "party", "own"]);
    expect(lines[0].gazeTokens).toBe(evs[0].data.gazeTokens);
    expect(JSON.stringify(lines[0])).not.toContain("vault");

    const current = await call(s.port, "sittings/current", { session: ADA });
    expect(current.json.id).toBe(evs[0].data.sittingId);
    expect(current.json.turns.map(t => [t.role, t.text])).toEqual([
      ["user", "Where is the vault?"],
      ["ball", expected]
    ]);
    expect(current.json.usage).toEqual({ messages: 1, cost: 0 });
    expect(Object.keys(current.json)).toEqual(["id", "startedAt", "model", "turns", "usage"]);

    const usage = await call(s.port, "usage/me", { session: ADA });
    expect(usage.json).toEqual({
      user: { hour: 1, day: 1 },
      table: { day: { messages: 1, cost: 0 }, month: { messages: 1, cost: 0 } },
      limits: { perUserHour: 10, perUserDay: 40, tableDayUsd: 5, tableMonthUsd: 25 }
    });
    expect(JSON.stringify(s.log.lines)).not.toContain(ADA);
    expect(s.log.lines.some(l => /^POST \/crystalball\/chat 200 \d+ms$/.test(l.message))).toBe(
      true
    );
  });

  it("gives the model the sitting so far, the new message last", async () => {
    const seen = [];
    const base = createModel({ config: CONFIG, log: quietLog() });
    const model = {
      id: "stub",
      stub: true,
      countGaze: base.countGaze,
      answer: args => {
        seen.push(args.messages);
        return base.answer(args);
      }
    };
    const { port } = await start({ model });
    await chat(port, "one");
    await chat(port, "two");
    expect(seen[1].map(m => m.role)).toEqual(["user", "assistant", "user"]);
    expect(seen[1].at(-1)).toEqual({ role: "user", content: "two" });
  });

  it("ends the stream with the contract's error when the model fails, and counts the call", async () => {
    const model = {
      id: "claude-opus-5-5",
      stub: false,
      countGaze: async layers => layers.reduce((s, l) => s + l.estTokens, 0),
      answer: async () => {
        throw Object.assign(new Error("overloaded"), { status: 529 });
      }
    };
    const s = await start({ model });
    const evs = events((await chat(s.port, "hi")).text);
    expect(evs.map(e => e.event)).toEqual(["meta", "error"]);
    expect(evs[1].data).toEqual({
      error: "dark",
      reason: "model",
      message: "the model call failed"
    });
    const lines = s.ledger.read();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "failed", cost: 0, userId: "playerAda0000001" });
    expect((await call(s.port, "sittings/current", { session: ADA })).json.turns).toEqual([]);
    expect((await call(s.port, "usage/me", { session: ADA })).json.user).toEqual({
      hour: 1,
      day: 1
    });
  });

  it("hands the model the table's rulebooks, streams each lookup and counts them in the ledger", async () => {
    const seen = {};
    const library = {
      desk: (_world, user, settings) => {
        seen.desk = { user: user._id, leave: settings.rulebookLeaveOut.length };
        return {
          books: ["Book One"],
          definitions: [{ name: "search_rulebooks" }],
          open: 1,
          run: async (block, onLookup) => {
            onLookup({ action: "read", name: "Fireball", book: "Book One" });
            return { content: `read ${block.input.id}` };
          }
        };
      }
    };
    const model = {
      id: "claude-opus-5-5",
      stub: false,
      countGaze: async () => 1,
      answer: async ({ tools, layers, onDelta }) => {
        seen.definitions = tools.definitions;
        seen.instructions = layers[0].text;
        seen.result = await tools.run({ name: "read_rulebook", input: { id: "b/f" } });
        onDelta("Level 3.");
        return {
          text: "Level 3.",
          usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1 },
          cost: 0.001,
          model: "claude-opus-5-5",
          stopReason: "end_turn",
          lookups: 1
        };
      }
    };
    const s = await start({ model, library });
    const evs = events((await chat(s.port, "What does Fireball do?")).text);
    expect(evs.map(e => e.event)).toEqual(["meta", "lookup", "delta", "done"]);
    expect(evs[1].data).toEqual({ action: "read", name: "Fireball", book: "Book One" });
    expect(seen.desk.user).toBe("playerAda0000001");
    expect(seen.definitions).toEqual([{ name: "search_rulebooks" }]);
    expect(seen.instructions).toContain("this table plays from: Book One.");
    expect(seen.result).toEqual({ content: "read b/f" });
    expect(s.ledger.read()[0]).toMatchObject({ outcome: "done", lookups: 1 });
  });

  it("gives the model no tools and the ledger no lookups when the table has no rulebooks", async () => {
    let given = "unset";
    const base = createModel({ config: CONFIG, log: quietLog() });
    const model = {
      ...base,
      id: "stub",
      stub: true,
      countGaze: base.countGaze,
      answer: args => {
        given = args.tools;
        return base.answer(args);
      }
    };
    const s = await start({ model, library: { desk: () => null } });
    await chat(s.port, "hi");
    expect(given).toBeNull();
    expect("lookups" in s.ledger.read()[0]).toBe(false);
  });

  it("aborts the model call when the client leaves, counts what it spent, and keeps no turn", async () => {
    let aborted = false;
    const model = {
      id: "claude-opus-5-5",
      stub: false,
      countGaze: async () => 1,
      answer: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            const spend = {
              usage: { input: 9000, cacheWrite: 0, cacheRead: 0, output: 20 },
              cost: 0.0364,
              model: "claude-opus-5-5",
              estimated: true
            };
            reject(Object.assign(signal.reason, { spend }));
          });
        })
    };
    const s = await start({ model });
    await new Promise((resolve, reject) => {
      const data = JSON.stringify({ message: "hi" });
      const req = http.request(
        {
          host: "127.0.0.1",
          port: s.port,
          method: "POST",
          path: "/crystalball/chat",
          headers: {
            "X-Foundry-Session": ADA,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data)
          }
        },
        res => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        }
      );
      req.on("error", () => {});
      req.on("close", resolve);
      req.write(data);
      req.end();
      setTimeout(() => reject(new Error("no meta")), 2000);
    });
    await until(() => aborted);
    await until(() => s.log.lines.some(l => /the client left/.test(l.message)));
    const lines = s.ledger.read();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      outcome: "aborted",
      cost: 0.0364,
      estimated: true,
      usage: { input: 9000, output: 20 }
    });
    expect((await call(s.port, "sittings/current", { session: ADA })).json.turns).toEqual([]);
    const usage = (await call(s.port, "usage/me", { session: ADA })).json;
    expect(usage.user).toEqual({ hour: 1, day: 1 });
    expect(usage.table.day.cost).toBeCloseTo(0.0364, 10);
  });

  it("asks the model nothing when the client leaves first, and counts nothing", async () => {
    let release;
    const gate = new Promise(r => {
      release = r;
    });
    const answer = vi.fn();
    const model = { id: "claude-opus-5-5", stub: false, countGaze: () => gate, answer };
    const s = await start({ model });
    await new Promise(resolve => {
      const data = JSON.stringify({ message: "hi" });
      const req = http.request({
        host: "127.0.0.1",
        port: s.port,
        method: "POST",
        path: "/crystalball/chat",
        headers: {
          "X-Foundry-Session": ADA,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data)
        }
      });
      req.on("error", () => {});
      req.write(data);
      req.end(() =>
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 50)
      );
    });
    await new Promise(r => setTimeout(r, 50));
    release(10);
    await until(() => s.log.lines.some(l => /before the model was asked/.test(l.message)));
    expect(answer).not.toHaveBeenCalled();
    expect(s.ledger.read()).toEqual([]);
    expect((await call(s.port, "usage/me", { session: ADA })).json.user).toEqual({
      hour: 0,
      day: 0
    });
  });

  it("still answers when the ledger cannot be written, and says so in the log", async () => {
    const s = await start();
    s.ledger.append = () => {
      throw new Error("ENOSPC");
    };
    const evs = events((await chat(s.port, "hi")).text);
    expect(evs.at(-1).event).toBe("done");
    expect(s.log.lines.some(l => l.level === "error" && /ledger/.test(l.message))).toBe(true);
    expect((await call(s.port, "usage/me", { session: ADA })).json.user.hour).toBe(1);
  });
});

describe("a hostile or broken request", () => {
  it("answers 400 to a request target the URL parser refuses, and keeps serving", async () => {
    const { port } = await start();
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          [
            "GET http://a:99999/crystalball/healthz HTTP/1.1",
            "Host: a",
            "Connection: close",
            "",
            ""
          ].join("\r\n")
        );
      });
      let text = "";
      socket.on("data", c => {
        text += c;
      });
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    expect(reply.startsWith("HTTP/1.1 400")).toBe(true);
    expect((await call(port, "healthz")).status).toBe(200);
  });

  it("is 503 dark when the world fetch fails mid-request", async () => {
    const { port } = await start({
      worldFn: () => {
        throw new Error("the socket dropped");
      }
    });
    expect(await call(port, "usage/me", { session: ADA })).toMatchObject({
      status: 503,
      json: { error: "dark" }
    });
  });

  it("is 403 for a banned user on a live session", async () => {
    const w = world();
    w.users.find(u => u._id === "playerAda0000001").role = 0;
    expect((await call((await start({ w })).port, "usage/me", { session: ADA })).status).toBe(403);
  });

  it("keeps idle connections open longer than a tunnel's pool", async () => {
    const s = await start();
    expect(KEEP_ALIVE_MS).toBeGreaterThan(90000);
    expect(s.server.keepAliveTimeout).toBe(KEEP_ALIVE_MS);
    expect(s.server.headersTimeout).toBeGreaterThan(KEEP_ALIVE_MS);
  });
});

describe("POST sittings/new", () => {
  it("closes the open sitting and opens a fresh one", async () => {
    const { port } = await start();
    await chat(port, "hi");
    const before = (await call(port, "sittings/current", { session: ADA })).json;
    const res = await call(port, "sittings/new", { method: "POST", session: ADA });
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(["id", "startedAt"]);
    expect(res.json.id).not.toBe(before.id);
    const after = (await call(port, "sittings/current", { session: ADA })).json;
    expect(after.id).toBe(res.json.id);
    expect(after.turns).toEqual([]);
  });
});

describe("the SSE writer", () => {
  const fakeRes = () => ({
    destroyed: false,
    writes: [],
    headers: null,
    write(t) {
      this.writes.push(t);
    },
    writeHead(s, h) {
      this.headers = { status: s, ...h };
    },
    end: vi.fn()
  });

  it("writes event and data lines with the contract's headers", () => {
    const res = fakeRes();
    const sse = createSse(res);
    sse.open({ "Access-Control-Allow-Origin": ORIGIN });
    sse.send("delta", { text: "two\nlines" });
    sse.close();
    expect(res.headers).toMatchObject({
      status: 200,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": ORIGIN
    });
    expect(res.writes).toEqual(['event: delta\ndata: {"text":"two\\nlines"}\n\n']);
    expect(res.end).toHaveBeenCalledTimes(1);
    sse.send("delta", { text: "late" });
    sse.close();
    expect(res.writes).toHaveLength(1);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("sends a heartbeat comment every 15 seconds until closed", () => {
    vi.useFakeTimers();
    try {
      const res = fakeRes();
      const sse = createSse(res);
      sse.open();
      expect(HEARTBEAT_MS).toBe(15000);
      vi.advanceTimersByTime(14999);
      expect(res.writes).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(res.writes).toEqual([": keep-alive\n\n"]);
      vi.advanceTimersByTime(15000);
      expect(res.writes).toHaveLength(2);
      sse.close();
      vi.advanceTimersByTime(60000);
      expect(res.writes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("normaliseBase", () => {
  it("keeps one leading slash and no trailing one, or nothing", () => {
    expect(normaliseBase("/crystalball")).toBe("/crystalball");
    expect(normaliseBase("crystalball/")).toBe("/crystalball");
    expect(normaliseBase("/")).toBe("");
    expect(normaliseBase("")).toBe("");
    expect(normaliseBase(undefined)).toBe("");
  });
});
