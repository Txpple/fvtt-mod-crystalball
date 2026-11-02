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
 * The request body, minus what the transport adds (`betas`, `fallbacks`).
 * @param {{ model: string, effort: string, maxOutputTokens: number, cacheTtl: string }} config
 */
export function requestParams(config, layers, messages) {
  return {
    model: config.model,
    max_tokens: config.maxOutputTokens,
    system: systemBlocks(layers, config.cacheTtl),
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

/** The text blocks of a final message, joined. */
const textOf = message =>
  (message?.content ?? [])
    .filter(b => b?.type === "text")
    .map(b => b.text)
    .join("");

/** The words a declined request answers with when nothing at all was said before the refusal. */
export const REFUSAL_TEXT = "The ball stays clouded on that: the model declined to answer.";

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
     * hashes, so a rebuild that changed nothing costs no call), else the estimate.
     */
    async countGaze(layers) {
      const estimate = layers.reduce((s, l) => s + l.estTokens, 0);
      if (isStub) return estimate;
      const key = layers.map(l => l.hash).join(":");
      if (counts.has(key)) return counts.get(key);
      try {
        const res = await anthropic.messages.countTokens({
          model: config.model,
          system: systemBlocks(layers, config.cacheTtl),
          messages: [{ role: "user", content: "." }]
        });
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
     * Answer one message.
     * @param {{ layers: Array<{ text: string }>, messages: Array<{ role: string, content: string }>,
     *   meta: object, message: string, onDelta: (text: string) => void, signal?: AbortSignal }} call
     * @returns {Promise<{ text: string, usage: object, cost: number, model: string, stopReason: string }>}
     */
    async answer({ layers, messages, meta, message, onDelta, signal }) {
      if (isStub) {
        const text = stubAnswer(meta, message);
        // Streamed in word-sized pieces, so the window's delta path runs as it does for a model.
        for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
          if (signal?.aborted) throw signal.reason ?? new Error("aborted");
          onDelta(piece);
        }
        const chars =
          layers.reduce((s, l) => s + l.text.length, 0) +
          messages.reduce((s, m) => s + String(m.content).length, 0);
        return {
          text,
          usage: {
            input: Math.ceil(chars / 4),
            cacheWrite: 0,
            cacheRead: 0,
            output: estimateTokens(text)
          },
          cost: 0,
          model: "stub",
          stopReason: "end_turn"
        };
      }

      const timeout = AbortSignal.timeout(config.callTimeoutMs ?? 60000);
      const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const params = requestParams(config, layers, messages);
      const run = async useFallback => {
        let said = false;
        const stream = useFallback
          ? anthropic.beta.messages.stream(
              { ...params, betas: [FALLBACK_BETA], fallbacks: "default" },
              { signal: abort }
            )
          : anthropic.messages.stream(params, { signal: abort });
        stream.on("text", delta => {
          said = true;
          onDelta(delta);
        });
        try {
          return await stream.finalMessage();
        } catch (err) {
          err.said = said;
          throw err;
        }
      };

      let final;
      try {
        final = await run(fallbackUsable);
      } catch (err) {
        // A 400 that names the fallback before a word was streamed: the beta field is refused
        // here (another platform, a retired beta). Drop to the plain client for good.
        const refusedField =
          fallbackUsable &&
          !err.said &&
          err?.status === 400 &&
          /fallback|beta/i.test(err?.message ?? "");
        if (!refusedField) throw err;
        log.warn("the server-side refusal fallback was refused; calling without it from now on", {
          error: err.message
        });
        fallbackUsable = false;
        final = await run(false);
      }

      const usage = usageOf(final.usage);
      const served = final.model && config.prices?.[final.model] ? final.model : config.model;
      const cost = costOf(usage, final.usage, config.prices?.[served], config.cacheTtl);
      let text = textOf(final);
      if (!text.trim() && final.stop_reason === "refusal") {
        text = REFUSAL_TEXT;
        onDelta(text);
      }
      return { text, usage, cost, model: served, stopReason: final.stop_reason ?? "" };
    }
  };
}
