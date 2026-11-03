// The live check on a real world (the local sandbox), Clue Board's in shape: a GM page (the bridge
// user) and a temporary player page, every fact read from the world and from the Seer.
//
//   FOUNDRY_HOST=local node tools/live-check.mjs                                  # registration, nothing written
//   FOUNDRY_HOST=local node tools/live-check.mjs --walk [--seer <url>] [--default-url] [--asker Kartor]
//     [--question "<text>"] [--expect-lookup]
//
// Without --walk: the module active, its world settings registered as the contract names them,
// the button on the GM page's strip right after Clue Board's (no tab, no action), the
// window it opens centred, and, with the default Service URL, lit by the Seer on the companion
// port when one runs there (the bar clear and ready, the model only in the GM's tooltip) and dark
// when none does.
//
// With --walk: a temporary player (assigned the --asker member's character and Owner on it for
// the run) opens the window against the Seer at --seer (default http://localhost:30001/crystalball,
// the Seer's BASE_PATH included; the Service URL setting is pointed there for the run, or left at
// the contract's default with --default-url, so the window finds the Seer on the companion port
// as a sandbox's does), sends a question with Enter, waits for the ball's answer to finish, checks
// the stub's sentence when the Seer runs its stub model, that the bar says the ball is clear and
// ready and names no model to the player, that usage/me moved by one and the bar shows a count
// only while the model has an allowance, that the answer can be selected and its copy button
// copies the ball's words, that Export saves the sitting as Markdown, and that New sitting empties
// the transcript. The temp user, its ownership and the setting go in `finally`.
// --question asks something else; --expect-lookup asserts the window showed the rulebook lookup
// line under the pending turn (a rules question on a real model).
import { readFileSync } from "node:fs";
import { Foundry, foundryConfig, loadEnv } from "fvtt-mcp-dnd5e/client";
import { DEFAULT_LEAVE_OUT, DEFAULT_RULEBOOKS } from "../scripts/decide/rulebooks.js";
import { modelLabel } from "../scripts/decide/session.js";

const env = loadEnv();
const MODULE_ID = "fvtt-mod-crystalball";
/** The bar's words, as lang/en.json has them. */
const STATUS = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"))[MODULE_ID].status;
const TEMP_USER = "ZZ-BALL Asker";
const argOf = n => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const QUESTION = argOf("question") ?? "What do we know about the Lamp of 1391?";
const expectLookup = process.argv.includes("--expect-lookup");
const SETTINGS = {
  enabled: { type: "Boolean", default: true },
  serviceUrl: { type: "String", default: "/crystalball" },
  tableNotes: { type: "String", default: "" },
  askers: { type: "String", default: "players", choices: ["players", "listed"] },
  askerIds: { type: "String", default: "" },
  rulebooks: { type: "String", default: DEFAULT_RULEBOOKS },
  rulebookLeaveOut: { type: "String", default: DEFAULT_LEAVE_OUT }
};

const arg = n => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const walk = process.argv.includes("--walk");
const seerUrl = (arg("seer") ?? "http://localhost:30001/crystalball").replace(/\/+$/, "");
/** The Service URL written for the walk: the Seer's address, or the default the window searches from. */
const settingUrl = process.argv.includes("--default-url") ? "/crystalball" : seerUrl;
const askerName = arg("asker") ?? "Kartor";

let fails = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) fails++;
};
/** Console lines the pages print that name the module, or any error or warning at all. */
function watch(f, label, sink) {
  const page = f.page;
  if (!page) return;
  page.on("console", msg => {
    const text = msg.text();
    const type = msg.type();
    if (type === "error" || type === "warning" || /crystal ?ball/i.test(text)) sink.push(`[${label} ${type}] ${text}`);
  });
  page.on("pageerror", err => sink.push(`[${label} pageerror] ${err?.message ?? err}`));
  page.on("response", res => {
    if (res.status() >= 400) sink.push(`[${label} http ${res.status()}] ${res.url()}`);
  });
}

let cleanup = async () => {};
setTimeout(async () => {
  console.error("[crystalball] WATCHDOG: 300s elapsed, cleaning up and aborting");
  await cleanup().catch(() => {});
  process.exit(3);
}, 300_000).unref();

