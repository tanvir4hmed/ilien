import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
await build({entryPoints:['apps/console/test/session.test.ts'],outfile:'dist/checks/console.cjs',bundle:true,platform:'node',target:'node24',format:'cjs'});
const result=spawnSync(process.execPath,['--test','dist/checks/console.cjs'],{stdio:'inherit'});process.exitCode=result.status??1;
