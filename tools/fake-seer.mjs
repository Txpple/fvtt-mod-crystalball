// A stand-in Seer for the live check while seer/ cannot run: the contract's healthz, sittings/current,
// sittings/new, usage/me and chat (docs/seer-contract.md), stub mode only, one in-memory sitting,
// CORS for one origin. It requires the X-Foundry-Session header and nothing more: it never asks
// Foundry whose the session is, so the stub's sentence says what the flags tell it. Never deployed.
//
//   node tools/fake-seer.mjs [--port 30002] [--origin http://localhost:30000]
//        [--name "<character>"] [--class "<Class> <Level>"] [--pages n] [--clues n] [--members n]
import http from "node:http";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const port = Number(arg("port", 30002));
const origin = arg("origin", "http://localhost:30000");
const gaze = { name: arg("name", null), cls: arg("class", ""), pages: arg("pages", "0"), clues: arg("clues", "0"), members: arg("members", "0") };
const limits = { perUserHour: 10, perUserDay: 40, tableDayUsd: 5, tableMonthUsd: 25 };
const started = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fresh = () => ({ id: `fake-${Date.now()}`, startedAt: new Date().toISOString(), model: "stub", turns: [], usage: { messages: 0, cost: 0 } });
let sitting = fresh();
let asked = 0;

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const bodyOf = req =>
  new Promise(resolve => {
    let s = "";
    req.on("data", c => (s += c));
    req.on("end", () => resolve(s));
  });

http
  .createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Foundry-Session");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const path = new URL(req.url, "http://fake").pathname.replace(/^\/crystalball(?=\/)/, "");
    console.log(`${req.method} ${path}${req.headers["x-foundry-session"] ? " (session)" : ""}`);
    if (path === "/healthz") {
      const up = Math.round((Date.now() - started) / 1000);
      return json(res, 200, { version: "0.1.0", foundry: { connected: true, worldOpen: true, counted: true, world: null, ballUser: null }, model: "stub", uptimeSeconds: up });
    }
    if (!req.headers["x-foundry-session"]) return json(res, 401, { error: "unknown-session" });
    if (req.method === "GET" && path === "/sittings/current") return json(res, 200, sitting);
    if (req.method === "POST" && path === "/sittings/new") {
      sitting = fresh();
      return json(res, 200, { id: sitting.id, startedAt: sitting.startedAt });
    }
    if (req.method === "GET" && path === "/usage/me") {
      const table = { messages: asked, cost: 0 };
      return json(res, 200, { user: { hour: asked, day: asked }, table: { day: table, month: table }, limits });
    }
    if (req.method !== "POST" || path !== "/chat") return json(res, 500, { error: "seer", message: "no such endpoint" });
    let message;
    try {
      message = String(JSON.parse(await bodyOf(req)).message ?? "");
    } catch {
      return json(res, 500, { error: "seer", message: "unreadable body" });
    }
    if (message.length > 4000) return json(res, 413, { error: "too-long", limit: 4000 });
    const who = gaze.name ? `your character ${gaze.name} (${gaze.cls})` : "no character";
    const text = `The Crystal Ball is clouded (stub). I see ${gaze.pages} shared pages, ${gaze.clues} clues, ${gaze.members} party members\nand ${who}. You asked: "${message}".`;
    let gone = false;
    res.on("close", () => (gone = true));
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    // Each event goes out in two writes, so the window's parser meets events split across chunks.
    const event = (name, data) => {
      const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      const cut = Math.ceil(frame.length / 2);
      res.write(frame.slice(0, cut));
      res.write(frame.slice(cut));
    };
    const tokens = Math.ceil(message.length / 4);
    event("meta", { sittingId: sitting.id, model: "stub", gazeTokens: 0, layers: { instructions: 0, lore: 0, party: 0, own: 0 } });
    for (let i = 0; i < text.length && !gone; i += 16) {
      // A heartbeat that is not JSON, mid-answer: the window must read past it.
      if (i === 32) res.write("event: ping\ndata: keep-alive\n\n");
      event("delta", { text: text.slice(i, i + 16) });
      await sleep(20);
    }
    if (gone) return;
    asked++;
    const at = new Date().toISOString();
    sitting.turns.push({ role: "user", text: message, at }, { role: "ball", text, at });
    sitting.usage.messages++;
    const usage = { input: tokens, cacheWrite: 0, cacheRead: 0, output: Math.ceil(text.length / 4) };
    event("done", { text, usage, cost: 0, remaining: { hour: limits.perUserHour - asked, day: limits.perUserDay - asked } });
    res.end();
  })
  .listen(port, "127.0.0.1", () => console.log(`fake Seer (stub) on http://localhost:${port}, CORS for ${origin}`));
