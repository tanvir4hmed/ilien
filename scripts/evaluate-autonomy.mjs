import { build } from "esbuild";
import { spawnSync } from "node:child_process";
await build({entryPoints:["packages/ai/test/evaluate-autonomy.ts"],outfile:"dist/checks/evaluate-autonomy.mjs",bundle:true,platform:"node",target:"node24",format:"esm",external:["@aws-sdk/*"]});
const r=spawnSync(process.execPath,["dist/checks/evaluate-autonomy.mjs",process.argv[2]??"dist/autonomy-evaluation.json"],{stdio:"inherit",env:{...process.env,AWS_REGION:"us-east-1"}});process.exitCode=r.status ?? 1;
