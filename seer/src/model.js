/**
 * The model call, per the contract's *The model call*: `messages.stream` with the gaze as four
 * system blocks (an explicit cache marker on the first three, the request's top-level automatic
 * marker for the conversation tail, the fourth), effort from config, no `thinking` parameter (the
 * Claude 5.5 models think adaptively by default and take no other setting) and no prefill. With
 * `refusalFallback` the call goes through the beta client with the API's server-side fallback, so
 * a request the model declines on policy grounds is re-run on the API's default fallback model
 * inside the same call.
 *
 * Without a key (or with MODEL_STUB=1) nothing is called: the stub answers the contract's exact
 * sentence, so a live check can assert on it and spend nothing.
 */

import Anthropic from "@anthropic-ai/sdk";
import { estimateTokens } from "./gaze.js";
import { EMPTY_TEXT, REFUSAL_TEXT } from "./instructions.js";

export { EMPTY_TEXT, REFUSAL_TEXT };

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * The stub's answer, word for word the contract's sentence (its line break included).
 * @param {{ sharedPages: number, clues: number, members: number, characterName: string | null,
 *   className: string | null, level: number | null }} meta
 * @param {string} message
 */
export function stubAnswer(meta, message) {
  const character = meta?.characterName
    ? `your character ${meta.characterName} (${meta.className || "no class"} ${meta.level ?? 0})`
    : "no character";
  return (
    `The Crystal Ball is clouded (stub). I see ${meta?.sharedPages ?? 0} shared pages, ${meta?.clues ?? 0} clues, ` +
    `${meta?.members ?? 0} party members\nand ${character}. You asked: "${message}".`
  );
}

/** The cache marker for the configured TTL (the 5-minute default carries no `ttl`). */
export const cacheMarker = ttl =>
  ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };

/** The four system blocks: a marker on each of the first three. */
export function systemBlocks(layers, ttl) {
  return layers.map((l, i) => ({
    type: "text",
    text: l.text,
    ...(i < 3 ? { cache_control: cacheMarker(ttl) } : {})
  }));
}

/**
 * The request body, minus what the transport adds (`betas`, `fallbacks`). With `tools` (the
 * rulebooks' two, the same bytes for the whole table, so they cache ahead of the first system
 * block) the model may look things up; `final` lets it answer only, the lookups spent.
 * @param {{ model: string, effort: string, maxOutputTokens: number, cacheTtl: string }} config
 * @param {{ tools?: object[] | null, final?: boolean, model?: string }} [options]
 */
export function requestParams(
  config,
  layers,
  messages,
  { tools = null, final = false, model } = {}
) {
  return {
    model: model ?? config.model,
    max_tokens: config.maxOutputTokens,
    system: systemBlocks(layers, config.cacheTtl),
    ...(tools?.length ? { tools, ...(final ? { tool_choice: { type: "none" } } : {}) } : {}),
    messages,
    // Top-level automatic caching marks the last cacheable block, the newest message, so a
    // sitting's next turn reads the whole conversation before it.
    cache_control: cacheMarker(config.cacheTtl),
    output_config: { effort: config.effort }
  };
}

/** The usage line from a response's `usage`. */
export function usageOf(usage) {
  return {
    input: usage?.input_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    output: usage?.output_tokens ?? 0
  };
}

/**
 * A call's cost in dollars from the config's per-MTok prices. A cache write is priced at the
 * TTL it was made with; the usage's own split by TTL is used when the response gives one.
 */
export function costOf(usage, rawUsage, prices, ttl) {
  if (!prices) return 0;
  const split = rawUsage?.cache_creation;
  const write1h = split
    ? (split.ephemeral_1h_input_tokens ?? 0)
    : ttl === "1h"
      ? usage.cacheWrite
      : 0;
  const write5m = split ? (split.ephemeral_5m_input_tokens ?? 0) : usage.cacheWrite - write1h;
  const dollars =
    usage.input * prices.input +
    write5m * prices.cacheWrite5m +
    write1h * prices.cacheWrite1h +
    usage.cacheRead * prices.cacheRead +
    usage.output * prices.output;
  return dollars / 1e6;
}

