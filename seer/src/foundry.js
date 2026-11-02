/**
 * The Seer's link to Foundry (14.369, its server code read for every step): the ball's user
 * joined and connected on a socket of its own, the world payload it receives, and the probe that
 * tells whose a player's session is. The contract's *Foundry contracts the Seer depends on*.
 *
 * - **The ball's id**: a GET of `/join` (no cookie) hands back a fresh `session` cookie, and a
 *   socket on that cookie answers `getJoinData` with the world and its users. The `/join` page
 *   itself lists nobody on 14.369 (its user list is drawn client-side from the same event), so
 *   the event is the robust route. A socket without a known cookie gets no listeners at all.
 * - **Join**: `POST /join` with `{ action: "join", userId, password }` on that cookie. Foundry
 *   refuses a POST whose Origin is not its own (or whose Sec-Fetch-Site is not same-origin), so
 *   the request names Foundry's own origin.
 * - **The socket**: socket.io 4 with the cookie in the handshake; the server emits `session`
 *   `{ sessionId, userId }` (userId null when the session has not joined the running world, the
 *   whole thing null when the cookie is unknown). `world` answers the full payload, unfiltered.
 * - **The probe**: the same handshake with a player's session id, read `session`, disconnect.
 *
 * The Seer emits nothing else and writes nothing to Foundry. A session id is never logged: the
 * probe's short memo of refusals is keyed by its sha256.
 */

import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { io as socketIo } from "socket.io-client";

/** Foundry's session ids are random alphanumerics (24 on 14.369). */
export const SESSION_ID = /^[A-Za-z0-9]{8,64}$/;

export const sessionHash = id => createHash("sha256").update(String(id)).digest("hex");

/** An HTTP request with Node's own client: `{ status, headers, body }`; no redirect followed. */
export function httpRequest(
  url,
  { method = "GET", headers = {}, body = null, timeoutMs = 15000 } = {}
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    const data = body === null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const req = lib.request(
      target,
      {
        method,
        headers: {
          ...headers,
          ...(data !== null
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {})
        },
        timeout: timeoutMs
      },
      res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`${method} ${target.pathname}: timed out`)));
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

/** The `session` cookie a response sets, or null. */
export function sessionCookie(headers) {
  const set = headers?.["set-cookie"];
  for (const c of Array.isArray(set) ? set : set ? [set] : []) {
    const m = /^\s*session=([^;]*)/.exec(c);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** The join POST's body (14.367 renamed the field `userid` to `userId`). */
export const joinBody = (userId, password) => ({ action: "join", userId, password });

/** Whether a join reply is Foundry's success, with the cookie it set (if it set a new one). */
export function parseJoinReply(reply) {
  let body = null;
  try {
    body = JSON.parse(reply?.body ?? "");
  } catch {
    body = null;
  }
  const ok = reply?.status === 200 && body?.status === "success";
  return {
    ok,
    cookie: sessionCookie(reply?.headers),
    status: reply?.status ?? 0,
    message: ok ? "" : String(body?.message ?? reply?.body ?? "").slice(0, 120)
  };
}

/** The ball's user from the users list, by id, then exact name, then name ignoring case. */
export function findUser(users, wanted) {
  const list = Array.isArray(users) ? users : [];
  const w = String(wanted ?? "").trim();
  return (
    list.find(u => u?._id === w) ??
    list.find(u => u?.name === w) ??
    list.find(u => String(u?.name ?? "").toLowerCase() === w.toLowerCase()) ??
    null
  );
}

/** Where Foundry is: its origin, and the socket path under any route prefix it serves from. */
export function foundryAddress(url) {
  const u = new URL(url);
  const prefix = u.pathname.replace(/\/+$/, "");
  return { origin: u.origin, base: `${u.origin}${prefix}`, socketPath: `${prefix}/socket.io` };
}

/**
 * One socket per purpose: `forceNew` keeps socket.io from sharing one connection (and one
 * cookie) between the ball's socket and a probe; reconnection is the link's own, because every
 * reconnect needs its session checked again.
 */
export const socketOptions = (socketPath, sessionId) => ({
  path: socketPath,
  transports: ["websocket"],
  extraHeaders: { Cookie: `session=${sessionId}` },
  reconnection: false,
  forceNew: true,
  timeout: 10000
});

/** The next event of a name, or a rejection on a connect error or a timeout. */
function nextEvent(socket, event, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => done(new Error(`no "${event}" from Foundry within ${ms} ms`)),
      ms
    );
    const onEvent = value => done(null, value);
    const onError = err => done(new Error(`socket: ${err?.message ?? err}`));
    function done(err, value) {
      clearTimeout(timer);
      socket.off?.(event, onEvent);
      socket.off?.("connect_error", onError);
      if (err) reject(err);
      else resolve(value);
    }
    socket.once(event, onEvent);
    socket.once("connect_error", onError);
  });
}

