import { build } from "esbuild";
import { spawnSync } from "node:child_process";
await build({entryPoints:["packages/coordination/test/autonomous.test.ts"],outfile:"dist/checks/autonomous.cjs",bundle:true,platform:"node",target:"node24",format:"cjs"});
const r=spawnSync(process.execPath,["--test","dist/checks/autonomous.cjs"],{stdio:"inherit"});process.exitCode=r.status ?? 1;