/**
 * A response's cost: each sampling hop at its own model's prices when the usage lists the hops
 * (a turn a fallback model served lists the declined model's attempt and the fallback's), else
 * the whole usage at the served model's.
 */
export function priceUsage(raw, served, config) {
  const prices = config.prices ?? {};
  const hops = Array.isArray(raw?.iterations)
    ? raw.iterations.filter(h => h && typeof h === "object")
    : [];
  if (hops.length) {
    return hops.reduce(
      (sum, h) => sum + costOf(usageOf(h), h, prices[h.model] ?? prices[served], config.cacheTtl),
      0
    );
  }
  return costOf(usageOf(raw), raw, prices[served], config.cacheTtl);
}

/** The text blocks of a final message, joined. */
const textOf = message =>
  (message?.content ?? [])
    .filter(b => b?.type === "text")
    .map(b => b.text)
    .join("");

const charsOf = (layers, messages) =>
  layers.reduce((s, l) => s + l.text.length, 0) +
  messages.reduce(
    (s, m) => s + (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).length,
    0
  );

/** Two usages added. */
const addUsage = (a, b) => ({
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output
});

const NO_USAGE = Object.freeze({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });

/** How many rounds of lookups one answer may take, and how many lookups in all. */
export const LOOKUP_ROUNDS = 4;
export const LOOKUP_CALLS = 8;

const isAbort = (err, signal) =>
  Boolean(signal?.aborted) ||
  err instanceof Anthropic.APIUserAbortError ||
  err?.name === "AbortError" ||
  err?.name === "TimeoutError";

/**
 * The model, real or stub.
 * @param {{ apiKey?: string, stub?: boolean, config: object, log: object,
 *   client?: object }} options  `client` is a ready Anthropic client (the tests pass a fake)
 */
