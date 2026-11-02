/**
 * The Seer's entry point (`node seer/src/main.js`), and nothing but: it always runs, so no
 * "am I the main module" guard can misjudge a symlinked or extension-less path and exit silently
 * under a supervisor. It keeps to syntax an old Node parses (no `?.`, no `??`, no top-level
 * await), so a distribution's Node 12 or 18 reaches the version check and says so in one line
 * instead of failing on a newer construct; everything else loads only after the check.
 */

const REQUIRED_MAJOR = 24;
const major = Number(String(process.versions.node).split(".")[0]);

// The journal's error priority when stderr is the journal, as log.js writes it.
const PRIORITY = process.env.JOURNAL_STREAM ? "<3>" : "";

const line = (level, message, error) => {
  const fields = JSON.stringify({
    error: (error && (error.stack || error.message)) || String(error)
  });
  return `${PRIORITY}${new Date().toISOString()} ${level} ${message} ${fields}`;
};

if (!(major >= REQUIRED_MAJOR)) {
  console.error(
    `crystalball seer: Node ${REQUIRED_MAJOR} or newer is required, this is Node ${process.versions.node} (${process.execPath}); see seer/deploy/README.md`
  );
  process.exit(1);
} else {
  // One stray throw must not take every open answer stream down with it: it is logged and the
  // Seer keeps serving. A second within the window means something is wedged, and the process
  // exits so the supervisor starts a fresh one.
  const WINDOW_MS = 30000;
  let lastFault = Number.NEGATIVE_INFINITY;
  const fault = kind => error => {
    const now = performance.now();
    console.error(line("ERROR", `seer: ${kind}; serving on`, error));
    if (now - lastFault < WINDOW_MS) {
      console.error(
        line("ERROR", `seer: a second fault within ${WINDOW_MS / 1000} s; exiting`, error)
      );
      process.exit(1);
    }
    lastFault = now;
  };
  process.on("uncaughtException", fault("uncaught exception"));
  process.on("unhandledRejection", fault("unhandled rejection"));

  import("./start.js")
    .then(m => m.start())
    .catch(err => {
      // biome-ignore lint/complexity/useOptionalChain: this file keeps to syntax an old Node parses
      const message = (err && err.message) || String(err);
      console.error(line("ERROR", "seer: could not start", { message }));
      process.exit(1);
    });
}
