import { afterEach, describe, expect, it } from "vitest";
import {
  createLink,
  findUser,
  foundryAddress,
  joinBody,
  parseJoinReply,
  reasonOf,
  SESSION_ID,
  sessionCookie,
  sessionHash,
  socketOptions
} from "../src/foundry.js";
import { FOUNDRY_BUILD, fakeIo, fixture, quietLog, until } from "./helpers.js";

const URL_ = "http://foundry.test:30000";
const COOKIE = "unjoinedSess0000000000001";
const ADA_SESSION = "adaSession00000000000001";
const PASSWORD = "not-a-real-password";

/**
 * Foundry 14.369 as the fixtures describe it, with switches a test can throw: the cookie GET
 * /join hands out, the sessions a restart forgot, the world closed, the join's reply.
 */
function fakeFoundry() {
  const f = {
    cookie: COOKIE,
    forgotten: new Set(),
    joined: new Set(),
    worldOpen: true,
    joinReply: fixture("join-reply"),
    posts: [],
    gets: 0,
    worldPayload: fixture("world"),
    packReply: () => ({ result: [] })
  };
  f.restart = () => {
    for (const c of [f.cookie, ...f.joined]) f.forgotten.add(c);
    f.joined.clear();
    f.cookie = `restartedSess${String(f.forgotten.size).padStart(12, "0")}`;
  };
  f.request = async (url, { method, headers, body }) => {
    if (method === "GET" && url === `${URL_}/join`) {
      f.gets++;
      const page = fixture("join-page");
      page.headers["set-cookie"] = [page.headers["set-cookie"][0].replace(COOKIE, f.cookie)];
      return page;
    }
    if (method === "POST" && url === `${URL_}/join`) {
      f.posts.push({ headers, body });
      if (f.joinReply.status === 200) f.joined.add(/session=([^;]*)/.exec(headers.Cookie)[1]);
      return f.joinReply;
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  f.io = fakeIo(cookie => {
    if (f.forgotten.has(cookie)) return { session: null };
    if (cookie === f.cookie || f.joined.has(cookie)) {
      const unjoined = { ...fixture("session-unjoined"), sessionId: cookie };
      if (!f.worldOpen) return { session: unjoined, joinData: {} };
      if (!f.joined.has(cookie)) return { session: unjoined, joinData: fixture("join-data") };
      return {
        session: { ...fixture("session-joined"), sessionId: cookie },
        world: () => f.worldPayload,
        modifyDocument: request => f.packReply(request)
      };
    }
    if (cookie === ADA_SESSION)
      return { session: { sessionId: ADA_SESSION, userId: "playerAda0000001" } };
    if (cookie === "joinedNot000000000000001")
      return { session: { sessionId: "joinedNot000000000000001", userId: null } };
    return { session: fixture("session-unknown") };
  });
  return f;
}

const links = [];
afterEach(() => {
  for (const l of links.splice(0)) l.stop();
});
function linkFor(f, extra = {}) {
  const log = quietLog();
  const link = createLink({
    url: URL_,
    user: "Crystal Ball",
    password: PASSWORD,
    log,
    io: f.io,
    request: f.request,
    minBackoffMs: 5,
    maxBackoffMs: 40,
    ...extra
  });
  links.push(link);
  return { link, log };
}

describe(`the ${FOUNDRY_BUILD} fixtures`, () => {
  it("are synthetic and say so", () => {
    expect(fixture("world").world.id).toBe("test-world");
    expect(fixture("join-data").world.id).toBe("test-world");
    for (const name of ["join-page", "join-data", "join-reply", "join-refused"])
      expect(fixture(name).comment).toMatch(/Synthetic/);
  });

  it("read the session cookie off GET /join", () => {
    expect(sessionCookie(fixture("join-page").headers)).toBe(COOKIE);
    expect(sessionCookie({})).toBeNull();
    expect(sessionCookie({ "set-cookie": "other=1; session=abc; Path=/" })).toBeNull();
    expect(sessionCookie({ "set-cookie": "session=abc; Path=/" })).toBe("abc");
  });

  it("read POST /join's success and refusal", () => {
    expect(parseJoinReply(fixture("join-reply"))).toEqual({
      ok: true,
      cookie: null,
      status: 200,
      message: ""
    });
    expect(parseJoinReply(fixture("join-refused"))).toMatchObject({
      ok: false,
      status: 401,
      message: "JOIN.ErrorInvalidPassword"
    });
  });

  it("name the join's fields as 14.369 does", () => {
    expect(joinBody("ballUser00000001", "pw")).toEqual({
      action: "join",
      userId: "ballUser00000001",
      password: "pw"
    });
  });

  it("carry the users getJoinData lists, without passwords", () => {
    const data = fixture("join-data");
    expect(data.users.every(u => !("password" in u))).toBe(true);
    expect(findUser(data.users, "Crystal Ball")?._id).toBe("ballUser00000001");
    expect(findUser(data.users, "crystal ball")?._id).toBe("ballUser00000001");
    expect(findUser(data.users, "ballUser00000001")?.name).toBe("Crystal Ball");
    expect(findUser(data.users, "Nobody")).toBeNull();
  });

  it("hold the session event's shapes", () => {
    expect(fixture("session-joined")).toEqual({ sessionId: COOKIE, userId: "ballUser00000001" });
    expect(fixture("session-unjoined").userId).toBeNull();
    expect(fixture("session-unknown")).toBeNull();
    expect(fixture("world").userId).toBe("ballUser00000001");
  });

  it("hold the shutdown event's shape", () => {
    expect(fixture("shutdown")).toEqual({ world: "test-world", userId: null });
  });
});

describe("the address and the socket", () => {
  it("finds the socket path under a route prefix", () => {
    expect(foundryAddress("http://localhost:30000")).toEqual({
      origin: "http://localhost:30000",
      base: "http://localhost:30000",
      socketPath: "/socket.io"
    });
    expect(foundryAddress("https://vtt.example.test/foundry/")).toEqual({
      origin: "https://vtt.example.test",
      base: "https://vtt.example.test/foundry",
      socketPath: "/foundry/socket.io"
    });
  });

  it("opens a websocket of its own with the cookie in the handshake", () => {
    expect(socketOptions("/socket.io", "abc")).toEqual({
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: { Cookie: "session=abc" },
      reconnection: false,
      forceNew: true,
      timeout: 10000
    });
  });

  it("accepts only a well-formed session id and hashes it", () => {
    expect(SESSION_ID.test(COOKIE)).toBe(true);
    for (const bad of ["", "short", "has space here 00000000", "a;b=c000000000", "x".repeat(65)])
      expect(SESSION_ID.test(bad)).toBe(false);
    expect(sessionHash("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the link", () => {
  it("joins as the ball's user and holds its socket", async () => {
    const f = fakeFoundry();
    const { link, log } = linkFor(f);
    expect(link.state()).toEqual({
      connected: false,
      worldOpen: false,
      world: null,
      ballUser: null
    });
    link.start();
    await until(() => link.state().connected);
    expect(link.state()).toEqual({
      connected: true,
      worldOpen: true,
      world: "test-world",
      ballUser: "Crystal Ball"
    });
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0].body).toEqual(joinBody("ballUser00000001", PASSWORD));
    expect(f.posts[0].headers).toEqual({
      Origin: URL_,
      "Sec-Fetch-Site": "same-origin",
      Cookie: `session=${COOKIE}`
    });
    const ball = f.io.sockets.at(-1);
    expect(ball.options.extraHeaders.Cookie).toBe(`session=${COOKIE}`);
    expect(f.io.sockets[0].disconnected).toBe(true);
    const logged = JSON.stringify(log.lines);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(COOKIE);
  });

  it("caches the world for a minute and refetches after", async () => {
    const f = fakeFoundry();
    let clock = 1_000_000;
    const { link } = linkFor(f, { now: () => clock });
    link.start();
    await until(() => link.state().connected);
    const ball = f.io.sockets.at(-1);
    await until(() => ball.emitted.includes("world"));
    const first = await link.world();
    expect(first.world.id).toBe("test-world");
    await link.world();
    expect(ball.emitted.filter(e => e === "world")).toHaveLength(1);
    clock += 61_000;
    await link.world();
    expect(ball.emitted.filter(e => e === "world")).toHaveLength(2);
    await link.world({ fresh: true });
    expect(ball.emitted.filter(e => e === "world")).toHaveLength(3);
  });

  it("reads a pack's documents with a get, as the client's own getDocuments asks", async () => {
    const f = fakeFoundry();
    f.packReply = request => ({ ...request, result: [{ _id: "a", name: "Fireball" }] });
    const { link } = linkFor(f);
    link.start();
    await until(() => link.state().connected);
    const docs = await link.packDocuments("book.spells", "Item");
    expect(docs).toEqual([{ _id: "a", name: "Fireball" }]);
    const ball = f.io.sockets.at(-1);
    expect(ball.requests.find(r => r.event === "modifyDocument").args).toEqual([
      { type: "Item", action: "get", operation: { pack: "book.spells", query: {} } }
    ]);
  });

  it("throws when Foundry answers a pack's get with an error, and when dark", async () => {
    const f = fakeFoundry();
    f.packReply = () => ({ result: [], error: { message: "no such pack" } });
    const { link } = linkFor(f);
    await expect(link.packDocuments("book.spells", "Item")).rejects.toThrow(/not connected/);
    link.start();
    await until(() => link.state().connected);
    await expect(link.packDocuments("book.spells", "Item")).rejects.toThrow(/no such pack/);
  });

  it("resumes a dropped socket on the same session when Foundry still holds it", async () => {
    const f = fakeFoundry();
    const { link } = linkFor(f);
    link.start();
    await until(() => link.state().connected);
    const before = f.io.sockets.length;
    f.io.sockets.at(-1).fire("disconnect", "transport close");
    expect(link.state().connected).toBe(false);
    await until(() => link.state().connected);
    expect(f.io.sockets.length).toBe(before + 1);
    expect(f.gets).toBe(1);
    expect(f.posts).toHaveLength(1);
  });

  it("joins again on a fresh session after a restart forgot the old one", async () => {
    const f = fakeFoundry();
    const { link } = linkFor(f);
    link.start();
    await until(() => link.state().connected);
    f.restart();
    f.io.sockets.at(-1).fire("disconnect", "transport close");
    await until(() => link.state().connected);
    expect(f.gets).toBe(2);
    expect(f.posts).toHaveLength(2);
    expect(f.posts[1].headers.Cookie).toBe(`session=${f.cookie}`);
    expect(f.io.sockets.at(-1).options.extraHeaders.Cookie).toBe(`session=${f.cookie}`);
  });

  it("fails fast when Foundry does not know the cookie it just handed out", async () => {
    const f = fakeFoundry();
    f.forgotten.add(COOKIE);
    const { link, log } = linkFor(f);
    link.start();
    await until(() => log.lines.some(l => /did not recognise/.test(l.fields?.error ?? "")), 500);
    expect(link.state().connected).toBe(false);
  });

  it("goes dark while the world is closed and backs off, doubling to its ceiling", async () => {
    const f = fakeFoundry();
    f.worldOpen = false;
    const { link, log } = linkFor(f);
    link.start();
    await until(() => log.lines.filter(l => l.message === "foundry: retrying").length >= 5, 3000);
    expect(link.state()).toMatchObject({ connected: false, worldOpen: false });
    const delays = log.lines.filter(l => l.message === "foundry: retrying").map(l => l.fields.inMs);
    expect(delays.slice(0, 5)).toEqual([5, 10, 20, 40, 40]);
    f.worldOpen = true;
    await until(() => link.state().connected, 3000);
  });

  it("leaves with the world when Foundry shuts it down and rejoins on a new socket", async () => {
    const f = fakeFoundry();
    const { link, log } = linkFor(f);
    link.start();
    await until(() => link.state().connected);
    const ball = f.io.sockets.at(-1);
    f.worldOpen = false;
    ball.fire("shutdown", fixture("shutdown"));
    expect(ball.disconnected).toBe(true);
    expect(link.state()).toMatchObject({ connected: false, worldOpen: false });
    await until(() => log.lines.some(l => /world-closed/.test(l.fields?.error ?? "")));
    expect(link.state().connected).toBe(false);
    f.worldOpen = true;
    await until(() => link.state().connected);
    const back = f.io.sockets.at(-1);
    expect(back).not.toBe(ball);
    expect(back.cookie).toBe(COOKIE);
    expect(f.posts).toHaveLength(1);
    expect(
      log.lines.some(l => l.message === "foundry: the world shut down; the ball leaves with it")
    ).toBe(true);
  });

  it("fails a world fetch at once when the world shuts down under it", async () => {
    const f = fakeFoundry();
    const { link } = linkFor(f);
    link.start();
    await until(() => link.state().connected);
    f.worldPayload = undefined;
    const pending = link.world({ fresh: true });
    f.io.sockets.at(-1).fire("shutdown", fixture("shutdown"));
    await expect(pending).rejects.toThrow(/dropped/);
  });

  it("goes dark when the world payload comes back empty", async () => {
    const f = fakeFoundry();
    const { link } = linkFor(f);
    link.start();
    await until(() => link.state().connected);
    f.worldPayload = {};
    expect(await link.world({ fresh: true })).toBeNull();
    expect(link.state().connected).toBe(false);
  });

  it("does not connect with a refused password, and never logs it", async () => {
    const f = fakeFoundry();
    f.joinReply = fixture("join-refused");
    const { link, log } = linkFor(f);
    link.start();
    await until(() => log.lines.some(l => /join refused \(401\)/.test(l.fields?.error ?? "")));
    expect(link.state().connected).toBe(false);
    expect(JSON.stringify(log.lines)).not.toContain(PASSWORD);
  });

  it("is dark when the ball's user is not in the world", async () => {
    const f = fakeFoundry();
    const { link, log } = linkFor(f, { user: "Someone Else" });
    link.start();
    await until(() => log.lines.some(l => /not in the world/.test(l.fields?.error ?? "")));
    expect(link.state().connected).toBe(false);
  });

  it("fails a world fetch at once when the socket drops under it", async () => {
    const f = fakeFoundry();
    const { link } = linkFor(f);
    link.start();
    await until(() => link.state().connected);
    f.worldPayload = undefined;
    const pending = link.world({ fresh: true });
    f.io.sockets.at(-1).fire("disconnect", "transport close");
    await expect(pending).rejects.toThrow(/dropped/);
  });

  it("answers no world while it is dark", async () => {
    const { link } = linkFor(fakeFoundry());
    expect(await link.world()).toBeNull();
  });
});

describe("the probe", () => {
  it("names the user of a joined session on a socket of its own, then disconnects", async () => {
    const f = fakeFoundry();
    const { link } = linkFor(f);
    expect(await link.probe(ADA_SESSION)).toEqual({ userId: "playerAda0000001" });
    const s = f.io.sockets.at(-1);
    expect(s.options.extraHeaders.Cookie).toBe(`session=${ADA_SESSION}`);
    expect(s.options.forceNew).toBe(true);
    expect(s.disconnected).toBe(true);
  });

  it("asks Foundry on every request, so a session that changed hands is seen at once", async () => {
    const f = fakeFoundry();
    const { link } = linkFor(f, { now: () => 0 });
    expect(await link.probe(ADA_SESSION)).toEqual({ userId: "playerAda0000001" });
    expect(await link.probe(ADA_SESSION)).toEqual({ userId: "playerAda0000001" });
    expect(f.io.sockets).toHaveLength(2);
  });

  it("remembers a refusal for thirty seconds on a monotonic clock", async () => {
    const f = fakeFoundry();
    let clock = 1000;
    const { link } = linkFor(f, { now: () => clock });
    expect(await link.probe("strangerSess000000000001")).toBeNull();
    expect(await link.probe("strangerSess000000000001")).toBeNull();
    expect(f.io.sockets).toHaveLength(1);
    clock += 29_000;
    await link.probe("strangerSess000000000001");
    expect(f.io.sockets).toHaveLength(1);
    clock += 2_000;
    await link.probe("strangerSess000000000001");
    expect(f.io.sockets).toHaveLength(2);
  });

  it("refuses a session Foundry knows but that has not joined the world", async () => {
    const { link } = linkFor(fakeFoundry());
    expect(await link.probe("joinedNot000000000000001")).toBeNull();
  });

  it("refuses a malformed id without asking Foundry", async () => {
    const f = fakeFoundry();
    const { link } = linkFor(f);
    expect(await link.probe("not a session")).toBeNull();
    expect(await link.probe(undefined)).toBeNull();
    expect(f.io.sockets).toHaveLength(0);
  });

  it("shares one probe between simultaneous requests for a session", async () => {
    const f = fakeFoundry();
    const { link } = linkFor(f);
    const [a, b] = await Promise.all([link.probe(ADA_SESSION), link.probe(ADA_SESSION)]);
    expect(a).toEqual(b);
    expect(f.io.sockets).toHaveLength(1);
  });

  it("throws when Foundry cannot be reached", async () => {
    const io = fakeIo(() => ({ connectError: "ECONNREFUSED" }));
    const link = createLink({
      url: URL_,
      user: "Crystal Ball",
      password: PASSWORD,
      log: quietLog(),
      io,
      request: async () => ({})
    });
    await expect(link.probe(ADA_SESSION)).rejects.toThrow("ECONNREFUSED");
  });
});

describe("reasonOf", () => {
  it("names the refusals an AggregateError hides behind its empty message", () => {
    const err = new AggregateError(
      [
        Object.assign(new Error("connect ECONNREFUSED ::1:30000"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:30000"), { code: "ECONNREFUSED" })
      ],
      ""
    );
    expect(reasonOf(err)).toBe(
      "connect ECONNREFUSED ::1:30000; connect ECONNREFUSED 127.0.0.1:30000"
    );
  });

  it("keeps a plain message, falls back to the code, then to a word", () => {
    expect(reasonOf(new Error("join refused (403)"))).toBe("join refused (403)");
    expect(reasonOf(Object.assign(new Error(""), { code: "ETIMEDOUT" }))).toBe("ETIMEDOUT");
    expect(reasonOf(undefined)).toBe("unknown error");
    expect(reasonOf("plain")).toBe("plain");
  });
});
