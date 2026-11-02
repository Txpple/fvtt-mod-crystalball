/**
 * What the Seer's tests share: the fixtures of the Foundry build the Seer is verified on, a
 * silent logger that keeps what it was told, and a fake socket.io that answers as Foundry 14.369
 * does (the `session` event on connect, acknowledgements for `getJoinData` and `world`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FOUNDRY_BUILD = "14.369";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A fixture, parsed fresh each time (tests may change their copy). */
export const fixture = name =>
  JSON.parse(fs.readFileSync(path.join(here, "fixtures", FOUNDRY_BUILD, `${name}.json`), "utf8"));

export const world = () => fixture("world");

/** A logger that prints nothing and keeps every line. */
export function quietLog() {
  const lines = [];
  const at = level => (message, fields) => lines.push({ level, message, fields });
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** A temporary directory under the OS's own, removed by the caller. */
export const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), `crystalball-${prefix}-`));

/**
 * A fake socket.io client. `behave(sessionId)` decides what Foundry says to a socket opened on a
 * cookie: `{ session, joinData, world }` (each a value, or a function of nothing), or
 * `{ connectError }`.
 */
export function fakeIo(behave) {
  const sockets = [];
  const io = (origin, options) => {
    const cookie = /session=([^;]*)/.exec(options?.extraHeaders?.Cookie ?? "")?.[1] ?? null;
    const plan = behave(cookie) ?? {};
    const handlers = new Map();
    const add = (event, fn, once) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push({ fn, once });
    };
    const socket = {
      origin,
      options,
      cookie,
      connected: true,
      disconnected: false,
      emitted: [],
      on: (event, fn) => add(event, fn, false),
      once: (event, fn) => add(event, fn, true),
      off: (event, fn) =>
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter(h => h.fn !== fn)
        ),
      removeAllListeners: () => handlers.clear(),
      fire(event, ...args) {
        const list = handlers.get(event) ?? [];
        handlers.set(
          event,
          list.filter(h => !h.once)
        );
        for (const h of list) h.fn(...args);
      },
      emit(event, ack) {
        socket.emitted.push(event);
        const answer =
          event === "getJoinData" ? plan.joinData : event === "world" ? plan.world : undefined;
        if (answer === undefined) return;
        setImmediate(() => ack(typeof answer === "function" ? answer() : answer));
      },
      disconnect() {
        if (socket.disconnected) return;
        socket.disconnected = true;
        socket.connected = false;
      }
    };
    sockets.push(socket);
    setImmediate(() => {
      if (plan.connectError) socket.fire("connect_error", new Error(plan.connectError));
      else
        socket.fire("session", typeof plan.session === "function" ? plan.session() : plan.session);
    });
    return socket;
  };
  io.sockets = sockets;
  return io;
}

/** Wait until a condition holds (polling, never a fixed sleep), or fail after `ms`. */
export async function until(condition, ms = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 5));
  }
}
