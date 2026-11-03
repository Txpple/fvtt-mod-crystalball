/**
 * The Seer's HTTP API, plain `node:http`: the contract's endpoints under BASE_PATH, CORS for the
 * configured origins, JSON errors with the contract's bodies, and `POST chat` as Server-Sent
 * Events. Every user endpoint runs the same chain before it reads a word of the world:
 *
 *   the X-Foundry-Session header → the link is up → Foundry's probe names the user → the module
 *   is active and *Enabled* → *Who may ask* lets them → (chat) the limits → the gaze → the model →
 *   the ledger → the sitting
 *
 * Nothing here logs the session header; a request's log line names the user id the probe gave.
 */

import http from "node:http";
import { buildGaze } from "./gaze.js";
import { SESSION_ID } from "./foundry.js";
import { mayAsk, moduleActive, moduleSettings } from "./settings.js";

export const BODY_LIMIT = 16 * 1024;

export const HEARTBEAT_MS = 15000;

/** Above cloudflared's 90 s origin pool, so the Seer never closes a connection the tunnel reuses. */
export const KEEP_ALIVE_MS = 95000;

/**
 * The zone the limits' calendar days and months follow: the process's (TZ, else the box's).
 * `healthz` reports it, so the DM can see when a server's UTC would reset players' days mid-session.
 */
export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

/**
 * `CORS_ORIGIN` read: empty is CORS off (prod, one origin behind the tunnel); `*` is any origin
 * (a sandbox reached from other devices on the network, whose address the browser may give in
 * several ways); otherwise the origins listed, comma- or space-separated. Any origin opens
 * nothing: every endpoint but `healthz` wants the caller's own session id, which no other page
 * holds.
 * @param {string | undefined} value
 * @returns {{ any: boolean, origins: Set<string> }}
 */
