import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { sourceEventSchema } from "../contracts/src/validation.js";
import { template } from "../domain-packs/src/textile.js";

const catalogue: {eventType: string; group: string; fixture: string; payloadStatus: string; workflowSupported: boolean; intakeDisposition: string}[] = JSON.parse(readFileSync("packages/simulation/catalog.json", "utf8"));

test("every retained event has one explicit synthetic fixture and a valid intake envelope", () => {
  assert.equal(catalogue.length, 231);
  assert.equal(new Set(catalogue.map(e => e.group)).size, 35);
  assert.equal(new Set(catalogue.map(e => e.eventType)).size, catalogue.length);
  assert.equal(new Set(catalogue.map(e => e.fixture)).size, catalogue.length);
  for (const entry of catalogue) {
    assert.match(entry.fixture, /^[A-Za-z0-9_.-]+\.json$/);
    const path = `packages/simulation/fixtures/${entry.fixture}`;
    assert.ok(existsSync(path), entry.eventType);
    const event = sourceEventSchema.parse(JSON.parse(readFileSync(path,"utf8")));
    assert.equal(event.eventType, entry.eventType);
    assert.equal(entry.payloadStatus, "synthetic_unverified");
    assert.equal(entry.workflowSupported, false);
    assert.equal(entry.intakeDisposition, "triage");
    assert.equal(template(event), null, `Minimal vocabulary fixture must not cause guessed routing: ${entry.eventType}`);
  }
});

test("validated examples activate actual workflows separately from catalogue vocabulary", () => {
  const examples = readdirSync("packages/contracts/examples").filter(p => p.endsWith(".event.json"));
  const workflows = new Set<string>();
  for (const file of examples) {
    const event = sourceEventSchema.parse(JSON.parse(readFileSync(`packages/contracts/examples/${file}`, "utf8")));
    const mapped = template(event);
    if (mapped) workflows.add(mapped.workflow);
    const invalid = structuredClone(event);
    delete invalid.subject.revision;
    assert.equal(template(invalid), null);
  }
  assert.ok(workflows.has("material-readiness-v1"));
  assert.ok(workflows.has("revision-acknowledgement-v1"));
});

test("an unfamiliar valid event is retained for triage, not guessed into a department", () => {
  const event = sourceEventSchema.parse({contractVersion:"1.0", eventId:"unknown-1", eventType:"new_industry.unclear_request", payloadVersion:"1.0", occurredAt:new Date().toISOString(), correlationId:"case-1", subject:{type:"item", id:"item-1", revision:"1"}, payload:{text:"Ask someone to approve this."}});
  assert.equal(template(event), null);
});
