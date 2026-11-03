/**
 * The Crystal Ball window: one per client, centred, a status bar, the sitting's transcript and
 * the input. It talks to the Seer and to nothing else (docs/seer-contract.md): every request
 * carries the player's own Foundry session id in `X-Foundry-Session`, the Seer asks Foundry whose
 * it is, and the answer streams back as Server-Sent Events over `fetch` (an EventSource cannot
 * send the header). No key, no model call and no world read happen here; when the Seer or the
 * world is out of reach the ball is dark and says why.
 *
 * What the ball says is drawn by decide/markdown.js over escaped text; what the player typed is
 * escaped by the template. Neither is ever enriched. The transcript's words can be selected, each
 * finished answer has a copy button, and Export saves the sitting as a Markdown file, as the
 * family's other windows export theirs. The window opens nothing of its own, so it
 * carries no host helper: Foundry's own Detach moves it, and nothing follows it.
 */

import { log, MODULE_ID, setting, t } from "./common.js";
import { renderMarkdown } from "./decide/markdown.js";
import { lookupLine } from "./decide/rulebooks.js";
import { composeSaying } from "./decide/saying.js";
import { darkReason, failureOf, MESSAGE_LIMIT, modelLabel, serviceCandidates, sessionIdFrom, waitOf } from "./decide/session.js";
import { questionsIn, sittingFileName, sittingMarkdown } from "./decide/sitting.js";
import { createSseParser } from "./decide/sse.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** A JSON call that has not answered by then never will: the window goes dark instead of hanging. */
const CALL_TIMEOUT_MS = 15_000;

/**
 * The search's healthz probe: a Seer beside Foundry answers at once, and a candidate that hangs
 * (a tunnel's hostname on a port it does not serve) must not hold the ball in "Gazing…" for long.
 */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * A dark window asks again this often while the reason can heal (the Seer unreachable, its link or
 * its world down, a server or network failure), so a Seer that comes up, or finds its world again,
 * lights the ball without a click; a refusal is final until Retry, which is the same ask, sooner.
 */
const DARK_RETRY_MS = 10_000;

/** Whether a failed sitting call is one that can heal on its own: a network failure or a 5xx. */
const heals = status => !status || status >= 500;

/**
 * The Seer gives the model a minute a hop, and an answer that looks rules up takes a hop per round
 * of lookups; this only ends a stream that never closes.
 */
const CHAT_TIMEOUT_MS = 240_000;

/** How often a streaming answer is redrawn: smooth enough, and cheap on a long answer. */
const PAINT_MS = 50;

/* -------------------------------------------------- */
/*  The calls                                          */
/* -------------------------------------------------- */

/**
 * The caller's Foundry session id: the one Foundry handed this client's own socket at connect
 * (its `session` event). Foundry 14 sets the `session` cookie HttpOnly, so `document.cookie` never
 * holds it; the cookie, read as Foundry's `getCookies()` reads it, is only the older builds'
 * fallback. The two are the same value.
 */
function sessionId() {
  return game.socket?.session?.sessionId ?? sessionIdFrom(document.cookie);
}

/** The Seer's base the last probe settled on; null until one answers, and again when the setting changes. */
let seerBase = null;

/** Where the window looks for the Seer, in the contract's order (the setting, then the companion port). */
const candidates = () => serviceCandidates(setting("serviceUrl"), window.location);

/**
 * An endpoint's URL at the Seer the probe settled on (before any probe, at the first candidate), or
 * null when the Service URL setting names no http(s) service.
 */
function endpoint(path, base = seerBase ?? candidates()[0]) {
  return base ? `${base}/${path}` : null;
}

