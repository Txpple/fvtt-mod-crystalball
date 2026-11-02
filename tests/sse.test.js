import { describe, expect, it } from "vitest";
import { createSseParser } from "../scripts/decide/sse.js";

/** Every event a whole stream yields, fed in the given pieces. */
const parseAll = (...chunks) => {
  const p = createSseParser();
  return [...chunks.flatMap(c => p.feed(c)), ...p.end()];
};

const STREAM =
  'event: meta\ndata: {"sittingId":"s1","model":"stub"}\n\n' +
  'event: delta\ndata: {"text":"The ball "}\n\n' +
  'event: delta\ndata: {"text":"clears."}\n\n' +
  'event: done\ndata: {"text":"The ball clears.","cost":0}\n\n';

const BOM = String.fromCharCode(0xfeff);

describe("the Seer's event stream", () => {
  it("yields each event, its data parsed", () => {
    expect(parseAll(STREAM)).toEqual([
      { event: "meta", data: { sittingId: "s1", model: "stub" } },
      { event: "delta", data: { text: "The ball " } },
      { event: "delta", data: { text: "clears." } },
      { event: "done", data: { text: "The ball clears.", cost: 0 } }
    ]);
  });

  it("gives the same events however the stream is cut", () => {
    const whole = parseAll(STREAM);
    for (let size = 1; size <= 12; size++) {
      const chunks = [];
      for (let i = 0; i < STREAM.length; i += size) chunks.push(STREAM.slice(i, i + size));
      expect(parseAll(...chunks)).toEqual(whole);
    }
  });

  it("yields an event only once its blank line has arrived", () => {
    const p = createSseParser();
    expect(p.feed('event: delta\ndata: {"text":"a"}\n')).toEqual([]);
    expect(p.feed("\n")).toEqual([{ event: "delta", data: { text: "a" } }]);
  });

  it("reads CRLF and lone CR line endings, a CRLF split across chunks included", () => {
    const crlf = STREAM.replaceAll("\n", "\r\n");
    const cr = STREAM.replaceAll("\n", "\r");
    expect(parseAll(crlf)).toEqual(parseAll(STREAM));
    expect(parseAll(cr)).toEqual(parseAll(STREAM));
    const p = createSseParser();
    expect(p.feed('event: delta\r\ndata: {"text":"x"}\r')).toEqual([]);
    expect(p.feed("\n\r")).toEqual([]);
    expect(p.feed("\n")).toEqual([{ event: "delta", data: { text: "x" } }]);
    expect(p.end()).toEqual([]);
  });

  it("joins several data lines with a newline", () => {
    expect(parseAll('event: done\ndata: {"text":\ndata: "two lines"}\n\n')).toEqual([
      { event: "done", data: { text: "two lines" } }
    ]);
  });

  it("skips comments, unknown fields, id and retry, and events with no data", () => {
    expect(
      parseAll(
        ': keep-alive\n\nid: 7\nretry: 100\nfoo: bar\nevent: delta\ndata: {"text":"y"}\n\nevent: meta\n\n'
      )
    ).toEqual([{ event: "delta", data: { text: "y" } }]);
  });

  it("names an event without an event line 'message', and takes a field with no colon as empty", () => {
    expect(parseAll('data: {"a":1}\n\n')).toEqual([{ event: "message", data: { a: 1 } }]);
    expect(parseAll("event\ndata: 1\n\n")).toEqual([{ event: "message", data: 1 }]);
  });

  it("strips one space after the colon, and only one", () => {
    expect(parseAll('event:delta\ndata:{"text":"z"}\n\n')).toEqual([
      { event: "delta", data: { text: "z" } }
    ]);
    expect(parseAll('event: delta\ndata:  "  spaced"\n\n')).toEqual([
      { event: "delta", data: "  spaced" }
    ]);
  });

  it("turns a contract event's data that is not JSON into the contract's error event", () => {
    for (const name of ["meta", "delta", "done", "error"]) {
      const [ev] = parseAll(`event: ${name}\ndata: {not json\n\n`);
      expect(ev.event).toBe("error");
      expect(ev.data.error).toBe("seer");
      expect(typeof ev.data.message).toBe("string");
    }
  });

  it("passes any other event through untouched, so a heartbeat never ends an answer", () => {
    expect(
      parseAll('event: ping\ndata: keep-alive\n\nevent: delta\ndata: {"text":"on"}\n\n')
    ).toEqual([
      { event: "ping", data: "keep-alive" },
      { event: "delta", data: { text: "on" } }
    ]);
    expect(parseAll("data: plain words\n\n")).toEqual([{ event: "message", data: "plain words" }]);
    expect(parseAll('event: ping\ndata: {"n":1}\n\n')).toEqual([{ event: "ping", data: { n: 1 } }]);
  });

  it("discards an event the stream ended before its blank line", () => {
    expect(parseAll('event: done\ndata: {"text":"end"}')).toEqual([]);
    expect(parseAll('event: done\ndata: {"text":"end"}\n')).toEqual([]);
    expect(parseAll('event: delta\ndata: {"text":"a"}\n\nevent: done\ndata: {"text":"en')).toEqual([
      { event: "delta", data: { text: "a" } }
    ]);
  });

  it("still dispatches an event closed by a lone CR at the stream's very end", () => {
    expect(parseAll('event: done\rdata: {"text":"end"}\r\r')).toEqual([
      { event: "done", data: { text: "end" } }
    ]);
  });

  it("drops a byte-order mark at the stream's start, and only there", () => {
    expect(parseAll(`${BOM}event: delta\ndata: {"text":"b"}\n\n`)).toEqual([
      { event: "delta", data: { text: "b" } }
    ]);
    expect(parseAll("event: delta\n", `${BOM}data: {"text":"c"}\n\n`)).toEqual([]);
  });

  it("keeps text with newlines and unicode inside the JSON", () => {
    const text = "Line one\nLine two — «Halruaa» 🔮";
    expect(parseAll(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`)).toEqual([
      { event: "delta", data: { text } }
    ]);
  });
});
