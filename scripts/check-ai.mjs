import { build } from "esbuild";
import { spawnSync } from "node:child_process";

await build({
  entryPoints: ["packages/ai/test/gates.test.ts"],
  outfile: "dist/checks/ai-gates.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
});
const result = spawnSync(process.execPath, ["--test", "dist/checks/ai-gates.cjs"], {
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