function headers(json, withSession = true) {
  const h = {};
  const id = withSession ? sessionId() : null;
  if (id) h["X-Foundry-Session"] = id;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

/**
 * One JSON call to the Seer: `{ ok, status, body }`. A network failure, or no URL, is status 0.
 * The search's probe passes `withSession: false` (healthz wants no id; without the header the
 * probe is a simple GET, no preflight) and its own short timeout.
 */
async function call(path, { method = "GET", body, base, timeoutMs = CALL_TIMEOUT_MS, withSession = true } = {}) {
  const url = endpoint(path, base);
  if (!url) return { ok: false, status: 0, body: null };
  try {
    const res = await fetch(url, {
      method,
      headers: headers(body !== undefined, withSession),
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body: data };
  } catch (err) {
    log.debug(`the Seer's ${path} did not answer`, err);
    return { ok: false, status: 0, body: null };
  }
}

/**
 * Probe each candidate's healthz in order and settle on the first Seer that answers: that call's
 * `{ ok, status, body }`, or the last failure when none does. A Seer that answers but reports no
 * link or no world is still the Seer: the ball is dark for its reason, not for one further along.
 * The base found is kept only while the search that found it is still `current()`: a setting
 * change mid-search starts another, and this one's answer must not outlive it.
 */
async function findSeer(current = () => true) {
  let last = { ok: false, status: 0, body: null };
  for (const base of candidates()) {
    const health = await call("healthz", { base, timeoutMs: PROBE_TIMEOUT_MS, withSession: false });
    if (!current()) return health;
    if (health.ok) {
      seerBase = base;
      return health;
    }
    last = health;
  }
  seerBase = null;
  return last;
}

/**
 * The line a failed call or a stream's error event shows, from lang. A mid-stream `error` carries
 * the same `reason`, `scope` and `retryAfter` as the status bodies, so it reads the same.
 */
function failureLine(status, body) {
  if (!status && !body) return t("errors.network");
  const f = failureOf(status, body);
  const wait = f.retryAfter ? waitOf(f.retryAfter) : null;
  return t(`errors.${f.key}`, {
    limit: (f.limit ?? MESSAGE_LIMIT).toLocaleString(game.i18n.lang),
    wait: wait ? t(`wait.${wait.unit}`, { n: wait.n }) : t("wait.later"),
    message: f.message ?? "",
    status: String(f.status ?? "")
  });
}

/** The one sitting change in flight, so a double click (or the API beside a click) posts once. */
let posting = null;

/** Close the open sitting and open a fresh one: the new sitting's `{ id, startedAt }`, or null. */
function postNewSitting() {
  posting ??= (async () => {
    const res = await call("sittings/new", { method: "POST" });
    if (res.ok) return res.body ?? {};
    // Foundry cleans a notification rather than escaping it, and a 500's message is the Seer's text.
    ui.notifications.warn(foundry.utils.escapeHTML(failureLine(res.status, res.body)));
    return null;
  })().finally(() => {
    posting = null;
  });
  return posting;
}

/* -------------------------------------------------- */
/*  The window                                         */
/* -------------------------------------------------- */

export class CrystalBallWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "crystalball-window",
    classes: ["crystalball"],
    window: { title: `${MODULE_ID}.window.title`, icon: "fa-solid fa-crystal-ball", resizable: true },
    position: { width: 560, height: 720 },
    actions: {
      send: CrystalBallWindow.#onSend,
      newSitting: CrystalBallWindow.#onNewSitting,
      retry: CrystalBallWindow.#onRetry,
      copy: CrystalBallWindow.#onCopy,
      export: CrystalBallWindow.#onExport
    }
  };

  static PARTS = {
    // The transcript keeps its scroll through a redraw; _onRender moves it only for a reader at the end.
    main: { template: `modules/${MODULE_ID}/templates/window.hbs`, scrollable: [".crystalball-transcript"] }
  };

  /** The one window, so the button and the API reuse it. */
  static current = null;

  /**
   * Open the window centred, or show it when it is already open: a minimized one is restored
   * first, and a detached one's own browser window takes the focus.
   */
  static open() {
    CrystalBallWindow.current ??= new CrystalBallWindow();
    const app = CrystalBallWindow.current;
    if (app.rendered) {
      void app.maximize().then(() => app.bringToFront());
      return app;
    }
    void app.render({ force: true });
    return app;
  }

  /** Start a new sitting: through the window when it is open, so it empties too. */
  static newSitting() {
    const app = CrystalBallWindow.current;
    return app?.rendered ? app.newSitting() : postNewSitting();
  }

  /** The Service URL changed: the next call looks afresh, and an open window asks the new Seer now. */
  static refresh() {
    seerBase = null;
    const app = CrystalBallWindow.current;
    if (app?.rendered) void app.reload();
  }

  /** "loading" until the Seer has answered, then "ready" or "dark". */
  #phase = "loading";
  /** Why the ball is dark, as the line the transcript shows. */
  #darkLine = "";
  /** The model's family name from healthz (or the stream's meta). */
  #model = null;
  /** usage/me's body, for the count. */
  #usage = null;
  /** The sitting's turns: `{ role: "user" | "ball", text, error?, pending? }`. */
  #turns = [];
  /** An answer is streaming. */
  #busy = false;
  /** What the player has typed and not sent; it survives a redraw. */
  #draft = "";
  /** Bumped by every load, new sitting and close, so a late reply to an older one is dropped. */
  #gen = 0;
  /** The open stream's controller. */
  #abort = null;
  /** The next ask of a dark window. */
  #retryTimer = null;
  /** The streaming turn and its pending redraw. */
  #streaming = null;
  #paintTimer = null;
  /** Just opened: the input takes the focus once it is usable. */
  #wantFocus = false;
  /** The next redraw ends at the bottom whatever the scroll (a question sent, a sitting loaded). */
  #toBottom = true;
  /** Whether this redraw ends at the bottom: decided before the old transcript goes. */
  #stick = true;
  /** The New sitting in flight. */
  #renewing = null;
  /** The saying over an empty sitting: drawn anew when the window opens and on a new sitting. */
  #saying = "";

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const loading = this.#phase === "loading";
    const dark = this.#phase === "dark";
    const you = this.#asker();
    const length = this.#draft.length;
    return Object.assign(context, {
      loading,
      dark,
      darkLine: this.#darkLine,
      model: this.#model ?? t(dark ? "status.dark" : "status.loading"),
      count: this.#countLine(),
      intro: !loading && !dark && !this.#turns.length ? this.#saying : "",
      turns: this.#turns.map((turn, index) => ({
        index,
        user: turn.role === "user",
        copyable: turn.role === "ball" && !turn.pending && !!turn.text.trim(),
        who: turn.role === "user" ? you : t("turn.ball"),
        text: turn.role === "user" ? turn.text : "",
        html: turn.role === "ball" ? renderMarkdown(turn.text) : "",
        error: turn.error ?? "",
        note: turn.note ?? "",
        looking: turn.pending ? (turn.looking ?? "") : "",
        pending: !!turn.pending
      })),
      draft: this.#draft,
      counter: this.#counter(length),
      over: length > MESSAGE_LIMIT,
      inputOff: loading || dark,
      sendOff: !this.#canSend(),
      newOff: loading || dark || this.#busy || !!this.#renewing
    });
  }

  /** Draw a fresh saying, never the one just shown. */
  #drawSaying() {
    const key = `${MODULE_ID}.saying`;
    const lists = foundry.utils.getProperty(game.i18n.translations, key) ?? foundry.utils.getProperty(game.i18n._fallback, key);
    const name = game.user.character?.name ?? game.user.name ?? "";
    this.#saying = composeSaying(lists, { name, previous: this.#saying });
  }

  /** Who is asking, as the transcript and the export name them: the character, else the user. */
  #asker() {
    return game.user.character?.name ?? game.user.name ?? t("turn.you");
  }

  /**
   * The day's count against the player's allowance, shown only while the model has one: a null
   * day cap (a cheap model's) is no allowance, so there is nothing to count down.
   */
  #countLine() {
    const day = this.#usage?.user?.day;
    const max = this.#usage?.limits?.perUserDay;
    if (!Number.isFinite(day) || !Number.isFinite(max)) return "";
    return t("status.count", { n: day, max });
  }

  #counter(length) {
    return t("input.counter", { n: length.toLocaleString(game.i18n.lang), max: MESSAGE_LIMIT.toLocaleString(game.i18n.lang) });
  }

  #canSend() {
    const text = this.#draft.trim();
    return this.#phase === "ready" && !this.#busy && !!text && this.#draft.length <= MESSAGE_LIMIT;
  }

  /** @override */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    this.#wantFocus = true;
    this.#drawSaying();
    void this.reload();
  }

  /** @override */
  async _preRender(context, options) {
    await super._preRender(context, options);
    // A reader who scrolled up to read is left where they are; one at the end follows the end.
    this.#stick = this.#toBottom || this.#atBottom();
    this.#toBottom = false;
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const area = this.element.querySelector("textarea[name=message]");
    if (area) {
      area.addEventListener("input", () => {
        this.#draft = area.value;
        this.#syncInput();
      });
      area.addEventListener("keydown", ev => {
        // Enter sends, Shift+Enter is a newline; a composing IME keeps its Enter.
        if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
        ev.preventDefault();
        void this.send();
      });
      // The input takes the focus after a redraw unless the player is typing somewhere else (the
      // chat log, another window): a reply arriving must never pull the cursor away.
      const active = this.element.ownerDocument.activeElement;
      const free = !active || active === this.element.ownerDocument.body || this.element.contains(active);
      if (!area.disabled && (this.#wantFocus || free)) {
        this.#wantFocus = false;
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      }
    }
    if (this.#stick) this.#scrollDown();
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    // Closing ends the sitting's open answer: the Seer aborts the model call when the stream drops.
    // The next open starts from loading, never from what this one last showed.
    this.#abandon();
    this.#phase = "loading";
    this.#toBottom = true;
  }

  /**
   * Drop whatever answer is in flight: a later reply to it is ignored (the generation moves on),
   * its stream is aborted, and a ball turn left waiting stops pulsing and says it was cut.
   */
  #abandon() {
    this.#gen++;
    this.#abort?.abort();
    this.#abort = null;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#busy = false;
    this.#streaming = null;
    clearTimeout(this.#paintTimer);
    this.#paintTimer = null;
    for (const turn of this.#turns) {
      if (!turn.pending) continue;
      turn.pending = false;
      turn.error ||= t("errors.cut");
    }
  }

  /** The counter, its warning and the Send button follow the typing without a redraw. */
  #syncInput() {
    const el = this.element;
    if (!el) return;
    const counter = el.querySelector(".crystalball-counter");
    if (counter) {
      counter.textContent = this.#counter(this.#draft.length);
      counter.classList.toggle("over", this.#draft.length > MESSAGE_LIMIT);
    }
    const send = el.querySelector("[data-action=send]");
    if (send) send.disabled = !this.#canSend();
  }

  /**
   * The count in the bar, in place (no redraw under the player's typing); drawn once it first
   * exists, and gone when the allowance is (the Seer moved to a model with none).
   */
  async #showCount() {
    const el = this.element?.querySelector(".crystalball-count");
    const line = this.#countLine();
    if (el && line) el.textContent = line;
    else if (el) el.remove();
    else if (line && this.rendered) await this.render();
  }

  #transcript() {
    return this.element?.querySelector(".crystalball-transcript") ?? null;
  }

  #scrollDown() {
    const list = this.#transcript();
    if (list) list.scrollTop = list.scrollHeight;
  }

  /** The reader is at (or near) the end: a streamed answer keeps them there; one scrolled up stays put. */
  #atBottom() {
    const list = this.#transcript();
    return !list || list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  }

  /**
   * The ball goes dark with its line; `healable` arms the next ask (the Seer unreachable, its link
   * or world down, a server or network failure), a refusal does not. A window already dark with
   * the same line is left as drawn.
   */
  #goDark(line, healable = false) {
    const changed = this.#phase !== "dark" || this.#darkLine !== line;
    this.#phase = "dark";
    this.#darkLine = line;
    this.#busy = false;
    if (healable) this.#armRetry();
    else {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    return changed && this.rendered ? this.render() : undefined;
  }

  /** A dark window asks again after DARK_RETRY_MS, while it is open and still dark, staying dark meanwhile. */
  #armRetry() {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.rendered && this.#phase === "dark") void this.reload({ quiet: true });
    }, DARK_RETRY_MS);
  }

  /**
   * Ask the Seer from the start: healthz (dark when it does not answer, or when it has no link
   * to Foundry or no open world), then the open sitting and the count. A `quiet` reload (the dark
   * window's own re-ask) keeps what is on screen while it asks; the first load and Retry show the
   * loading state.
   */
  async reload({ quiet = false } = {}) {
    this.#abandon();
    const gen = this.#gen;
    const current = () => gen === this.#gen;
    if (!quiet) {
      this.#phase = "loading";
      if (this.rendered) await this.render();
    }
    const health = await findSeer(current);
    if (!current()) return;
    this.#model = health.ok ? modelLabel(health.body?.model) : null;
    const reason = health.ok ? darkReason(health.body) : "unreachable";
    if (reason) return this.#goDark(t(`dark.${reason}`), true);
    const [sitting, usage] = await Promise.all([call("sittings/current"), call("usage/me")]);
    if (!current()) return;
    if (!sitting.ok) return this.#goDark(failureLine(sitting.status, sitting.body), heals(sitting.status));
    const turns = Array.isArray(sitting.body?.turns) ? sitting.body.turns : [];
    this.#turns = turns.filter(turn => turn?.role === "user" || turn?.role === "ball").map(turn => ({ role: turn.role, text: String(turn.text ?? "") }));
    this.#usage = usage.ok ? usage.body : null;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#phase = "ready";
    this.#toBottom = true;
    if (this.rendered) await this.render();
  }

  /** Close the open sitting (the Seer keeps it) and start an empty one; once, however often clicked. */
  newSitting() {
    this.#renewing ??= this.#renew().finally(() => {
      this.#renewing = null;
    });
    return this.#renewing;
  }

  async #renew() {
    this.element?.querySelector("[data-action=newSitting]")?.setAttribute("disabled", "");
    this.#abandon();
    const gen = this.#gen;
    const sitting = await postNewSitting();
    if (gen !== this.#gen) return sitting;
    if (sitting) {
      this.#turns = [];
      this.#drawSaying();
    }
    if (this.rendered) await this.render();
    const usage = await call("usage/me");
    if (gen !== this.#gen || !usage.ok) return sitting;
    this.#usage = usage.body;
    await this.#showCount();
    return sitting;
  }

  /** Send what the player typed and stream the ball's answer into its turn. */
  async send() {
    if (!this.#canSend()) return;
    const text = this.#draft.trim();
    const gen = this.#gen;
    const ball = { role: "ball", text: "", pending: true, error: "", note: "", looking: "" };
    this.#turns.push({ role: "user", text }, ball);
    this.#draft = "";
    this.#busy = true;
    const abort = new AbortController();
    this.#abort = abort;
    const timer = setTimeout(() => abort.abort(), CHAT_TIMEOUT_MS);
    this.#toBottom = true;
    await this.render();

    // A failure before any answer (a refusal, an error event, a cut) gives the words back, so
    // nothing typed is lost.
    let giveBack = false;
    try {
      const url = endpoint("chat");
      const res = url
        ? await fetch(url, { method: "POST", headers: headers(true), body: JSON.stringify({ message: text }), cache: "no-store", signal: abort.signal })
        : null;
      if (!res?.ok || !res.body) {
        const body = res ? await res.json().catch(() => null) : null;
        ball.error = failureLine(res?.status ?? 0, body);
        giveBack = true;
      } else {
        const end = await this.#read(res.body, ball, gen);
        if (end === "cut") ball.error = t("errors.cut");
        if (end === "error" || end === "cut") giveBack = !ball.text;
      }
    } catch (err) {
      if (gen === this.#gen) {
        log.debug("the chat stream failed", err);
        ball.error = t(abort.signal.aborted ? "errors.timeout" : "errors.network");
        giveBack = !ball.text;
      }
    } finally {
      clearTimeout(timer);
      if (this.#abort === abort) this.#abort = null;
    }
    // Closed, reloaded or a new sitting meanwhile: that one owns the window now.
    if (gen !== this.#gen) return;

    // The answer's end shows at once; the count follows when the Seer gives it.
    ball.pending = false;
    this.#busy = false;
    this.#streaming = null;
    if (giveBack && !this.#draft) this.#draft = text;
    if (this.rendered) await this.render();
    const usage = await call("usage/me");
    if (gen !== this.#gen || !usage.ok) return;
    this.#usage = usage.body;
    await this.#showCount();
  }

  /**
   * Read the stream into the ball's turn: "done" or "error" once the stream has said its last word,
   * "cut" when it ended without one, "gone" when the window moved on meanwhile.
   */
  async #read(stream, ball, gen) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    const stop = () => void reader.cancel().catch(() => {});
    this.#streaming = ball;
    for (;;) {
      const { value, done } = await reader.read();
      if (gen !== this.#gen) {
        stop();
        return "gone";
      }
      const events = done ? [...parser.feed(decoder.decode()), ...parser.end()] : parser.feed(decoder.decode(value, { stream: true }));
      for (const { event, data } of events) {
        if (event === "meta") {
          this.#model = modelLabel(data?.model) ?? this.#model;
        } else if (event === "delta") {
          ball.text += typeof data?.text === "string" ? data.text : "";
          ball.looking = "";
          this.#paintSoon();
        } else if (event === "lookup") {
          // The ball is reading the rulebooks: said under its turn until its next words come.
          const line = lookupLine(data);
          if (line) ball.looking = t(line.key, line.data);
          this.#paintSoon();
        } else if (event === "done") {
          if (typeof data?.text === "string") ball.text = data.text;
          // The answer ran into the Seer's length cap: what came is kept, and the player told.
          if (data?.stop === "max_tokens") ball.note = t("long");
          stop();
          return "done";
        } else if (event === "error") {
          ball.error = failureLine(0, data);
          stop();
          return "error";
        }
        // Any other event (a heartbeat) is not the window's business.
      }
      if (done) return "cut";
    }
  }

  /** Redraw the streaming turn's text soon, not once per piece. */
  #paintSoon() {
    if (this.#paintTimer) return;
    this.#paintTimer = setTimeout(() => {
      this.#paintTimer = null;
      const ball = this.#streaming;
      const turns = this.element?.querySelectorAll(".crystalball-turn.ball.pending .crystalball-text");
      const el = turns?.[turns.length - 1];
      if (!ball || !el) return;
      const stick = this.#atBottom();
      el.innerHTML = renderMarkdown(ball.text);
      const looking = el.parentElement?.querySelector(".crystalball-looking");
      if (looking) looking.textContent = ball.looking ?? "";
      if (stick) this.#scrollDown();
    }, PAINT_MS);
  }

  /** One finished answer's words, as the ball wrote them (its Markdown), to the clipboard. */
  async copyTurn(index) {
    const turn = this.#turns[index];
    const text = turn?.role === "ball" && !turn.pending ? turn.text.trim() : "";
    if (!text) return;
    try {
      await game.clipboard.copyPlainText(text);
      ui.notifications.info(t("copy.done"));
    } catch (err) {
      log.debug("the browser refused the copy", err);
      ui.notifications.warn(t("copy.failed"));
    }
  }

  /**
   * The sitting as a Markdown file the browser saves to its downloads (the family's Export): what
   * the transcript shows, an answer still being written left out. Nothing is written anywhere else.
   */
  exportSitting() {
    const turns = this.#turns.filter(turn => !turn.pending);
    const n = questionsIn(turns);
    if (!n) return ui.notifications.warn(t("export.none"));
    const asker = this.#asker();
    const now = new Date();
    const markdown = sittingMarkdown({
      title: t("export.title", { name: asker }),
      world: game.world?.title ?? "",
      saved: now.toLocaleString(game.i18n.lang, { dateStyle: "long", timeStyle: "short" }),
      you: asker,
      ball: t("turn.ball"),
      turns
    });
    // The file is named for the local day, as the family's exports are.
    const name = sittingFileName(asker, now.toLocaleDateString("en-CA"));
    foundry.utils.saveDataToFile(markdown, "text/markdown", name);
    ui.notifications.info(t(n === 1 ? "export.doneOne" : "export.done", { name, n }));
  }

  /* -------------------------------------------------- */
  /*  Actions                                            */
  /* -------------------------------------------------- */

  static #onSend() {
    void this.send();
  }

  static #onNewSitting() {
    void this.newSitting();
  }

  static #onRetry() {
    void this.reload();
  }

  static #onCopy(_event, target) {
    void this.copyTurn(Number(target.dataset.turn));
  }

  static #onExport() {
    this.exportSitting();
  }
}