const lines = [];
const f = new Foundry(foundryConfig(env));
console.log("[crystalball] connecting as the GM…");
await f.connect();
watch(f, "gm", lines);

let temp = null;
let fp = null;
/** The Service URL before the run, once the walk has changed it. */
let priorUrl = null;
/** The one cleanup, run by `finally` or by the watchdog, whichever comes first. */
cleanup = async () => {
  cleanup = async () => {};
  if (fp) await fp.disconnect?.().catch(() => {});
  if (temp?.userId || priorUrl !== null) {
    await f
      .evaluate(
        async ({ id, actorId, userId, had, priorUrl }) => {
          if (priorUrl !== null) await game.settings.set(id, "serviceUrl", priorUrl);
          if (userId) {
            const actor = game.actors.get(actorId);
            if (actor) {
              // The whole map, replaced: a deletion operator inside ownership fails its validation
              // on v14, and a key left for a deleted user is litter on the actor.
              const ownership = { ...actor.ownership };
              if (had === null) delete ownership[userId];
              else ownership[userId] = had;
              await actor.update({ ownership }, { recursive: false, diff: false });
            }
            await game.users.get(userId)?.delete();
          }
        },
        { id: MODULE_ID, actorId: temp?.actorId ?? null, userId: temp?.userId ?? null, had: temp?.had ?? null, priorUrl }
      )
      .catch(err => console.log(`  cleanup: ${err?.message ?? err}`));
  }
  await f.disconnect?.().catch(() => {});
};

