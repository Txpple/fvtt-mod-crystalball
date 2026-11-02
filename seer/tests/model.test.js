import { describe, expect, it, vi } from "vitest";
import {
  cacheMarker,
  costOf,
  createModel,
  EMPTY_TEXT,
  FALLBACK_BETA,
  priceUsage,
  REFUSAL_TEXT,
  requestParams,
  stubAnswer,
  systemBlocks,
  usageOf
} from "../src/model.js";
import { quietLog } from "./helpers.js";

const CONFIG = {
  model: "claude-opus-5-5",
  effort: "low",
  maxOutputTokens: 2048,
  cacheTtl: "5m",
  refusalFallback: true,
  callTimeoutMs: 60000,
  prices: {
    "claude-opus-5-5": { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 },
    "claude-sonnet-5-5": {
      input: 2,
      cacheWrite5m: 2.5,
      cacheWrite1h: 4,
      cacheRead: 0.2,
      output: 10
    }
  }
};

const layers = ["instructions", "lore", "party", "own"].map(name => ({
  name,
  text: `${name} text`,
  hash: `${name}-hash`,
  estTokens: 3
}));
const messages = [{ role: "user", content: "What do we know?" }];

/**
 * A fake Anthropic client that records each call and streams what it is told to. `fail` throws
 * after the deltas when `failAfterDeltas`, else before any; `snapshot` is the stream's usage so far.
 */
function fakeClient({
  deltas = ["Hello", " there."],
  final = {},
  fail = null,
  failAfterDeltas = false,
  snapshot = null,
  count = 1234
} = {}) {
  const calls = { plain: [], beta: [], count: 0, countOptions: [] };
  const stream = (kind, params, options) => {
    calls[kind].push({ params, options });
    const handlers = {};
    return {
      currentMessage: snapshot ? { model: "claude-opus-5-5", usage: snapshot } : undefined,
      on(event, fn) {
        handlers[event] = fn;
        return this;
      },
      async finalMessage() {
        const f = typeof fail === "function" ? fail(kind) : fail;
        if (f && !failAfterDeltas) throw f;
        for (const d of deltas) handlers.text?.(d, "");
        if (f) throw f;
        return {
          model: "claude-opus-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: deltas.join("") }],
          usage: {
            input_tokens: 300,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 2000,
            output_tokens: 50
          },
          ...final
        };
      }
    };
  };
  return {
    calls,
    messages: {
      stream: (p, o) => stream("plain", p, o),
      countTokens: async (_params, options) => {
        calls.count++;
        calls.countOptions.push(options);
        if (count instanceof Error) throw count;
        return { input_tokens: count };
      }
    },
    beta: { messages: { stream: (p, o) => stream("beta", p, o) } }
  };
}

describe("the stub", () => {
  it("answers the contract's sentence, its line break included", () => {
    const meta = {
      sharedPages: 12,
      clues: 31,
      members: 4,
      characterName: "Ada Stone",
      className: "Fighter",
      level: 5
    };
    expect(stubAnswer(meta, "What do we know about the bent key?")).toBe(
      'The Crystal Ball is clouded (stub). I see 12 shared pages, 31 clues, 4 party members\nand your character Ada Stone (Fighter 5). You asked: "What do we know about the bent key?".'
    );
  });

  it('says "no character" when the asker has none', () => {
    const meta = {
      sharedPages: 23,
      clues: 0,
      members: 0,
      characterName: null,
      className: null,
      level: null
    };
    expect(stubAnswer(meta, "hi")).toBe(
      'The Crystal Ball is clouded (stub). I see 23 shared pages, 0 clues, 0 party members\nand no character. You asked: "hi".'
    );
  });

  it("is the model without a key, streams the sentence in pieces and costs nothing", async () => {
    const model = createModel({ config: CONFIG, log: quietLog() });
    expect(model.id).toBe("stub");
    expect(model.stub).toBe(true);
    const pieces = [];
    const meta = {
      sharedPages: 1,
      clues: 2,
      members: 3,
      characterName: "Ada",
      className: "Fighter",
      level: 3
    };
    const result = await model.answer({
      layers,
      messages,
      meta,
      message: "What do we know?",
      onDelta: p => pieces.push(p)
    });
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.join("")).toBe(result.text);
    expect(result.text).toBe(stubAnswer(meta, "What do we know?"));
    const chars = layers.reduce((s, l) => s + l.text.length, 0) + "What do we know?".length;
    expect(result.usage).toEqual({
      input: Math.ceil(chars / 4),
      cacheWrite: 0,
      cacheRead: 0,
      output: Math.ceil(result.text.length / 4)
    });
    expect(result.cost).toBe(0);
    expect(result.model).toBe("stub");
  });

  it("is forced by MODEL_STUB even with a key, and counts the gaze by estimate", async () => {
    const model = createModel({ apiKey: "a key", stub: true, config: CONFIG, log: quietLog() });
    expect(model.id).toBe("stub");
    expect(await model.countGaze(layers)).toBe(12);
  });

  it("stops when the client has left", async () => {
    const model = createModel({ config: CONFIG, log: quietLog() });
    const signal = AbortSignal.abort(new Error("gone"));
    await expect(
      model.answer({ layers, messages, meta: {}, message: "x", onDelta: () => {}, signal })
    ).rejects.toThrow("gone");
  });
});

