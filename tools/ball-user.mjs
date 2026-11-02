// The ball's user on a sandbox: the Player-role Foundry user the Seer logs in as, made or reset
// through a GM page (the MCP's bridge), so a mirrored sandbox can be given one in a minute. On prod
// it runs the same way on the user's word (FOUNDRY_HOST=generic FVTT_MCP_ENV=<the prod env>, no --env: the
// box's env file carries the password), with the sandbox's password so a mirror keeps both Seers joined.
//
//   FOUNDRY_HOST=local node tools/ball-user.mjs --name "Crystal Ball" --password <pw>
//   FOUNDRY_HOST=local node tools/ball-user.mjs --name "Crystal Ball" --password <pw> --env seer/.env
//
// Finds the user by exact name, creates it (role Player, no character) when absent, sets the
// password either way, and prints the id. With --env, writes BALL_USER and BALL_PASSWORD into that
// file (made from seer/.env.example when it does not exist), replacing the lines in place.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Foundry, foundryConfig, loadEnv } from "fvtt-mcp-dnd5e/client";

const arg = n => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const name = arg("name") ?? "Crystal Ball";
const password = arg("password");
const envFile = arg("env");
if (!password) {
  console.error('usage: FOUNDRY_HOST=local node tools/ball-user.mjs --name "Crystal Ball" --password <pw> [--env seer/.env]');
  process.exit(2);
}

setTimeout(() => {
  console.error("[ball-user] WATCHDOG: 90s elapsed, aborting");
  process.exit(3);
}, 90_000).unref();

const env = loadEnv();
const f = new Foundry(foundryConfig(env));
console.log("[ball-user] connecting as the GM…");
await f.connect();
let result;
try {
  result = await f.evaluate(
    async ({ name, password }) => {
      try {
        let user = game.users.find(u => u.name === name) ?? null;
        let made = false;
        if (!user) {
          user = await User.create({ name, role: CONST.USER_ROLES.PLAYER, password });
          made = true;
        } else {
          await user.update({ password });
        }
        return { id: user.id, name: user.name, role: user.role, made };
      } catch (err) {
        return { error: err?.message ?? String(err) };
      }
    },
    { name, password }
  );
} finally {
  await f.disconnect?.().catch(() => {});
}
if (result?.error) {
  console.error(`[ball-user] FAILED: ${result.error}`);
  process.exit(1);
}
console.log(`[ball-user] ${result.made ? "created" : "reset"} ${result.name} (${result.id}), role ${result.role}`);

if (envFile) {
  const example = "seer/.env.example";
  let text = existsSync(envFile) ? readFileSync(envFile, "utf8") : readFileSync(example, "utf8");
  const put = (key, value) => {
    const line = `${key}=${value}`;
    text = new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${text.trimEnd()}\n${line}\n`;
  };
  put("BALL_USER", name);
  put("BALL_PASSWORD", password);
  writeFileSync(envFile, text);
  console.log(`[ball-user] ${envFile} updated`);
}
