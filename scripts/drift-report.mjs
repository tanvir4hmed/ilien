import { readFileSync } from "node:fs";
const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const drift = (plan.resource_drift ?? []).map((x) => ({
  address: x.address,
  actions: x.change.actions,
}));
console.log(JSON.stringify({ observedDrift: drift }, null, 2));
// Do not print attributes: plans and state can contain secrets or private data.
