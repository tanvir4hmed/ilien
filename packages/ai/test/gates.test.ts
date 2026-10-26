import { test } from "node:test";
import assert from "node:assert/strict";
import { textilePolicy } from "../../domain-packs/src/textile.js";
import type { CaseState } from "../../coordination/src/types.js";
import { gate } from "../src/store.js";
import type { Context, Proposal } from "../src/contracts.js";
import { autonomousGate } from "../src/autonomy.js";

const now = new Date().toISOString();
const later = new Date(Date.now() + 30 * 60_000).toISOString();

function context(): Context {
  const state: CaseState = {
    id: "case-a",
    inboxId: "inbox-a",
    sourceEvidenceId: "original-a",
    sourceId: "source-a",
    revision: 1,
    subject: { type: "material_lot", id: "LOT-A", revision: "2" },
    workflow: "material-readiness-v1",
    configurationVersion: textilePolicy.version,
    origin: "simulated",
    status: "active",
    goal: "Collect readiness information",
    createdAt: now,
    deadline: later,
    contacts: 0,
    obligations: [
      {
        id: "stock",
        group: "stores",
        kind: "fact",
        question: "How much usable stock is available?",
        required: true,
        dependencies: [],
        assignee: "stores_owner",
        revision: 1,
        status: "waiting",
        reminders: 0,
        escalated: false,
        nextContactAt: now,
      },
    ],
  };
  return {
    state,
    policy: textilePolicy,
    policyHash: "policy-hash",
    actorId: "stores_owner",
    evidence: [
      {
        id: "original-a",
        text: "Material lot LOT-A requires 1200 metre. Current inspection evidence is needed.",
        sha256: "original-hash",
        origin: "source",
      },
    ],
    knowledge: [],
    receipt: {
      id: "receipt-a",
      evidenceId: "reply-a",
      deliveryId: "delivery-a",
      bindingId: "binding-a",
      actorId: "stores_owner",
      obligationId: "stock",
      obligationRevision: 1,
      kind: "ask",
      text: "Please ask Quality for the current inspection certificate for LOT-A.",
    },
  };
}

function childProposal(operation: Proposal["operation"] = {
  type: "add_child" as const,
  parentId: "stock",
  obligationId: "qa-cert",
  group: "quality",
  kind: "evidence" as const,
  question: "Please provide the current inspection certificate for LOT-A.",
}): Proposal {
  return {
    disposition: "propose",
    reason: "The participant explicitly needs the certificate before answering.",
    operation,
    citations: [
      { ref: "original-a", quote: "Material lot LOT-A requires 1200 metre." },
      {
        ref: "reply-a",
        quote: "Please ask Quality for the current inspection certificate for LOT-A.",
      },
    ],
    uncertainties: [],
  };
}

test("a grounded receipt can propose a scoped prerequisite for review", () => {
  assert.doesNotThrow(() => gate(context(), childProposal()));
});

test("AI cannot ground a proposal in an invented evidence reference", () => {
  const p = childProposal();
  p.citations[1] = { ref: "made-up-receipt", quote: "Please ask Quality." };
  assert.throws(() => gate(context(), p), /ai_citation_mismatch/);
});

test("AI must cite original source evidence as well as the triggering receipt", () => {
  const p = childProposal();
  p.citations = [p.citations[1]!];
  assert.throws(() => gate(context(), p), /ai_original_evidence_required/);
});

test("AI cannot paraphrase away a negation or alter a cited quantity", () => {
  const p = childProposal();
  p.citations[0] = {
    ref: "original-a",
    quote: "Material lot LOT-A requires 12000 metre.",
  };
  assert.throws(() => gate(context(), p), /ai_citation_mismatch/);
});

test("a reply must target the exact obligation and revision in the receipt", () => {
  const p = childProposal({
    type: "reply",
    obligationId: "stock",
    expectedObligationRevision: 2,
    statement: "The usable stock is confirmed.",
    observedAt: now,
    validUntil: later,
    subjectRevision: "2",
  });
  assert.throws(() => gate(context(), p), /ai_reply_scope/);
});

test("a prerequisite request cannot escape the configured service groups", () => {
  const p = childProposal({
    type: "add_child",
    parentId: "stock",
    obligationId: "unscoped-check",
    group: "legal",
    kind: "evidence",
    question: "Please approve this unscoped request.",
  });
  assert.throws(() => gate(context(), p), /group_outside_service_scope/);
});

test("a channel receipt cannot authorize pause or other non-reply effects", () => {
  const p = childProposal({ type: "pause", reason: "Stop the workflow." });
  assert.throws(() => gate(context(), p), /ai_receipt_operation_forbidden/);
});

test("wait and review dispositions must carry no effectful operation", () => {
  const p = childProposal();
  p.disposition = "wait";
  assert.throws(() => gate(context(), p), /ai_nonproposal_operation/);
  p.operation = null;
  assert.doesNotThrow(() => gate(context(), p));
});

test("autonomous execution requires server-selected autonomous mode", () => {
  assert.throws(() => autonomousGate(context(), childProposal()), /autonomous_mode_required/);
  const c = context();
  c.executionMode = "autonomous";
  assert.equal(autonomousGate(c, childProposal()).type, "add_child");
});

test("unresolved uncertainty cannot become an autonomous effect", () => {
  const c = context(); c.executionMode = "autonomous";
  const p = childProposal(); p.uncertainties = ["The exact lot is ambiguous."];
  assert.throws(() => autonomousGate(c, p), /autonomous_clarification_required/);
});

test("autonomous mode retains evidence and authority gates", () => {
  const c = context(); c.executionMode = "autonomous";
  const p = childProposal(); p.citations[1]!.ref = "invented";
  assert.throws(() => autonomousGate(c, p), /ai_citation_mismatch/);
  const forbidden = childProposal({ type: "pause", reason: "Bypass all waiting." });
  assert.throws(() => autonomousGate(c, forbidden), /ai_receipt_operation_forbidden/);
});

test("waiting does not create an autonomous operation or inference loop", () => {
  const c = context(); c.executionMode = "autonomous";
  const p: Proposal = { disposition: "wait", operation: null, reason: "Await the current question.", citations: [], uncertainties: [] };
  assert.throws(() => autonomousGate(c, p), /autonomous_no_effect/);
});