export function createModel({ apiKey, stub = false, config, log, client = null }) {
  const isStub = stub || (!apiKey && !client);
  const anthropic = isStub ? null : (client ?? new Anthropic({ apiKey, maxRetries: 2 }));
  let fallbackUsable = config.refusalFallback !== false;
  const counts = new Map();
  const priced = model => (model && config.prices?.[model] ? model : config.model);

  /**
   * What a call that did not finish spent, for the ledger and the caps: the stream's last usage
   * snapshot when one arrived; else, when the request reached the model (words came back, or it
   * was aborted or timed out mid-flight), the gaze and messages estimated at the input price plus
   * the words that arrived; else (an HTTP refusal before any stream) nothing, since none is billed.
   */
  function partialSpend(err, layers, messages, signal) {
    const outChars = err?.outChars ?? 0;
    const snap = err?.snapshot?.usage;
    const served = priced(err?.snapshot?.model);
    if (
      snap &&
      (snap.input_tokens || snap.cache_read_input_tokens || snap.cache_creation_input_tokens)
    ) {
      const usage = usageOf(snap);
      usage.output = Math.max(usage.output, Math.ceil(outChars / 4));
      return {
        usage,
        cost: priceUsage({ ...snap, output_tokens: usage.output }, served, config),
        model: served,
        estimated: false
      };
    }
    if (outChars > 0 || isAbort(err, signal)) {
      const usage = {
        input: Math.ceil(charsOf(layers, messages) / 4),
        cacheWrite: 0,
        cacheRead: 0,
        output: Math.ceil(outChars / 4)
      };
      return {
        usage,
        cost: costOf(usage, null, config.prices?.[served], config.cacheTtl),
        model: served,
        estimated: true
      };
    }
    return {
      usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
      cost: 0,
      model: served,
      estimated: false
    };
  }

  return {
    /** The model id the Seer reports: the configured one, or "stub". */
    get id() {
      return isStub ? "stub" : config.model;
    },

    get stub() {
      return isStub;
    },

    /**
     * The gaze's token count: `count_tokens` when a key is present (memoised by the layers'
     * hashes, so a rebuild that changed nothing costs no call), else the estimate. Ten seconds at
     * most: a slow count falls back to the estimate and never holds up or fails the chat.
     */
    async countGaze(layers) {
      const estimate = layers.reduce((s, l) => s + l.estTokens, 0);
      if (isStub) return estimate;
      const key = layers.map(l => l.hash).join(":");
      if (counts.has(key)) return counts.get(key);
      try {
        const res = await anthropic.messages.countTokens(
          {
            model: config.model,
            system: systemBlocks(layers, config.cacheTtl),
            messages: [{ role: "user", content: "." }]
          },
          { signal: AbortSignal.timeout(10000), maxRetries: 0 }
        );
        const n = res?.input_tokens ?? estimate;
        if (counts.size > 64) counts.clear();
        counts.set(key, n);
        return n;
      } catch (err) {
        log.warn("count_tokens failed; using the estimate", { error: err?.message ?? String(err) });
        return estimate;
      }
    },

    /**
     * Answer one message. With `tools` the model may look things up first: each round of its
     * tool calls is run, the results go back, and the next hop answers or looks again, up to
     * `config.lookupRounds` rounds and `config.lookupCalls` calls, the last hop answering only.
     * The usage and cost are every hop's. A failure carries `spend` (`{ usage, cost, model,
     * estimated }`): what the unfinished answer cost, so the caller can count it.
     * @param {{ layers: Array<{ text: string }>, messages: Array<{ role: string, content: string }>,
     *   meta: object, message: string, onDelta: (text: string) => void, signal?: AbortSignal,
     *   tools?: { definitions: object[], run: (block: object) => Promise<{ content: string,
     *   isError?: boolean }> } | null }} call
     * @returns {Promise<{ text: string, usage: object, cost: number, model: string,
     *   stopReason: string, lookups: number }>}
     */
    async answer({ layers, messages, meta, message, onDelta, signal, tools = null }) {
      if (isStub) {
        const text = stubAnswer(meta, message);
        const input = Math.ceil(charsOf(layers, messages) / 4);
        let sent = 0;
        // Streamed in word-sized pieces, so the window's delta path runs as it does for a model.
        for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
          if (signal?.aborted) {
            const err = signal.reason instanceof Error ? signal.reason : new Error("aborted");
            err.spend = {
              usage: { input, cacheWrite: 0, cacheRead: 0, output: Math.ceil(sent / 4) },
              cost: 0,
              model: "stub",
              estimated: true
            };
            throw err;
          }
          sent += piece.length;
          onDelta(piece);
        }
        return {
          text,
          usage: { input, cacheWrite: 0, cacheRead: 0, output: estimateTokens(text) },
          cost: 0,
          model: "stub",
          stopReason: "end_turn",
          lookups: 0
        };
      }

      // Each sampling hop gets its own timeout; an answer that looks things up takes a hop per
      // round of lookups and one to answer.
      const hopMs = config.callTimeoutMs ?? 60000;
      const rounds = tools ? (config.lookupRounds ?? LOOKUP_ROUNDS) : 0;
      const maxCalls = config.lookupCalls ?? LOOKUP_CALLS;
      let convo = messages;
      let usage = { ...NO_USAGE };
      let cost = 0;
      let hopModel = config.model;
      let served = priced(config.model);
      let calls = 0;
      let streamed = "";
      const texts = [];
      let final = null;

      const run = async (useFallback, params, abort) => {
        let outChars = 0;
        let first = true;
        const stream = useFallback
          ? anthropic.beta.messages.stream(
              { ...params, betas: [FALLBACK_BETA], fallbacks: "default" },
              { signal: abort }
            )
          : anthropic.messages.stream(params, { signal: abort });
        stream.on("text", delta => {
          // A hop's words after an earlier hop's start a paragraph of their own.
          if (first && streamed && !streamed.endsWith("\n\n")) {
            streamed += "\n\n";
            onDelta("\n\n");
          }
          first = false;
          outChars += delta.length;
          streamed += delta;
          onDelta(delta);
        });
        try {
          return await stream.finalMessage();
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          e.outChars = outChars;
          e.snapshot = stream.currentMessage ?? null;
          throw e;
        }
      };

      /** What the answer has spent so far, plus an unfinished hop's part, for the caller to count. */
      const spentWith = part => ({
        usage: addUsage(usage, part.usage),
        cost: cost + part.cost,
        model: part.model,
        estimated: part.estimated,
        lookups: calls
      });

      for (let round = 0; ; round++) {
        const last = !tools || round >= rounds;
        const params = requestParams(config, layers, convo, {
          tools: tools?.definitions ?? null,
          final: Boolean(tools) && last,
          model: hopModel
        });
        const abort = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(hopMs)])
          : AbortSignal.timeout(hopMs);
        let hop;
        try {
          try {
            hop = await run(fallbackUsable, params, abort);
          } catch (err) {
            // A 400 that names the fallback before a word was streamed: the beta field is refused
            // here (another platform, a retired beta). Drop to the plain client for good.
            const refusedField =
              fallbackUsable &&
              !err.outChars &&
              err?.status === 400 &&
              /fallback|beta/i.test(err?.message ?? "");
            if (!refusedField) throw err;
            log.warn(
              "the server-side refusal fallback was refused; calling without it from now on",
              {
                error: err.message
              }
            );
            fallbackUsable = false;
            hop = await run(false, params, abort);
          }
        } catch (err) {
          err.spend = spentWith(partialSpend(err, layers, convo, abort));
          throw err;
        }

        usage = addUsage(usage, usageOf(hop.usage));
        served = priced(hop.model);
        cost += priceUsage(hop.usage, served, config);
        final = hop;
        const words = textOf(hop);
        if (words.trim()) texts.push(words);
        // A turn the fallback model served goes on with that model, whose thinking it carries.
        if (hop.model && hop.model !== hopModel) hopModel = hop.model;

        const uses = (hop.content ?? []).filter(b => b?.type === "tool_use");
        if (last || hop.stop_reason !== "tool_use" || !uses.length) break;
        const results = [];
        for (const block of uses) {
          calls++;
          let r;
          if (calls > maxCalls) {
            r = {
              content: "No more lookups for this answer: answer from what you have.",
              isError: true
            };
          } else {
            try {
              r = await tools.run(block);
            } catch (err) {
              log.warn("rulebooks: a lookup failed", { tool: block?.name, error: err?.message });
              r = { content: "The rulebooks could not be opened just now.", isError: true };
            }
          }
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: String(r?.content ?? ""),
            ...(r?.isError ? { is_error: true } : {})
          });
        }
        if (signal?.aborted) {
          // The asker left during a lookup: what the hops before it spent is what was billed.
          const err = signal.reason instanceof Error ? signal.reason : new Error("aborted");
          err.spend = spentWith({ usage: NO_USAGE, cost: 0, model: served, estimated: false });
          throw err;
        }
        convo = [
          ...convo,
          { role: "assistant", content: hop.content },
          { role: "user", content: results }
        ];
      }

      let text = texts.join("\n\n");
      if (!text.trim()) {
        // A turn with no words (a refusal, output spent on thinking, a paused turn) is stored
        // as one of the ball's sentences, never empty.
        text = final?.stop_reason === "refusal" ? REFUSAL_TEXT : EMPTY_TEXT;
        onDelta(text);
      }
      return {
        text,
        usage,
        cost,
        model: served,
        stopReason: final?.stop_reason ?? "",
        lookups: calls
      };
    }
  };
}