try {
  // --- A. registration --------------------------------------------------------------------
  console.log("# A. registration");
  const A = await f.evaluate(
    async ({ id, settings }) => {
      const m = game.modules.get(id);
      const strip = [...document.querySelectorAll("#sidebar nav.tabs menu > li > button")];
      const button = document.getElementById("crystalball-button");
      const at = strip.indexOf(button);
      const before = at > 0 ? strip[at - 1] : null;
      const registered = {};
      for (const key of Object.keys(settings)) {
        const s = game.settings.settings.get(`${id}.${key}`);
        registered[key] = s
          ? {
              scope: s.scope,
              config: s.config,
              type: s.type?.name ?? s.type?.constructor?.name ?? null,
              default: s.default,
              choices: s.choices ? Object.keys(s.choices) : null
            }
          : null;
      }
      const probe = document.createElement("div");
      probe.className = "crystalball-css-probe";
      document.body.append(probe);
      const css = getComputedStyle(probe).flexDirection === "column";
      probe.remove();
      const iconVar = button?.style.getPropertyValue("--crystalball-tab-icon") ?? "";
      const iconUrl = /url\("?([^")]+)"?\)/.exec(iconVar)?.[1] ?? null;
      const iconStatus = iconUrl ? (await fetch(iconUrl)).status : null;

      const serviceUrl = game.settings.get(id, "serviceUrl");
      const tab = ui.sidebar.tabGroups.primary;
      const expanded = ui.sidebar.expanded;
      button?.click();
      let win = null;
      for (let i = 0; i < 100; i++) {
        win = foundry.applications.instances.get("crystalball-window");
        const settled = win?.element?.querySelector(".crystalball-body:not(.is-loading)");
        if (settled) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const el = win?.element;
      const rect = el?.getBoundingClientRect();
      const centred = rect ? Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2) < window.innerWidth * 0.15 : false;
      const state = {
        dark: !!el?.querySelector(".crystalball-body.is-dark"),
        darkLine: el?.querySelector(".crystalball-dark")?.textContent?.trim() ?? null,
        retry: !!el?.querySelector('[data-action="retry"]'),
        inputOff: !!el?.querySelector("textarea[name=message]")?.disabled,
        state: el?.querySelector(".crystalball-state")?.textContent?.trim() ?? null,
        modelHint: el?.querySelector(".crystalball-state")?.getAttribute("data-tooltip") ?? null,
        title: win?.title ?? null
      };
      await win?.close();
      return {
        installed: !!m,
        active: !!m?.active,
        version: m?.version,
        api: typeof m?.api?.open === "function" && typeof m?.api?.newSitting === "function",
        registered,
        // The GM's gaze went in 1.0.8: no setting by that key.
        gmGazeGone: !game.settings.settings.has(`${id}.gmGaze`),
        css,
        button: !!button,
        buttonClass: button?.className ?? null,
        tooltip: button?.dataset.tooltip ?? null,
        label: button?.getAttribute("aria-label") ?? null,
        noTab: !!button && !button.dataset.tab && !button.dataset.action,
        before: before ? before.id || before.dataset.tab || before.className : null,
        clueboardActive: !!game.modules.get("fvtt-mod-clueboard")?.active,
        iconUrl,
        iconStatus,
        cardcatalogueIcons: document.body.classList.contains("cardcatalogue-tab-icons"),
        opened: !!win,
        centred,
        sidebarStill: ui.sidebar.tabGroups.primary === tab && ui.sidebar.expanded === expanded,
        serviceUrl,
        state,
        isGM: game.user.isGM,
        user: game.user.name
      };
    },
    { id: MODULE_ID, settings: SETTINGS }
  );
  console.log(`  bridge user ${A.user} (GM=${A.isGM}); module ${A.installed ? `v${A.version} active=${A.active}` : "NOT INSTALLED"}`);
  assert(A.active, "the module is active");
  if (!A.active) throw new Error("module not active; register and enable it, then restart the world");
  assert(A.api, "the API is on the module (open, newSitting)");
  assert(A.gmGazeGone, "The GM's gaze is not registered");
  for (const [key, want] of Object.entries(SETTINGS)) {
    const got = A.registered[key];
    const ok =
      !!got &&
      got.scope === "world" &&
      got.config === true &&
      got.default === want.default &&
      (!want.choices || JSON.stringify(got.choices) === JSON.stringify(want.choices));
    assert(ok, `the setting ${key} is registered: world, config, default ${JSON.stringify(want.default)}${want.choices ? `, choices ${want.choices.join("/")}` : ""} (${JSON.stringify(got)})`);
  }
  assert(A.css, "the stylesheet reached the cascade");
  assert(A.button && /fa-crystal-ball/.test(A.buttonClass), `the button is on the strip with the crystal ball glyph (${A.buttonClass})`);
  assert(A.label === "Crystal Ball" && A.tooltip === "Crystal Ball", `its aria-label and tooltip say Crystal Ball (${A.label} / ${A.tooltip})`);
  assert(A.noTab, "the button is no tab: no data-tab, no data-action");
  if (A.clueboardActive) assert(A.before === "clueboard-mysteries-button", `the button sits right after Clue Board's (after "${A.before}")`);
  else assert(A.before === "journal", `Clue Board is off: the button sits right after Journal (after "${A.before}")`);
  assert(A.iconStatus === 200, `the painted picture is served (${A.iconUrl} → ${A.iconStatus}; Card Catalogue's icons ${A.cardcatalogueIcons ? "on" : "off"})`);
  assert(A.opened && A.centred, "the button opens the window, centred");
  assert(A.state.title === "Crystal Ball", `the window is titled Crystal Ball (${A.state.title})`);
  assert(A.sidebarStill, "the click left the sidebar's tab and its expansion as they were");
  console.log(`  Service URL: ${A.serviceUrl}; the window: "${A.state.state}" (tooltip "${A.state.modelHint ?? ""}"), dark=${A.state.dark}`);
  if (A.serviceUrl === "/crystalball") {
    // No tunnel on the sandbox: Foundry itself answers /crystalball/healthz with a 404, and the window
    // then tries the companion port of the page's host (the GM page is on localhost).
    const companion = await fetch("http://localhost:30001/crystalball/healthz")
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
    if (companion) {
      assert(!A.state.dark && !A.state.inputOff, `with the default Service URL the window found the Seer ${companion.version} on the companion port`);
      assert(A.state.state === STATUS.ready, `the bar says "${STATUS.ready}" ("${A.state.state}")`);
      const hint = STATUS.model.replace("{model}", modelLabel(companion.model) ?? "");
      assert(A.state.modelHint === hint, `the GM's tooltip on the bar names the model ("${A.state.modelHint ?? ""}"; healthz: ${companion.model})`);
    } else assert(A.state.dark && A.state.retry && A.state.inputOff, `with no Seer at the default path nor on the companion port the ball is dark, the input off, Retry offered ("${A.state.darkLine}")`);
  }

  if (walk) {
    // --- B. a temporary player, the asker ------------------------------------------------
    console.log(`# B. a temporary player (${askerName}), the Seer at ${seerUrl}`);
    const health = await fetch(`${seerUrl}/healthz`)
      .then(r => r.json())
      .catch(err => ({ error: err?.message ?? String(err) }));
    console.log(`  healthz: ${JSON.stringify(health)}`);
    assert(!health.error && health.foundry?.connected && health.foundry?.worldOpen, "the Seer answers healthz, linked to an open world");
    if (health.error) throw new Error(`no Seer at ${seerUrl}`);

    temp = await f.evaluate(
      async ({ id, userName, askerName, settingUrl }) => {
        const asker = game.actors.find(a => a.type === "character" && a.name.startsWith(askerName));
        if (!asker) return { error: `no character named ${askerName}` };
        const party = game.actors.find(a => a.type === "group" && Array.from(a.system.members ?? []).some(m => m.actor?.id === asker.id));
        const user =
          game.users.find(u => u.name === userName) ??
          (await User.implementation.create({ name: userName, role: CONST.USER_ROLES.PLAYER, character: asker.id }));
        if (user.character?.id !== asker.id) await user.update({ character: asker.id });
        const had = asker.ownership[user.id] ?? null;
        await asker.update({ [`ownership.${user.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
        const priorUrl = game.settings.get(id, "serviceUrl");
        if (priorUrl !== settingUrl) await game.settings.set(id, "serviceUrl", settingUrl);
        return {
          userId: user.id,
          actorId: asker.id,
          actorName: asker.name,
          had,
          priorUrl,
          party: party?.name ?? null,
          partyClues: party ? Object.keys(party.flags?.["fvtt-mod-clueboard"]?.entries ?? {}).length : 0,
          partyMembers: party ? Array.from(party.system.members ?? []).filter(m => m.actor).length : 0,
          classLevel: Object.values(asker.classes ?? {})
            .map(c => `${c.name} ${c.system.levels}`)
            .join(" / "),
          askers: game.settings.get(id, "askers"),
          enabled: game.settings.get(id, "enabled")
        };
      },
      { id: MODULE_ID, userName: TEMP_USER, askerName, settingUrl }
    );
    if (temp.error) throw new Error(temp.error);
    priorUrl = temp.priorUrl;
    console.log(
      `  temp user ${TEMP_USER} (${temp.userId}) asks as ${temp.actorName} (${temp.classLevel}), of "${temp.party}" (${temp.partyMembers} members, ${temp.partyClues} clues on its board)`
    );
    console.log(`  Who may ask: ${temp.askers}; enabled: ${temp.enabled}; Service URL ${temp.priorUrl} → ${settingUrl} for the run${settingUrl === "/crystalball" ? " (the default: the window searches the companion port)" : ""}`);

    fp = new Foundry({ ...foundryConfig(env), user: TEMP_USER, password: "" });
    console.log("[crystalball] connecting as the player…");
    await fp.connect();
    watch(fp, "player", lines);

    // --- C. the player asks the ball ------------------------------------------------------
    console.log("# C. the player asks the ball");
    const C = await fp.evaluate(
      async ({ id, question }) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const until = async (test, ms) => {
          for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
            const v = test();
            if (v) return v;
          }
          return null;
        };
        const setting = game.settings.get(id, "serviceUrl").replace(/\/+$/, "");
        // As the window resolves it: the default names Foundry's own origin, which serves nothing here,
        // so the Seer is on the companion port of the page's host.
        const base = setting.startsWith("/") ? `${location.protocol}//${location.hostname}:30001${setting}` : setting;
        const cookieSession = document.cookie.split("; ").some(c => c.startsWith("session="));
        // As the window takes it: the socket's id first, the cookie only on an older build.
        const session =
          game.socket?.session?.sessionId ??
          decodeURIComponent(Object.fromEntries(document.cookie.split("; ").map(c => c.split("="))).session ?? "");
        const usageNow = () =>
          fetch(`${base}/usage/me`, { headers: { "X-Foundry-Session": session } })
            .then(r => r.json())
            .catch(() => null);

        const win = game.modules.get(id).api.open();
        const settled = await until(() => win.element?.querySelector(".crystalball-body:not(.is-loading)"), 20_000);
        const el = win.element;
        const state = el?.querySelector(".crystalball-state")?.textContent?.trim() ?? null;
        const modelHint = el?.querySelector(".crystalball-state")?.getAttribute("data-tooltip") ?? null;
        const darkLine = el?.querySelector(".crystalball-dark")?.textContent?.trim() ?? null;
        const countBefore = el?.querySelector(".crystalball-count")?.textContent?.trim() ?? null;
        const intro = el?.querySelector(".crystalball-intro")?.textContent?.trim() ?? null;
        const turnsBefore = el?.querySelectorAll(".crystalball-turn").length ?? 0;
        const balls = () => [...(win.element?.querySelectorAll(".crystalball-turn.ball") ?? [])];
        const ballsBefore = balls().length;
        const usageBefore = await usageNow();
        const socketSession = game.socket?.session?.sessionId ?? null;
        if (!settled || darkLine) return { settled: !!settled, state, modelHint, darkLine, cookieSession, socketSession };

        // Type and press Enter, as a player would.
        const area = el.querySelector("textarea[name=message]");
        area.value = question;
        area.dispatchEvent(new Event("input", { bubbles: true }));
        const counter = el.querySelector(".crystalball-counter")?.textContent?.trim() ?? null;
        area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        // The send redraws before it streams: wait for the new turn, then for it to finish.
        const started = await until(() => balls().length > ballsBefore, 5_000);
        const t0 = Date.now();
        // Every rulebook line the pending turn shows while the ball looks things up.
        const looked = [];
        const finished = await until(() => {
          const last = balls().length > ballsBefore ? balls().pop() : null;
          const line = last?.querySelector(".crystalball-looking")?.textContent?.trim();
          if (line && looked.at(-1) !== line) looked.push(line);
          return last && !last.classList.contains("pending") ? last : null;
        }, 200_000);
        const ms = Date.now() - t0;
        // The text with each drawn <br> read as the newline it was.
        const textOf = node => {
          const clone = node?.cloneNode(true);
          for (const br of clone?.querySelectorAll("br") ?? []) br.replaceWith("\n");
          return clone?.textContent?.trim() ?? "";
        };
        const answer = textOf(finished?.querySelector(".crystalball-text"));
        const answerHtml = finished?.querySelector(".crystalball-text")?.innerHTML ?? "";
        const error = finished?.querySelector(".crystalball-error")?.textContent?.trim() ?? null;
        const userTurn = [...win.element.querySelectorAll(".crystalball-turn.user .crystalball-text")].pop()?.textContent ?? null;
        const usageAfter = await usageNow();
        // A count only while the model has an allowance: then it moves, else there is none to show.
        const capped = Number.isFinite(usageAfter?.limits?.perUserDay);
        if (capped) await until(() => win.element?.querySelector(".crystalball-count")?.textContent?.trim() !== countBefore, 5_000);
        const countAfter = win.element?.querySelector(".crystalball-count")?.textContent?.trim() ?? null;
        const draftCleared = win.element?.querySelector("textarea[name=message]")?.value === "";

        // The words can be selected; the finished answer's copy button copies the ball's own words.
        const last = balls().pop();
        const selectable = last ? getComputedStyle(last.querySelector(".crystalball-text")).userSelect : null;
        const sittingNow = await fetch(`${base}/sittings/current`, { headers: { "X-Foundry-Session": session } })
          .then(r => r.json())
          .catch(() => null);
        const ballWords = [...(sittingNow?.turns ?? [])].reverse().find(turn => turn.role === "ball")?.text ?? null;
        let copied = null;
        const clip = game.clipboard.copyPlainText;
        game.clipboard.copyPlainText = async text => {
          copied = text;
        };
        try {
          last?.querySelector('[data-action="copy"]')?.click();
          await until(() => copied !== null, 3_000);
        } finally {
          game.clipboard.copyPlainText = clip;
        }

        // Export: the file the browser would save, caught at its download link (foundry.utils is a
        // module namespace, so its saveDataToFile cannot be swapped). The blob is read at once, before
        // Foundry revokes its URL.
        let caught = null;
        const anchor = HTMLAnchorElement.prototype;
        const own = { click: Object.hasOwn(anchor, "click"), dispatchEvent: Object.hasOwn(anchor, "dispatchEvent") };
        const { click, dispatchEvent } = anchor;
        const take = a => {
          if (!a.download) return false;
          caught = { filename: a.download, blob: fetch(a.href).then(r => r.blob()) };
          return true;
        };
        anchor.click = function () {
          if (!take(this)) return click.call(this);
        };
        anchor.dispatchEvent = function (event) {
          return event?.type === "click" && take(this) ? true : dispatchEvent.call(this, event);
        };
        let saved = null;
        try {
          win.element.querySelector('[data-action="export"]')?.click();
          await until(() => caught, 3_000);
          const blob = await caught?.blob;
          saved = caught ? { filename: caught.filename, type: blob?.type ?? null, data: (await blob?.text()) ?? null } : null;
        } finally {
          if (own.click) anchor.click = click;
          else delete anchor.click;
          if (own.dispatchEvent) anchor.dispatchEvent = dispatchEvent;
          else delete anchor.dispatchEvent;
        }

        // New sitting: the transcript empties and the first line shows again.
        win.element.querySelector('[data-action="newSitting"]')?.click();
        const emptied = await until(() => !win.element?.querySelector(".crystalball-turn") && win.element?.querySelector(".crystalball-intro"), 10_000);
        const current = await fetch(`${base}/sittings/current`, { headers: { "X-Foundry-Session": session } })
          .then(r => r.json())
          .catch(() => null);
        await win.close();
        return {
          settled: !!settled,
          state,
          modelHint,
          darkLine,
          cookieSession,
          socketSession,
          intro,
          turnsBefore,
          countBefore,
          countAfter,
          counter,
          started: !!started,
          finished: !!finished,
          ms,
          answer,
          answerHtml,
          error,
          userTurn,
          usageBefore,
          usageAfter,
          capped,
          draftCleared,
          selectable,
          ballWords,
          copied,
          saved,
          asker: game.user.character?.name ?? game.user.name,
          looked,
          emptied: !!emptied,
          currentTurns: Array.isArray(current?.turns) ? current.turns.length : null
        };
      },
      { id: MODULE_ID, question: QUESTION }
    );
    // The id the window sends: the one Foundry's socket was handed. It must be the browser's own
    // session cookie, the one the Seer probes with.
    const jar = (await fp.page.context().cookies()).find(c => c.name === "session") ?? null;
    console.log(`  the session cookie: httpOnly=${jar?.httpOnly}, ${C.cookieSession ? "readable" : "not readable"} from document.cookie`);
    assert(!!jar && !!C.socketSession && decodeURIComponent(jar.value) === C.socketSession, "the id the window sends (the socket's) is the browser's session cookie");
    assert(C.settled && !C.darkLine, `the window settled, not dark ("${C.darkLine ?? ""}")`);
    assert(C.state === STATUS.ready, `the bar says "${STATUS.ready}" ("${C.state}")`);
    assert(!C.modelHint, `the bar names no model to a player ("${C.modelHint ?? ""}"; healthz: ${health.model})`);
    if (C.settled && !C.darkLine) {
      if (C.turnsBefore === 0) assert(!!C.intro, `an empty sitting shows the first line ("${C.intro?.slice(0, 80)}…")`);
      assert(C.counter === `${QUESTION.length} / 4,000`, `the counter follows the typing (${C.counter})`);
      assert(C.started && C.finished, `Enter sent it and the ball's turn finished (${C.ms} ms)`);
      assert(!C.error, `the ball's turn carries no error line (${C.error ?? "none"})`);
      assert(C.answer.length > 0, `the answer is not empty: "${C.answer.slice(0, 160)}"`);
      assert(C.userTurn === QUESTION, "the player's turn shows the question as typed");
      assert(C.draftCleared, "the input emptied on send");
      console.log(`  the lookup lines shown: ${C.looked.length ? C.looked.map(l => `"${l}"`).join(", ") : "none"}`);
      if (expectLookup) assert(C.looked.length > 0, "the window showed the ball looking in the rulebooks");
      if (health.model !== "stub") console.log(`  the answer:
${C.answer.replace(/^/gm, "    ")}`);
      if (health.model === "stub") {
        const m =
          /The Crystal Ball is clouded \(stub\)\. I see (\d+) shared pages, (\d+) clues, (\d+) party members\s+and your character (.+?) \((.+?)\)\. You asked: "(.*)"\./s.exec(
            C.answer
          );
        assert(!!m, "the stub's sentence, as the contract words it");
        if (m) {
          const [, pages, clues, members, name, classLevel, asked] = m;
          console.log(`  stub: ${pages} shared pages, ${clues} clues, ${members} party members, ${name} (${classLevel})`);
          assert(name === temp.actorName, `the stub names the asker's character (${name})`);
          assert(Number(clues) > 0, `the stub counts the party's clues (${clues}; the board holds ${temp.partyClues})`);
          assert(asked === QUESTION, "the stub repeats the question");
        }
      }
      const before = C.usageBefore?.user?.day;
      const after = C.usageAfter?.user?.day;
      assert(Number.isFinite(before) && after === before + 1, `usage/me moved by one (${before} → ${after})`);
      if (C.capped) assert(!!C.countAfter && C.countAfter !== C.countBefore, `the bar's count moved ("${C.countBefore}" → "${C.countAfter}")`);
      else assert(C.countBefore === null && C.countAfter === null, `no count in the bar: the model has no allowance ("${C.countAfter ?? ""}")`);
      assert(C.selectable === "text", `the answer's words can be selected (user-select: ${C.selectable})`);
      assert(!!C.copied && C.copied === C.ballWords?.trim(), `the copy button copied the ball's words (${C.copied?.length ?? 0} characters)`);
      const day = new Date().toLocaleDateString("en-CA");
      const slug = C.asker.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      assert(C.saved?.filename === `crystalball-${slug}-${day}.md` && C.saved?.type === "text/markdown", `Export saved ${C.saved?.filename ?? "nothing"} (${C.saved?.type ?? "-"})`);
      assert(!!C.saved?.data?.includes(`## ${C.asker}\n\n${QUESTION}`) && C.saved.data.includes("## The Crystal Ball"), "the export holds the question and the ball's answer under their speakers");
      assert(C.emptied, "New sitting emptied the transcript and showed the first line again");
      assert(C.currentTurns === 0, `the Seer's open sitting is empty after New sitting (${C.currentTurns} turns)`);
    }
  }
} finally {
  await cleanup();
}

// --- the console --------------------------------------------------------------------------
console.log("# console");
// The GM page's default Service URL is a path the sandbox serves nothing at: those 404s are the dark state working.
const expected = l => /http 404\] .*\/crystalball\/(healthz|sittings|usage)/.test(l) || /Failed to load resource.*404/.test(l);
const shown = lines.filter(l => !expected(l));
for (const l of shown.slice(0, 40)) console.log(`  ${l}`);
if (shown.length > 40) console.log(`  … ${shown.length - 40} more`);
// Ours: an error naming the module, or any error about the Seer's address (a CORS refusal names only that).
const seerHost = new URL(seerUrl).host;
const ours = shown.filter(l => (/crystal ?ball/i.test(l) || l.includes(seerHost)) && /error|pageerror/.test(l));
assert(ours.length === 0, `no errors of the module's on either page (${ours.length})`);
console.log(fails ? `RED (${fails} failed)` : "GREEN");
process.exit(fails ? 1 : 0);
