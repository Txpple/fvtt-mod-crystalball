// After a prod -> sandbox mirror the sandbox inherits prod's Service URL ("/crystalball", a path only prod's
// tunnel routes), so the ball goes dark. This sets the sandbox's back to its own Seer. Sandbox only (plain .env).
//   node tools/sandbox-service-url.mjs [--seer http://localhost:30001/crystalball]
import { Foundry, foundryConfig, loadEnv } from "fvtt-mcp-dnd5e/client";

const i = process.argv.indexOf("--seer");
const seerUrl = (i >= 0 ? process.argv[i + 1] : "http://localhost:30001/crystalball").replace(/\/+$/, "");
const f = new Foundry(foundryConfig(loadEnv()));
await f.connect();
try {
  const r = await f.evaluate(
    async ({ seerUrl }) => {
      const id = "fvtt-mod-crystalball";
      const before = game.settings.get(id, "serviceUrl");
      if (before !== seerUrl) await game.settings.set(id, "serviceUrl", seerUrl);
      return { world: game.world.id, before, after: game.settings.get(id, "serviceUrl") };
    },
    { seerUrl }
  );
  console.log(JSON.stringify(r));
} finally {
  await f.disconnect?.().catch(() => {});
}
process.exit(0);
