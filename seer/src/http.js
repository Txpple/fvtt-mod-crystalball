/**
 * The Seer's HTTP API, plain `node:http`: the contract's endpoints under BASE_PATH, CORS for the
 * one configured origin, JSON errors with the contract's bodies, and `POST chat` as Server-Sent
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
        "Cache-Control": "no-cache",
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
  now = () => new Date(),
  heartbeatMs = HEARTBEAT_MS,
  logEnabled = () => false
}) {
  const base = normaliseBase(basePath);
  const startedAt = Date.now();
  const tooLong = () =>
    new HttpError(413, { error: "too-long", limit: config.limits.messageChars });

  const corsFor = req =>
    corsOrigin && req.headers.origin === corsOrigin
      ? { "Access-Control-Allow-Origin": corsOrigin, Vary: "Origin" }
      : {};

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
    let world = await link.world();
    // A user made in the last minute is not in a cached payload yet.
    if (world && !world.users?.some(u => u._id === who.userId))
      world = await link.world({ fresh: true });
    if (!world) throw dark(link.state().connected ? "world-closed" : "foundry-disconnected");
    const user = (world.users ?? []).find(u => u._id === who.userId);
    if (!user) throw unknownSession();
    ctx.userId = user._id;
    const settings = moduleSettings(world);
    if (!moduleActive(world) || !settings.enabled || !mayAsk(settings, user)) throw notAllowed();
    return { user, world, settings };
  }

  async function chat(req, res, ctx, cors) {
    const body = await readJson(req, { limit: BODY_LIMIT, tooLong });
    const message = typeof body?.message === "string" ? body.message : "";
    if (!message.trim()) throw new HttpError(400, { error: "seer", message: "no message" });
    const { user, world, settings } = await identify(req, ctx);
    const refusal = limits.check(user._id, message);
    if (refusal) throw new HttpError(refusal.status, refusal.body);

    const ticket = limits.reserve(user._id);
    let settled = false;
    try {
      const gaze = buildGaze(world, user._id, settings, {
        budgetTokens: config.limits.gazeBudgetTokens,
        warn: (m, f) => log.warn(m, f)
      });
      const sitting = sittings.current(user._id, { model: model.id });
      const messages = [
        ...sittings
          .history(sitting)
          .map(t => ({ role: t.role === "user" ? "user" : "assistant", content: t.text })),
        { role: "user", content: message }
      ];
      const gazeTokens = await model.countGaze(gaze.layers);
      const controller = new AbortController();
      let gone = false;
      res.on("close", () => {
        if (!res.writableEnded) {
          gone = true;
          controller.abort(new Error("the client left"));
        }
      });

      const sse = createSse(res, { heartbeatMs });
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
      let result;
      try {
        result = await model.answer({
          layers: gaze.layers,
          messages,
          meta: gaze.meta,
          message,
          signal: controller.signal,
          onDelta: text => sse.send("delta", { text })
        });
      } catch (err) {
        if (gone) {
          log.info("chat: the client left; the model call was aborted", { userId: user._id });
          return;
        }
        log.error("chat: the model call failed", {
          userId: user._id,
          status: err?.status,
          error: err?.message
        });
        sse.send("error", { error: "dark", reason: "model", message: "the model call failed" });
        sse.close();
        return;
      }

      const latencyMs = Date.now() - t0;
      ledger.append({
        at: at.toISOString(),
        userId: user._id,
        userName: user.name,
        model: result.model,
        usage: result.usage,
        cost: result.cost,
        gazeTokens,
        layers: Object.fromEntries(gaze.layers.map(l => [l.name, l.hash])),
        latencyMs,
        stub: Boolean(model.stub)
      });
      limits.commit(ticket, result.cost);
      settled = true;
      if (logEnabled("debug")) {
        log.debug("chat: answered", {
          userId: user._id,
          usage: result.usage,
          cost: result.cost,
          latencyMs,
          stop: result.stopReason
        });
      }
      // The contract: a turn is stored only when `done` is sent; a client that left gets neither.
      if (gone) return;
      sittings.append(
        user._id,
        [
          { role: "user", text: message, at: at.toISOString() },
          { role: "ball", text: result.text, at: now().toISOString() }
        ],
        { cost: result.cost, model: result.model }
      );
      const { remaining } = limits.report(user._id);
      sse.send("done", { text: result.text, usage: result.usage, cost: result.cost, remaining });
      sse.close();
    } finally {
      if (!settled) limits.release(ticket);
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
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
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
    const pathname = new URL(req.url ?? "/", "http://seer").pathname.replace(/\/+$/, "");
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
  return server;
}