export function parseCorsOrigins(value) {
  const words = String(value ?? "")
    .split(/[\s,]+/)
    .map(w => w.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return { any: words.includes("*"), origins: new Set(words.filter(w => w !== "*")) };
}

/** "/crystalball/" → "/crystalball"; "/" or "" → "" (no prefix). */
export function normaliseBase(basePath) {
  const trimmed = String(basePath ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** An error that is an HTTP answer: a status and the contract's body. */
export class HttpError extends Error {
  constructor(status, body) {
    super(body?.error ?? `http ${status}`);
    this.status = status;
    this.body = body;
  }
}

const dark = reason => new HttpError(503, { error: "dark", reason });

const unknownSession = () => new HttpError(401, { error: "unknown-session" });

const notAllowed = () => new HttpError(403, { error: "not-allowed" });

/**
 * A Server-Sent Events writer: `event:` and `data:` lines (the JSON never holds a raw newline, so
 * one data line an event), and a comment every `heartbeatMs` so a proxy or tunnel holding the
 * connection open while the model thinks does not take it for dead.
 */
export function createSse(res, { heartbeatMs = HEARTBEAT_MS } = {}) {
  let beat = null;
  let closed = false;
  const write = text => {
    if (!closed && !res.destroyed) res.write(text);
  };
  return {
    open(headers = {}) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        // no-transform: no edge may compress or rewrite the stream, which would hold the deltas.
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        Connection: "keep-alive",
        ...headers
      });
      res.flushHeaders?.();
      beat = setInterval(() => write(": keep-alive\n\n"), heartbeatMs);
      beat.unref?.();
    },
    send(event, data) {
      write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      write(`: ${String(text).replace(/[\r\n]+/g, " ")}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      if (!res.destroyed) res.end();
    },
    get closed() {
      return closed;
    }
  };
}

/** A request body as JSON, refused past the cap. */
function readJson(req, { limit, tooLong }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", chunk => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(tooLong());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, { error: "seer", message: "the body is not JSON" }));
      }
    });
    req.on("error", reject);
  });
}

/**
 * The server (not listening; main does that).
 * @param {{ basePath?: string, corsOrigin?: string, link: object, model: object, limits: object,
 *   ledger: object, sittings: object, config: object, version: string, log: object,
 *   now?: () => Date, heartbeatMs?: number, logEnabled?: (level: string) => boolean }} deps
 */
export function createServer({
  basePath = "/crystalball",
  corsOrigin = "",
  link,
  model,
  limits,
  ledger,
  sittings,
  config,
  version,
  log,
  library = null,
  now = () => new Date(),
  heartbeatMs = HEARTBEAT_MS,
  logEnabled = () => false
}) {
  const base = normaliseBase(basePath);
  const startedAt = Date.now();
  const tooLong = () =>
    new HttpError(413, { error: "too-long", limit: config.limits.messageChars });

  const allowed = parseCorsOrigins(corsOrigin);
  const corsFor = req => {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !origin) return {};
    if (allowed.any) return { "Access-Control-Allow-Origin": "*" };
    return allowed.origins.has(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};
  };

  const json = (res, status, body, cors) => {
    if (res.headersSent) return;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...cors
    });
    res.end(JSON.stringify(body));
  };

  /** The chain up to the user: who is asking, in which world, under which settings. */
  async function identify(req, ctx) {
    const sessionId = req.headers["x-foundry-session"];
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw unknownSession();
    const up = link.state();
    if (!up.connected) throw dark("foundry-disconnected");
    if (!up.worldOpen) throw dark("world-closed");
    let who;
    try {
      who = await link.probe(sessionId);
    } catch {
      throw dark("foundry-disconnected");
    }
    if (!who?.userId) throw unknownSession();
    const darkNow = () => dark(link.state().connected ? "world-closed" : "foundry-disconnected");
    let world;
    try {
      world = await link.world();
      // A user made in the last minute is not in a cached payload yet.
      if (world && !world.users?.some(u => u._id === who.userId))
        world = await link.world({ fresh: true });
    } catch {
      // The socket dropped mid-fetch (Foundry restarting): dark, not a server error.
      throw darkNow();
    }
    if (!world) throw darkNow();
    const user = (world.users ?? []).find(u => u._id === who.userId);
    if (!user) throw unknownSession();
    ctx.userId = user._id;
    const settings = moduleSettings(world);
    if (!moduleActive(world) || !settings.enabled || !mayAsk(settings, user)) throw notAllowed();
    return { user, world, settings };
  }

  async function chat(req, res, ctx, cors) {
    // Watched from the first byte, so a client that leaves while the Seer probes, fetches the
    // world or counts the gaze is never answered, and one that leaves mid-answer aborts the call.
    const controller = new AbortController();
    const left = () => controller.signal.aborted;
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new Error("the client left"));
    });
    const body = await readJson(req, { limit: BODY_LIMIT, tooLong });
    const message = typeof body?.message === "string" ? body.message : "";
    if (!message.trim()) throw new HttpError(400, { error: "seer", message: "no message" });
    const { user, world, settings } = await identify(req, ctx);
    const refusal = limits.check(user._id, message);
    if (refusal) throw new HttpError(refusal.status, refusal.body);

    const ticket = limits.reserve(user._id);
    let settled = false;
    let sse = null;
    let doneSent = false;
    try {
      // The table's rulebooks, when it opens any: named in the instructions, read through the
      // model's tools under the asker's view of each pack.
      const desk = library?.desk(world, user, settings) ?? null;
      const gaze = buildGaze(world, user._id, settings, {
        budgetTokens: config.limits.gazeBudgetTokens,
        warn: (m, f) => log.warn(m, f),
        books: desk?.books ?? [],
        model: model.id
      });
      const sitting = sittings.current(user._id, { model: model.id });
      const messages = [
        ...sittings
          .history(sitting)
          .map(t => ({ role: t.role === "user" ? "user" : "assistant", content: t.text })),
        { role: "user", content: message }
      ];
      const gazeTokens = await model.countGaze(gaze.layers);
      if (left() || res.destroyed) {
        log.info("chat: the client left before the model was asked", { userId: user._id });
        return;
      }

      sse = createSse(res, { heartbeatMs });
      sse.open(cors);
      ctx.sse = sse;
      const layerTokens = Object.fromEntries(gaze.layers.map(l => [l.name, l.estTokens]));
      sse.send("meta", { sittingId: sitting.id, model: model.id, gazeTokens, layers: layerTokens });
      if (logEnabled("debug"))
        log.debug("chat: gaze", {
          userId: user._id,
          gazeTokens,
          layers: layerTokens,
          meta: gaze.meta
        });

      const at = now();
      const t0 = Date.now();
      // Once the model is asked, every way out counts the call: the caps and the dollar
      // ceilings see what the API bills, whether the answer finished, failed or was abandoned.
      const record = (spend, outcome) => {
        limits.commit(ticket, spend.cost);
        settled = true;
        try {
          ledger.append({
            at: at.toISOString(),
            userId: user._id,
            userName: user.name,
            model: spend.model,
            usage: spend.usage,
            cost: spend.cost,
            gazeTokens,
            layers: Object.fromEntries(gaze.layers.map(l => [l.name, l.hash])),
            latencyMs: Date.now() - t0,
            stub: Boolean(model.stub),
            outcome,
            ...(spend.lookups ? { lookups: spend.lookups } : {}),
            ...(spend.estimated ? { estimated: true } : {})
          });
        } catch (err) {
          log.error(
            "ledger: the usage line could not be written; this call is counted until a restart only",
            {
              error: err?.message
            }
          );
        }
      };

      let result;
      try {
        result = await model.answer({
          layers: gaze.layers,
          messages,
          meta: gaze.meta,
          message,
          signal: controller.signal,
          onDelta: text => sse.send("delta", { text }),
          tools: desk
            ? {
                definitions: desk.definitions,
                run: block => desk.run(block, look => sse.send("lookup", look))
              }
            : null
        });
      } catch (err) {
        const spend = err?.spend ?? {
          usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
          cost: 0,
          model: model.id
        };
        if (left()) {
          record(spend, "aborted");
          log.info("chat: the client left; the model call was aborted", {
            userId: user._id,
            cost: spend.cost
          });
          return;
        }
        record(spend, "failed");
        log.error("chat: the model call failed", {
          userId: user._id,
          status: err?.status,
          error: err?.message,
          cost: spend.cost
        });
        sse.send("error", { error: "dark", reason: "model", message: "the model call failed" });
        return;
      }

      record(result, "done");
      if (logEnabled("debug")) {
        log.debug("chat: answered", {
          userId: user._id,
          usage: result.usage,
          cost: result.cost,
          latencyMs: Date.now() - t0,
          stop: result.stopReason,
          lookups: result.lookups ?? 0
        });
      }
      // The contract: a turn is stored only when `done` is sent; a client that left gets neither.
      if (left() || res.destroyed) return;
      const { remaining } = limits.report(user._id);
      sse.send("done", {
        text: result.text,
        usage: result.usage,
        cost: result.cost,
        remaining,
        stop: result.stopReason
      });
      doneSent = true;
      sittings.append(
        user._id,
        [
          { role: "user", text: message, at: at.toISOString() },
          { role: "ball", text: result.text, at: now().toISOString() }
        ],
        { cost: result.cost, model: result.model }
      );
    } catch (err) {
      if (!sse) throw err;
      // The stream is open: its last event is the contract's error event (unless `done` already
      // went, when the failure is only logged).
      log.error("chat: failed with the stream open", {
        userId: user._id,
        error: err?.message ?? String(err)
      });
      if (!doneSent) sse.send("error", { error: "seer", message: "internal error" });
    } finally {
      if (!settled) limits.release(ticket);
      // Every way out stops the heartbeat and ends the stream.
      sse?.close();
    }
  }

  const routes = {
    "GET healthz": async (_req, res, _ctx, cors) =>
      json(
        res,
        200,
        {
          version,
          foundry: link.state(),
          model: model.id,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          timeZone: timeZone()
        },
        cors
      ),

    "GET sittings/current": async (req, res, ctx, cors) => {
      const { user } = await identify(req, ctx);
      const s = sittings.current(user._id, { model: model.id });
      json(
        res,
        200,
        {
          id: s.id,
          startedAt: s.startedAt,
          model: s.model ?? model.id,
          turns: s.turns,
          usage: s.usage
        },
        cors
      );
    },

    "POST sittings/new": async (req, res, ctx, cors) => {
      const { user } = await identify(req, ctx);
      const s = sittings.startNew(user._id, { model: model.id });
      json(res, 200, { id: s.id, startedAt: s.startedAt }, cors);
    },

    "GET usage/me": async (req, res, ctx, cors) => {
      const { user } = await identify(req, ctx);
      const { user: mine, table, limits: caps } = limits.report(user._id);
      json(res, 200, { user: mine, table, limits: caps }, cors);
    },

    "POST chat": chat
  };
  const paths = new Set(Object.keys(routes).map(k => k.split(" ")[1]));

  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    const ctx = { userId: null, sse: null };
    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://seer").pathname.replace(/\/+$/, "");
    } catch {
      // An absolute-form target with a bad port and the like: the URL parser throws, and a
      // throw here would take the process (and every open stream) down.
      json(res, 400, { error: "seer", message: "bad request target" }, {});
      req.resume();
      return;
    }
    const route = base
      ? pathname.startsWith(`${base}/`)
        ? pathname.slice(base.length + 1)
        : null
      : pathname.slice(1);
    let logged = false;
    const logLine = () => {
      if (logged) return;
      logged = true;
      log.info(
        `${req.method} ${pathname || "/"} ${res.statusCode} ${Date.now() - t0}ms`,
        ctx.userId ? { userId: ctx.userId } : undefined
      );
    };
    res.on("finish", logLine);
    res.on("close", logLine);
    const cors = corsFor(req);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        ...(cors["Access-Control-Allow-Origin"]
          ? {
              "Access-Control-Allow-Headers": "Content-Type, X-Foundry-Session",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Max-Age": "600"
            }
          : {})
      });
      res.end();
      return;
    }

    const handler = route !== null ? routes[`${req.method} ${route}`] : null;
    if (!handler) {
      const known = route !== null && paths.has(route);
      json(
        res,
        known ? 405 : 404,
        { error: "seer", message: known ? "method not allowed" : "not found" },
        cors
      );
      req.resume();
      return;
    }

    handler(req, res, ctx, cors).catch(err => {
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader("Connection", "close");
        json(res, err.status, err.body, cors);
      } else {
        log.error("seer: request failed", { route, error: err?.message ?? String(err) });
        if (!res.headersSent) json(res, 500, { error: "seer", message: "internal error" }, cors);
        else if (ctx.sse) {
          // The stream was open: its last event is the contract's error event.
          ctx.sse.send("error", { error: "seer", message: "internal error" });
          ctx.sse.close();
        } else if (!res.writableEnded) res.end();
      }
      req.resume();
    });
  });
  // A tunnel or proxy pools its connections to the Seer (cloudflared for 90 s); Node's 5 s
  // default would close one under it, and the next POST on it would fail with a 502. The
  // headers timeout must stay above the keep-alive one.
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 5000;
  return server;
}