/** An emit with an acknowledgement, or a rejection on a timeout. */
function ask(socket, event, ms) {
  return new Promise((resolve, reject) => {
    // A socket that drops (Foundry restarting) never answers: the ask fails at once, not at the
    // timeout, so a request waiting on it is told the ball is dark.
    const onDrop = reason =>
      done(new Error(`the socket dropped before "${event}" was answered: ${reason}`));
    const timer = setTimeout(() => done(new Error(`no answer to "${event}" within ${ms} ms`)), ms);
    function done(err, value) {
      clearTimeout(timer);
      socket.off?.("disconnect", onDrop);
      if (err) reject(err);
      else resolve(value);
    }
    socket.once("disconnect", onDrop);
    socket.emit(event, value => done(null, value));
  });
}

/** At most `size` tasks at once; the rest wait their turn. */
function limiter(size) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= size || !queue.length) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return task =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}

/**
 * The link.
 * @param {{ url: string, user: string, password: string, log: object, io?: Function,
 *   request?: Function, now?: () => number, worldTtlMs?: number, negativeTtlMs?: number,
 *   minBackoffMs?: number, maxBackoffMs?: number }} options  `now` is a monotonic clock in ms,
 *   so a wall-clock change never stretches or cuts a cache
 */
export function createLink({
  url,
  user,
  password,
  log,
  io = socketIo,
  request = httpRequest,
  now = () => performance.now(),
  worldTtlMs = 60000,
  negativeTtlMs = 30000,
  minBackoffMs = 1000,
  maxBackoffMs = 60000
}) {
  const where = foundryAddress(url);
  const state = { connected: false, worldOpen: false, world: null, ballUser: null };
  let socket = null;
  let cookie = null;
  let ballId = null;
  let backoff = minBackoffMs;
  let timer = null;
  let stopped = true;
  let running = false;
  let cache = { at: 0, data: null };
  let inflight = null;
  const memo = new Map();
  const probing = new Map();
  const probeSlot = limiter(4);
  const postHeaders = c => ({
    Origin: where.origin,
    "Sec-Fetch-Site": "same-origin",
    Cookie: `session=${c}`
  });

  const teardown = () => {
    const s = socket;
    socket = null;
    state.connected = false;
    cache = { at: 0, data: null };
    if (s) {
      s.removeAllListeners?.();
      s.disconnect();
    }
  };

  const schedule = reason => {
    if (stopped || timer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxBackoffMs);
    log.info("foundry: retrying", { inMs: delay, reason });
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delay);
    timer.unref?.();
  };

  /** The ball's socket on a cookie: resolves when Foundry names the ball's user on it. */
  async function openSocket(c) {
    const s = io(where.origin, socketOptions(where.socketPath, c));
    try {
      const session = await nextEvent(s, "session", 10000);
      if (!session?.userId || (ballId && session.userId !== ballId)) {
        s.disconnect();
        return null;
      }
      return s;
    } catch (err) {
      s.disconnect();
      throw err;
    }
  }

  /** The world and its users from a fresh, unjoined session; the cookie comes with it. */
  async function joinData() {
    const page = await request(`${where.base}/join`, {
      method: "GET",
      headers: { Origin: where.origin }
    });
    const fresh = sessionCookie(page.headers);
    if (!fresh) throw new Error(`GET /join answered ${page.status} without a session cookie`);
    const s = io(where.origin, socketOptions(where.socketPath, fresh));
    try {
      // A socket on a cookie Foundry does not know gets no listeners, so no answer would come.
      if (!(await nextEvent(s, "session", 10000)))
        throw new Error("Foundry did not recognise its own fresh session");
      return { cookie: fresh, data: await ask(s, "getJoinData", 10000) };
    } finally {
      s.disconnect();
    }
  }

  async function connectOnce() {
    // A dropped socket on a session Foundry still holds (no restart in between) resumes as is.
    let s = cookie ? await openSocket(cookie).catch(() => null) : null;
    if (!s) {
      const { cookie: fresh, data } = await joinData();
      if (!data?.world) {
        state.worldOpen = false;
        state.world = null;
        throw new Error("world-closed: Foundry has no world running");
      }
      state.world = data.world.id ?? null;
      const found = findUser(data.users, user);
      if (!found) throw new Error(`the ball's user "${user}" is not in the world`);
      ballId = found._id;
      state.ballUser = found.name ?? null;
      const reply = parseJoinReply(
        await request(`${where.base}/join`, {
          method: "POST",
          headers: postHeaders(fresh),
          body: joinBody(ballId, password)
        })
      );
      if (!reply.ok)
        throw new Error(`join refused (${reply.status}): ${reply.message || "no reason"}`);
      cookie = reply.cookie ?? fresh;
      s = await openSocket(cookie);
      if (!s) throw new Error("the joined session was not recognised on the socket");
    }
    socket = s;
    state.connected = true;
    state.worldOpen = true;
    backoff = minBackoffMs;
    s.on("disconnect", reason => {
      if (socket !== s) return;
      log.warn("foundry: the ball's socket dropped", { reason: String(reason) });
      teardown();
      schedule(`disconnected: ${reason}`);
    });
    log.info("foundry: connected", { world: state.world, ballUser: state.ballUser });
    await fetchWorld().catch(err =>
      log.warn("foundry: first world fetch failed", { error: err.message })
    );
  }

  async function run() {
    if (stopped || running) return;
    running = true;
    try {
      await connectOnce();
    } catch (err) {
      teardown();
      if (/world-closed/.test(err?.message ?? "")) state.worldOpen = false;
      log.warn("foundry: not connected", { error: err?.message ?? String(err) });
      schedule(err?.message ?? "error");
    } finally {
      running = false;
    }
  }

  async function fetchWorld() {
    const s = socket;
    if (!s) return null;
    const data = await ask(s, "world", 30000);
    if (socket !== s) return null;
    if (!data?.userId) {
      // `{}` answers a session that no longer belongs to the running world: closed or restarted.
      state.worldOpen = false;
      teardown();
      schedule("world payload empty");
      return null;
    }
    cache = { at: now(), data };
    state.world = data.world?.id ?? state.world;
    state.worldOpen = true;
    return data;
  }

  async function probeOnce(sessionId) {
    const s = io(where.origin, socketOptions(where.socketPath, sessionId));
    try {
      const session = await nextEvent(s, "session", 8000);
      return session?.userId ? { userId: session.userId } : null;
    } finally {
      s.disconnect();
    }
  }

  return {
    start() {
      stopped = false;
      void run();
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      teardown();
    },

    /** What healthz reports. */
    state: () => ({
      connected: state.connected,
      worldOpen: state.connected && state.worldOpen,
      world: state.world,
      ballUser: state.ballUser
    }),

    /**
     * The world payload, refetched when the cached one is older than the TTL (or `fresh` asks);
     * null when dark. Phase 2 may follow `modifyDocument` broadcasts instead of refetching.
     */
    async world({ fresh = false } = {}) {
      if (!socket) return null;
      if (!fresh && cache.data && now() - cache.at < worldTtlMs) return cache.data;
      if (!inflight) {
        inflight = fetchWorld().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },

    /**
     * Whose session this is: `{ userId }`, or null when Foundry does not know it or it has not
     * joined the world. Asked of Foundry on every request: Foundry keeps a browser's session id
     * across a logout and binds it to whoever logs in next, so a remembered answer could hand one
     * player another's gaze, sitting and allowance. Only a refusal is remembered, thirty seconds
     * under the id's hash (a stranger's flood costs few sockets; a player who joins a moment later
     * waits little). Throws when Foundry cannot be reached.
     */
    async probe(sessionId) {
      if (!SESSION_ID.test(String(sessionId ?? ""))) return null;
      const key = sessionHash(sessionId);
      const refusedUntil = memo.get(key);
      if (refusedUntil !== undefined && now() < refusedUntil) return null;
      memo.delete(key);
      if (probing.has(key)) return probing.get(key);
      const p = probeSlot(() => probeOnce(sessionId))
        .then(result => {
          if (!result) {
            memo.set(key, now() + negativeTtlMs);
            // A stranger sending random ids cannot grow the memo without bound.
            while (memo.size > 1000) memo.delete(memo.keys().next().value);
          }
          return result;
        })
        .finally(() => probing.delete(key));
      probing.set(key, p);
      return p;
    }
  };
}
