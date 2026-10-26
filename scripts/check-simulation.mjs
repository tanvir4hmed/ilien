import { build } from "esbuild";
import { spawnSync } from "node:child_process";
await build({entryPoints:["packages/simulation/coverage.test.ts"], outfile:"dist/checks/simulation.cjs", bundle:true, platform:"node", target:"node24", format:"cjs"});
const result = spawnSync(process.execPath,["--test","dist/checks/simulation.cjs"],{stdio:"inherit"});
process.exitCode = result.status ?? 1;
