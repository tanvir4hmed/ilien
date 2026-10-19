import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
for (const [name, entry] of Object.entries({
  api: "apps/api/src/handler.ts",
  relay: "apps/workers/src/relay.ts",
  intake: "apps/workers/src/intake.ts",
  migrate: "apps/workers/src/migrate.ts",
  coordination: "apps/workers/src/coordination.ts",
  "channel-send": "apps/workers/src/channel-send.ts",
  "channel-receive": "apps/workers/src/channel-receive.ts",
  agent: "apps/workers/src/agent.ts",
})) {
  await build({
    entryPoints: [entry],
    outfile: `dist/${name}/index.cjs`,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    loader: { ".sql": "text" },
    sourcemap: false,
  });
}
