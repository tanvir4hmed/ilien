import { build } from "esbuild";
import { mkdir, cp } from "node:fs/promises";
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
  result: "apps/workers/src/result.ts",
  reconcile: "apps/workers/src/reconcile.ts",
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

await mkdir("dist/console", { recursive: true });
await build({
  entryPoints: ["apps/console/src/app.ts"],
  outfile: "dist/console/app.js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  minify: true,
});
for (const [from, to] of [
  ["apps/console/index.html", "index.html"],
  ["apps/console/src/app.css", "app.css"],
  ["packages/simulation/catalog.json", "catalog.json"],
  ["packages/simulation/fixtures", "fixtures"],
  ["packages/contracts/examples", "examples"],
])
  await cp(from, `dist/console/${to}`, { recursive: true });
