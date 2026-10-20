import { build } from "esbuild";
import { spawnSync } from "node:child_process";
await build({
  entryPoints: ["packages/channels/test/conversations.test.ts"],
  outfile: "dist/checks/conversations.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
});
const result = spawnSync(
  process.execPath,
  ["--test", "dist/checks/conversations.cjs"],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