describe("the request", () => {
  it("puts the gaze in four system blocks, a cache marker on the first three", () => {
    const blocks = systemBlocks(layers, "5m");
    expect(blocks.map(b => b.text)).toEqual(layers.map(l => l.text));
    expect(
      blocks.slice(0, 3).every(b => b.type === "text" && b.cache_control?.type === "ephemeral")
    ).toBe(true);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[3].cache_control).toBeUndefined();
  });

  it("asks for top-level automatic caching, low effort, the output cap and no thinking", () => {
    const p = requestParams(CONFIG, layers, messages);
    expect(p).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 2048,
      system: systemBlocks(layers, "5m"),
      messages,
      cache_control: { type: "ephemeral" },
      output_config: { effort: "low" }
    });
    expect("thinking" in p).toBe(false);
    expect(p.messages.at(-1).role).toBe("user");
  });

  it("sets the hour TTL on every marker when configured", () => {
    const p = requestParams({ ...CONFIG, cacheTtl: "1h" }, layers, messages);
    expect(cacheMarker("1h")).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(p.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(p.system.slice(0, 3).map(b => b.cache_control)).toEqual(
      Array(3).fill({ type: "ephemeral", ttl: "1h" })
    );
  });
});

describe("a real call (a fake client)", () => {
  it("goes through the beta client with the server-side fallback, streaming each delta", async () => {
    const client = fakeClient();
    const model = createModel({ config: CONFIG, log: quietLog(), client });
    const pieces = [];
    const controller = new AbortController();
    const result = await model.answer({
      layers,
      messages,
      meta: {},
      message: "x",
      onDelta: p => pieces.push(p),
      signal: controller.signal
    });
    expect(client.calls.plain).toHaveLength(0);
    const { params, options } = client.calls.beta[0];
    expect(params.betas).toEqual([FALLBACK_BETA]);
    expect(FALLBACK_BETA).toBe("server-side-fallback-2026-07-01");
    expect(params.fallbacks).toBe("default");
    expect(params.output_config).toEqual({ effort: "low" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(pieces).toEqual(["Hello", " there."]);
    expect(result.text).toBe("Hello there.");
    expect(result.usage).toEqual({ input: 300, cacheWrite: 1000, cacheRead: 2000, output: 50 });
    expect(result.cost).toBeCloseTo((300 * 4 + 1000 * 5 + 2000 * 0.2 + 50 * 20) / 1e6, 12);
    expect(result.model).toBe("claude-opus-5-5");
    expect(model.id).toBe("claude-opus-5-5");
  });

  it("uses the plain client when the fallback is off", async () => {
    const client = fakeClient();
    const model = createModel({
      config: { ...CONFIG, refusalFallback: false },
      log: quietLog(),
      client
    });
    await model.answer({ layers, messages, meta: {}, message: "x", onDelta: () => {} });
    expect(client.calls.beta).toHaveLength(0);
    expect(client.calls.plain[0].params.betas).toBeUndefined();
    expect(client.calls.plain[0].params.fallbacks).toBeUndefined();
  });

  it("drops to the plain client for good when the API refuses the fallback field", async () => {
    const refused = Object.assign(new Error("fallbacks: unknown field"), { status: 400 });
    const client = fakeClient({ fail: kind => (kind === "beta" ? refused : null) });
    const log = quietLog();
    const model = createModel({ config: CONFIG, log, client });
    expect(
      (await model.answer({ layers, messages, meta: {}, message: "x", onDelta: () => {} })).text
    ).toBe("Hello there.");
    await model.answer({ layers, messages, meta: {}, message: "x", onDelta: () => {} });
    expect(client.calls.beta).toHaveLength(1);
    expect(client.calls.plain).toHaveLength(2);
    expect(log.lines.some(l => l.level === "warn")).toBe(true);
  });

  it("passes any other failure on", async () => {
    const client = fakeClient({ fail: Object.assign(new Error("overloaded"), { status: 529 }) });
    const model = createModel({ config: CONFIG, log: quietLog(), client });
    await expect(
      model.answer({ layers, messages, meta: {}, message: "x", onDelta: () => {} })
    ).rejects.toThrow("overloaded");
  });

  it("says the ball is clouded when the model declines with nothing said", async () => {
    const client = fakeClient({ deltas: [], final: { stop_reason: "refusal", content: [] } });
    const model = createModel({ config: CONFIG, log: quietLog(), client });
    const pieces = [];
    const result = await model.answer({
      layers,
      messages,
      meta: {},
      message: "x",
      onDelta: p => pieces.push(p)
    });
    expect(result.text).toBe(REFUSAL_TEXT);
    expect(pieces).toEqual([REFUSAL_TEXT]);
    expect(result.stopReason).toBe("refusal");
  });

  it("prices a call served by another priced model at that model's rates", async () => {
    const client = fakeClient({ final: { model: "claude-sonnet-5-5" } });
    const model = createModel({ config: CONFIG, log: quietLog(), client });
    const result = await model.answer({
      layers,
      messages,
      meta: {},
      message: "x",
      onDelta: () => {}
    });
    expect(result.model).toBe("claude-sonnet-5-5");
    expect(result.cost).toBeCloseTo((300 * 2 + 1000 * 2.5 + 2000 * 0.2 + 50 * 10) / 1e6, 12);
  });

  it("counts the gaze with count_tokens once per set of layer hashes", async () => {
    const client = fakeClient({ count: 4321 });
    const model = createModel({ config: CONFIG, log: quietLog(), client });
    expect(await model.countGaze(layers)).toBe(4321);
    expect(await model.countGaze(layers)).toBe(4321);
    expect(client.calls.count).toBe(1);
  });
});

describe("usage and cost", () => {
  it("maps the response's usage fields", () => {
    expect(
      usageOf({
        input_tokens: 1,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 3,
        output_tokens: 4
      })
    ).toEqual({
      input: 1,
      cacheWrite: 0,
      cacheRead: 3,
      output: 4
    });
  });

  it("prices a cache write at the TTL it was made with", () => {
    const usage = { input: 1000, cacheWrite: 35000, cacheRead: 0, output: 800 };
    const opus = CONFIG.prices["claude-opus-5-5"];
    expect(costOf(usage, {}, opus, "5m")).toBeCloseTo(0.195, 10);
    expect(costOf(usage, {}, opus, "1h")).toBeCloseTo((4000 + 35000 * 8 + 16000) / 1e6, 10);
    const split = {
      cache_creation: { ephemeral_5m_input_tokens: 5000, ephemeral_1h_input_tokens: 30000 }
    };
    expect(costOf(usage, split, opus, "5m")).toBeCloseTo(
      (4000 + 5000 * 5 + 30000 * 8 + 16000) / 1e6,
      10
    );
    expect(costOf(usage, {}, undefined, "5m")).toBe(0);
  });
});

describe("what an unfinished call spent", () => {
  const call = (model, extra = {}) =>
    model.answer({ layers, messages, meta: {}, message: "x", onDelta: () => {}, ...extra });
  const chars = layers.reduce((s, l) => s + l.text.length, 0) + "What do we know?".length;

  it("is the stream's last usage when one arrived, with the words that came", async () => {
    const snapshot = {
      input_tokens: 300,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 2000,
      output_tokens: 1
    };
    const fail = Object.assign(new Error("stream broke"), { status: undefined });
    const client = fakeClient({ deltas: ["a".repeat(400)], fail, failAfterDeltas: true, snapshot });
    const model = createModel({ config: CONFIG, log: quietLog(), client });
    const err = await call(model).catch(e => e);
    expect(err.spend.usage).toEqual({ input: 300, cacheWrite: 1000, cacheRead: 2000, output: 100 });
    expect(err.spend.cost).toBeCloseTo((300 * 4 + 1000 * 5 + 2000 * 0.2 + 100 * 20) / 1e6, 12);
    expect(err.spend.estimated).toBe(false);
  });

  it("is the gaze estimated at the input price when the call was abandoned before any usage came", async () => {
    const controller = new AbortController();
    controller.abort(new Error("the client left"));
    const client = fakeClient({
      fail: Object.assign(new Error("Request was aborted."), { name: "AbortError" })
    });
    const model = createModel({ config: CONFIG, log: quietLog(), client });
    const err = await call(model, { signal: controller.signal }).catch(e => e);
    expect(err.spend).toMatchObject({
      usage: { input: Math.ceil(chars / 4), output: 0 },
      estimated: true
    });
    expect(err.spend.cost).toBeCloseTo((Math.ceil(chars / 4) * 4) / 1e6, 12);
  });

  it("is nothing for an HTTP refusal before any stream, which is not billed", async () => {
    const client = fakeClient({ fail: Object.assign(new Error("overloaded"), { status: 529 }) });
    const model = createModel({ config: CONFIG, log: quietLog(), client });
    const err = await call(model).catch(e => e);
    expect(err.spend).toEqual({
      usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
      cost: 0,
      model: "claude-opus-5-5",
      estimated: false,
      lookups: 0
    });
  });

  it("is the stub's estimate, free, when a stub answer is abandoned", async () => {
    const model = createModel({ config: CONFIG, log: quietLog() });
    const err = await call(model, { signal: AbortSignal.abort(new Error("gone")) }).catch(e => e);
    expect(err.spend).toMatchObject({ cost: 0, model: "stub", estimated: true });
  });
});

describe("an answer with no words", () => {
  it("is stored as the ball's fixed sentence, never as an empty turn", async () => {
    for (const stop_reason of ["max_tokens", "pause_turn", "end_turn"]) {
      const client = fakeClient({
        deltas: [],
        final: { stop_reason, content: [{ type: "thinking", thinking: "" }] }
      });
      const model = createModel({ config: CONFIG, log: quietLog(), client });
      const pieces = [];
      const result = await model.answer({
        layers,
        messages,
        meta: {},
        message: "x",
        onDelta: p => pieces.push(p)
      });
      expect(result.text).toBe(EMPTY_TEXT);
      expect(pieces).toEqual([EMPTY_TEXT]);
    }
    expect(EMPTY_TEXT).toBe("The ball clouds over and shows nothing.");
  });
});

describe("a turn served across models", () => {
  it("prices each hop at its own model when the usage lists the hops", () => {
    const raw = {
      input_tokens: 100,
      output_tokens: 10,
      iterations: [
        {
          type: "message",
          model: "claude-opus-5-5",
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 5
        },
        {
          type: "fallback_message",
          model: "claude-sonnet-5-5",
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 10
        }
      ]
    };
    expect(priceUsage(raw, "claude-opus-5-5", CONFIG)).toBeCloseTo(
      (100 * 4 + 5 * 20 + 100 * 2 + 10 * 10) / 1e6,
      12
    );
    expect(
      priceUsage({ input_tokens: 100, output_tokens: 10 }, "claude-opus-5-5", CONFIG)
    ).toBeCloseTo((100 * 4 + 10 * 20) / 1e6, 12);
  });
});

describe("count_tokens", () => {
  it("is given ten seconds and no retries, and a failure falls back to the estimate", async () => {
    const client = fakeClient();
    await createModel({ config: CONFIG, log: quietLog(), client }).countGaze(layers);
    expect(client.calls.countOptions[0].signal).toBeInstanceOf(AbortSignal);
    expect(client.calls.countOptions[0].maxRetries).toBe(0);
    const slow = fakeClient({ count: new Error("timed out") });
    expect(
      await createModel({ config: CONFIG, log: quietLog(), client: slow }).countGaze(layers)
    ).toBe(12);
  });
});

describe("an answer that looks things up", () => {
  const USAGE = {
    input_tokens: 100,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1000,
    output_tokens: 40
  };
  const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

  /** A client whose hops answer in turn: each `{ text, uses, stop, fail }`. */
  function hopsClient(hops) {
    const calls = [];
    const stream = (kind, params, options) => {
      const n = calls.length;
      calls.push({ kind, params: structuredClone(params), options });
      const hop = hops[Math.min(n, hops.length - 1)];
      const handlers = {};
      return {
        currentMessage: undefined,
        on(event, fn) {
          handlers[event] = fn;
          return this;
        },
        async finalMessage() {
          if (hop.fail) throw hop.fail;
          if (hop.text) handlers.text?.(hop.text, "");
          return {
            model: hop.model ?? "claude-opus-5-5",
            stop_reason: hop.stop ?? (hop.uses?.length ? "tool_use" : "end_turn"),
            content: [
              { type: "thinking", thinking: "", signature: `sig${n}` },
              ...(hop.text ? [{ type: "text", text: hop.text }] : []),
              ...(hop.uses ?? [])
            ],
            usage: USAGE
          };
        }
      };
    };
    return {
      calls,
      messages: {
        stream: (p, o) => stream("plain", p, o),
        countTokens: async () => ({ input_tokens: 1 })
      },
      beta: { messages: { stream: (p, o) => stream("beta", p, o) } }
    };
  }

  const DEFS = [{ name: "search_rulebooks", description: "d", input_schema: { type: "object" } }];

  it("runs the tool calls, hands back their results and answers, every hop counted", async () => {
    const client = hopsClient([
      { text: "Let me look.", uses: [toolUse("t1", "search_rulebooks", { query: "fireball" })] },
      { text: "Fireball is level 3." }
    ]);
    const run = vi.fn(async () => ({ content: "Fireball (level 3 evocation)", isError: false }));
    const model = createModel({ config: CONFIG, log: quietLog(), client });
    const deltas = [];
    const result = await model.answer({
      layers,
      messages,
      meta: {},
      message: "x",
      onDelta: d => deltas.push(d),
      tools: { definitions: DEFS, run }
    });
    expect(run).toHaveBeenCalledWith(toolUse("t1", "search_rulebooks", { query: "fireball" }));
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].params.tools).toEqual(DEFS);
    expect(client.calls[0].params.tool_choice).toBeUndefined();
    const second = client.calls[1].params.messages;
    expect(second.slice(0, messages.length)).toEqual(messages);
    // The assistant's turn goes back whole, its thinking included, then the results.
    expect(second.at(-2).content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig0" });
    expect(second.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "Fireball (level 3 evocation)" }]
    });
    expect(deltas.join("")).toBe("Let me look.\n\nFireball is level 3.");
    expect(result.text).toBe("Let me look.\n\nFireball is level 3.");
    expect(result.usage).toEqual({ input: 200, cacheWrite: 0, cacheRead: 2000, output: 80 });
    expect(result.cost).toBeCloseTo(
      2 * costOf(usageOf(USAGE), USAGE, CONFIG.prices["claude-opus-5-5"], "5m")
    );
    expect(result.lookups).toBe(1);
    expect(result.stopReason).toBe("end_turn");
  });

  it("lets the last round only answer, and caps the lookups", async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      toolUse(`t${i}`, "search_rulebooks", { query: `q${i}` })
    );
    const client = hopsClient([{ uses: many }, { uses: many }, { text: "Done." }]);
    const run = vi.fn(async () => ({ content: "hit" }));
    const config = { ...CONFIG, lookupRounds: 2, lookupCalls: 8 };
    const model = createModel({ config, log: quietLog(), client });
    const result = await call2(model, { definitions: DEFS, run });
    expect(client.calls.map(c => c.params.tool_choice?.type ?? "auto")).toEqual([
      "auto",
      "auto",
      "none"
    ]);
    expect(run).toHaveBeenCalledTimes(8);
    const results = client.calls[2].params.messages.at(-1).content;
    expect(results.slice(-2).every(r => r.is_error === true)).toBe(true);
    expect(result.lookups).toBe(10);
    expect(result.text).toBe("Done.");
  });

  it("gives a failed lookup back to the model as an error result, and goes on", async () => {
    const client = hopsClient([
      { uses: [toolUse("t1", "read_rulebook", { id: "x" })] },
      { text: "Sorry." }
    ]);
    const log = quietLog();
    const model = createModel({ config: CONFIG, log, client });
    const result = await call2(model, {
      definitions: DEFS,
      run: async () => Promise.reject(new Error("socket"))
    });
    expect(client.calls[1].params.messages.at(-1).content[0]).toMatchObject({ is_error: true });
    expect(result.text).toBe("Sorry.");
    expect(log.lines.some(l => l.message === "rulebooks: a lookup failed")).toBe(true);
  });

  it("counts the hops before a failed one in what the failure spent", async () => {
    const client = hopsClient([
      { uses: [toolUse("t1", "search_rulebooks", { query: "a" })] },
      { fail: Object.assign(new Error("overloaded"), { status: 529 }) }
    ]);
    const model = createModel({ config: CONFIG, log: quietLog(), client });
    const err = await call2(model, {
      definitions: DEFS,
      run: async () => ({ content: "hit" })
    }).catch(e => e);
    expect(err.spend.usage).toEqual(usageOf(USAGE));
    expect(err.spend.cost).toBeCloseTo(
      costOf(usageOf(USAGE), USAGE, CONFIG.prices["claude-opus-5-5"], "5m")
    );
    expect(err.spend.lookups).toBe(1);
  });

  it("stops when the asker leaves during a lookup, counting only the hops that ran", async () => {
    const controller = new AbortController();
    const client = hopsClient([
      { uses: [toolUse("t1", "search_rulebooks", { query: "a" })] },
      { text: "never" }
    ]);
    const model = createModel({ config: CONFIG, log: quietLog(), client });
    const run = async () => {
      controller.abort(new Error("the client left"));
      return { content: "hit" };
    };
    const err = await call2(model, { definitions: DEFS, run }, controller.signal).catch(e => e);
    expect(err.message).toBe("the client left");
    expect(client.calls).toHaveLength(1);
    expect(err.spend.usage).toEqual(usageOf(USAGE));
    expect(err.spend.estimated).toBe(false);
  });

  it("sends no tools and no tool choice when the table has no rulebooks", async () => {
    const client = hopsClient([{ text: "Hi." }]);
    const model = createModel({ config: CONFIG, log: quietLog(), client });
    await call2(model, null);
    expect("tools" in client.calls[0].params).toBe(false);
    expect("tool_choice" in client.calls[0].params).toBe(false);
  });

  it("puts the tools in the request only when given", () => {
    expect(requestParams(CONFIG, layers, messages, { tools: DEFS, final: true })).toMatchObject({
      tools: DEFS,
      tool_choice: { type: "none" }
    });
    expect("tools" in requestParams(CONFIG, layers, messages)).toBe(false);
  });

  function call2(model, tools, signal) {
    return model.answer({
      layers,
      messages,
      meta: {},
      message: "x",
      onDelta: () => {},
      tools,
      signal
    });
  }
});
