// @ts-check
/**
 * The Seer's answer arrives as Server-Sent Events over a `fetch` body (an EventSource cannot send
 * the X-Foundry-Session header), so the window parses the stream itself. Pure: text chunks in,
 * `{ event, data }` out, no Foundry and no DOM.
 *
 * The rules are the HTML standard's event-stream rules, cut to what the contract uses: `event:`
 * and `data:` fields (several data lines joined by a newline), comments and other fields ignored,
 * an event dispatched on a blank line, lines ended by CRLF, LF or CR. A chunk may end anywhere,
 * mid-line or between the CR and the LF of one line ending, so nothing is decided about a line
 * until its ending has arrived.
 */

/**
 * @typedef {{ event: string, data: any }} SseEvent
 */

/**
 * A data payload that is not JSON is the Seer's fault, never the reader's: it becomes the
 * contract's own error event, so the window has one way to show a failure.
 * @param {string} event
 * @param {string} raw
 * @returns {SseEvent}
 */
function decode(event, raw) {
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event: "error", data: { error: "seer", message: `unreadable data in a "${event}" event` } };
  }
}

/**
 * An incremental parser for one stream: `feed` each decoded chunk as it arrives, `end` once the
 * stream closes. Each returns the events completed by what it was given, in order.
 */
export function createSseParser() {
  let buffer = "";
  let fresh = true;
  let event = "";
  /** @type {string[]} */
  let data = [];

  /** @param {SseEvent[]} out */
  const dispatch = out => {
    // An event with no data line is no event (the standard's rule): a comment-only keep-alive.
    if (data.length) out.push(decode(event || "message", data.join("\n")));
    event = "";
    data = [];
  };

  /**
   * @param {string} line
   * @param {SseEvent[]} out
   */
  const take = (line, out) => {
    if (line === "") return dispatch(out);
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    // `id` and `retry` serve reconnection, which a fetch stream never does.
  };

  /**
   * @param {boolean} final
   * @returns {SseEvent[]}
   */
  const drain = final => {
    /** @type {SseEvent[]} */
    const out = [];
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i];
      if (c !== "\n" && c !== "\r") continue;
      // A CR at the very end may be the first half of a CRLF: wait for the next chunk.
      if (c === "\r" && i + 1 === buffer.length && !final) break;
      take(buffer.slice(start, i), out);
      if (c === "\r" && buffer[i + 1] === "\n") i++;
      start = i + 1;
    }
    buffer = buffer.slice(start);
    if (final) {
      // A stream cut off mid-event still hands over what it had; a half JSON becomes an error.
      if (buffer) take(buffer, out);
      buffer = "";
      dispatch(out);
    }
    return out;
  };

  return {
    /**
     * @param {string} chunk
     * @returns {SseEvent[]}
     */
    feed(chunk) {
      if (!chunk) return [];
      // A byte-order mark may open the stream, and only the stream.
      buffer += fresh && chunk.startsWith("﻿") ? chunk.slice(1) : chunk;
      fresh = false;
      return drain(false);
    },
    /** @returns {SseEvent[]} */
    end() {
      return drain(true);
    }
  };
}
