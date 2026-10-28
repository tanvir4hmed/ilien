import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { toolInput, toolsFor } from "../../ai/src/planner.js";
import { communicationContext } from "../../domain-packs/src/communication.js";
import { render } from "../src/outbound.js";
import { groundedQuote } from "../../ai/src/contracts.js";
import { authoredReplyText } from "../src/text.js";
import { normalize } from "../src/normalize.js";
import {
  canonical,
  isGreeting,
  openDeliveries,
  type OpenDelivery,
} from "../src/matching.js";
import type { Binding } from "../src/intents.js";
import {bindingMatches} from "../src/intents.js";
import {contactBindings} from "../src/routing.js";
import type {Delivery} from "../src/intents.js";
import { textilePolicy } from "../../domain-packs/src/textile.js";
import {
  initialize,
  transition,
  resolveActor,
} from "../../coordination/src/engine.js";
import type { CaseState } from "../../coordination/src/types.js";
const now = new Date().toISOString();
const later = new Date(Date.now() + 1800000).toISOString();

test("shared recipients are explicitly scoped by department and channel, only for simulated sources",()=>{
 const endpoints=[{id:"qa",actor_id:"qa_endpoint",channel:"email",enabled:true},{id:"operations",actor_id:"operations_endpoint",channel:"email",enabled:true},{id:"phone",actor_id:"phone_endpoint",channel:"whatsapp",enabled:true}];
 const config={demoRouting:{enabled:true,actorId:"qa_endpoint",routes:[{group:"quality",channel:"email",actorId:"qa_endpoint"},{group:"stores",channel:"email",actorId:"operations_endpoint"},{group:"stores",channel:"whatsapp",actorId:"phone_endpoint"},{group:"procurement",channel:"email",actorId:"operations_endpoint"}]}};
 assert.deepEqual(contactBindings(endpoints,"stores_owner","stores","simulated",config).map(b=>b.id),["operations","phone"]);
 assert.deepEqual(contactBindings(endpoints,"quality_owner","quality","simulated",config).map(b=>b.id),["qa"]);
 assert.deepEqual(contactBindings(endpoints,"supplier_owner","supplier","simulated",config),[]);
 assert.deepEqual(contactBindings(endpoints,"stores_owner","stores","external",config),[]);
 assert.deepEqual(contactBindings(endpoints,"qa_endpoint","quality","external",config).map(b=>b.id),["qa"]);
});

test("an explicitly shared alternate channel can answer the same role without granting other roles authority",()=>{
 const delivery={actor_id:"stores_owner",request:{demo:true,demoActorId:"phone_endpoint",sharedReplyBindings:[{bindingId:"operations",actorId:"operations_endpoint",channel:"email"}]}} as unknown as Delivery;
 const email={id:"operations",actor_id:"operations_endpoint",channel:"email",enabled:true} as Binding;
 assert.equal(bindingMatches(delivery,email),true);
 assert.equal(bindingMatches(delivery,{...email,id:"unrelated"}),false);
 assert.equal(bindingMatches(delivery,{...email,enabled:false}),false);
 assert.equal(bindingMatches({...delivery,request:{...delivery.request,demo:false}},email),false);
});
test("quoted Gmail requests are not interpreted as a new participant request", () => {
  const text =
    "1100 metre passes; 100 remains quarantined.\n\nOn Tue, Oct 20 at 5:10 PM ILIEN <requests@example.com>\nwrote:\n\n> Confirm quality disposition.\n> Ask for the certificate.";
  assert.equal(
    authoredReplyText(text),
    "1100 metre passes; 100 remains quarantined.",
  );
  assert.equal(
    authoredReplyText("On Monday the inspection failed.\nPlease ask Quality."),
    "On Monday the inspection failed.\nPlease ask Quality.",
  );
  assert.equal(authoredReplyText("hi\n\n> Previous request"), "hi");
});
test("a duplicated department question cannot create a new child", () => {
  const initial = initialize(state(), textilePolicy, now);
  assert.throws(
    () =>
      transition(
        initial.state,
        textilePolicy,
        resolveActor(textilePolicy, "stores_owner"),
        {
          type: "add_child",
          parentId: "stock",
          obligationId: "duplicate",
          group: "stores",
          kind: "fact",
          question: "How much usable stock?",
        },
        "bad-copy",
        now,
      ),
    /duplicate_question_use_existing/,
  );
});
test("citation grounding tolerates line wrapping without changing wording or quantities", () => {
  assert.equal(
    groundedQuote(
      "I cannot confirm quality\ndisposition yet.",
      "I cannot confirm quality disposition yet.",
    ),
    true,
  );
  assert.equal(
    groundedQuote("Stock is not ready: 1,200 kg.", "Stock is ready: 1,200 kg."),
    false,
  );
  assert.equal(groundedQuote("Stock: 1,200 kg.", "Stock: 1200 kg."), false);
  assert.equal(groundedQuote("Stock: 1200 kg.", "   "), false);
});
test("model tools do not expose policy or takeover operations", () => {
  const schema = JSON.stringify(toolsFor({}));
  assert.equal(schema.includes("amend_subject"), false);
  assert.equal(schema.includes("takeover"), false);
  assert.equal(schema.includes("add_child"), true);
});
test("source disclosures preserve quantities while omitting unrelated fields", () => {
  const original = {
    eventType: "manufacturing.material_readiness_requested",
    payload: {
      siteId: "site-a",
      materialLotId: "lot-a",
      requiredQuantity: { value: "1200.000", unit: "metre" },
      neededBy: later,
      internalPrice: "private",
      apiKey: "never-disclose",
    },
  };
  const disclosed = communicationContext(original, "stores");
  assert.deepEqual(
    disclosed.requiredQuantity,
    original.payload.requiredQuantity,
  );
  assert.equal("internalPrice" in disclosed, false);
  assert.equal("apiKey" in disclosed, false);
  assert.deepEqual(communicationContext(original, "outside-policy"), {});
  const d = delivery();
  d.request.sourceContext = disclosed;
  const text = render(d);
  assert.match(text, /Material batch: lot-a/);
  assert.match(text, /1200.000 metre/);
  assert.equal(text.includes("never-disclose"), false);
});
test("Nova tool schema uses only provider-supported top-level fields", () => {
  const schema = toolInput(z.strictObject({ query: z.string().min(2) }));
  assert.deepEqual(Object.keys(schema).sort(), [
    "properties",
    "required",
    "type",
  ]);
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["query"]);
});
test("AWS outbound request and Meta reply IDs are preserved as separate aliases", async () => {
  process.env.WHATSAPP_TOPIC_ARN = "test-whatsapp-topic";
  process.env.AWS_ACCOUNT_ID = "test-account";
  process.env.WHATSAPP_WABA_ARN = "test-waba";
  process.env.WHATSAPP_PHONE_ARN = "test-phone";
  const notification = {
    messageId: "aws-request-1",
    aws_account_id: "test-account",
    context: {
      MetaWabaIds: [{ arn: "test-waba" }],
      MetaPhoneNumberIds: [
        { arn: "test-phone", metaPhoneNumberId: "test-meta-phone" },
      ],
    },
    whatsAppWebhookEntry: JSON.stringify({
      changes: [
        {
          value: {
            metadata: { phone_number_id: "test-meta-phone" },
            statuses: [
              {
                id: "wamid-test-message",
                status: "failed",
                timestamp: String(Math.floor(Date.now() / 1000)),
                errors: [{ code: 131031, title: "Business Account locked" }],
              },
            ],
          },
        },
      ],
    }),
  };
  const items = await normalize(
    "test-whatsapp-topic",
    JSON.stringify(notification),
  );
  assert.equal(items[0]!.providerId, "aws-request-1");
  assert.equal(items[0]!.channelMessageId, "wamid-test-message");
  assert.equal(items[0]!.deliveryFailure!.code, 131031);
  await assert.rejects(
    () =>
      normalize(
        "test-whatsapp-topic",
        JSON.stringify({ ...notification, aws_account_id: "another-account" }),
      ),
    /WrongChannelAccount/,
  );
});
function state(): CaseState {
  return {
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
    goal: "Collect readiness",
    createdAt: now,
    deadline: later,
    contacts: 0,
    obligations: [
      {
        id: "stock",
        group: "stores",
        kind: "fact",
        question: "How much usable stock?",
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
}
const binding: Binding = {
  id: "binding-a",
  actor_id: "stores_owner",
  channel: "whatsapp",
  address: "123456789",
  enabled: true,
};
function delivery(overrides: Partial<OpenDelivery> = {}): OpenDelivery {
  return {
    id: "delivery-a",
    connection_id: "source-a",
    case_id: "case-a",
    contact_id: "contact-a",
    binding_id: "binding-a",
    actor_id: "stores_owner",
    channel: "whatsapp",
    address: "123456789",
    token: "a".repeat(32),
    obligation_id: "stock",
    obligation_revision: 1,
    status: "accepted",
    attempt_at: new Date(Date.now() - 60000).toISOString(),
    request: {
      contact: {
        actorId: "stores_owner",
        obligationId: "stock",
        kind: "ask",
        question: "Stock?",
        subject: state().subject,
        sourceEvidenceId: "original-a",
        origin: "simulated",
      },
      subject: state().subject,
      obligationRevision: 1,
      deadline: later,
    },
    snapshot: state(),
    ...overrides,
  };
}
test("provider JSON key order does not turn a duplicate into a conflict", () => {
  assert.equal(
    canonical({
      text: "hi",
      media: [],
      object: { key: "a", bucket: "b" },
      raw: undefined,
    }),
    canonical({ object: { bucket: "b", key: "a" }, media: [], text: "hi" }),
  );
  assert.notEqual(canonical({ text: "hi" }), canonical({ text: "hello" }));
});
test("greetings are recognised without fabricating task evidence", () => {
  for (const text of ["hi", "Hello!", "হ্যালো", "আসসালামু আলাইকুম"])
    assert.equal(isGreeting(text), true);
  assert.equal(isGreeting("Hello, usable stock is not confirmed"), false);
});
test("one current request may match a plain reply from its bound participant", () =>
  assert.equal(openDeliveries(binding, [delivery()], now).length, 1));
test("multiple cases stay ambiguous", () =>
  assert.equal(
    openDeliveries(
      binding,
      [delivery(), delivery({ id: "delivery-b", case_id: "case-b" })],
      now,
    ).length,
    2,
  ));
test("cross-channel reminders for the same obligation do not create ambiguity", () =>
  assert.equal(
    openDeliveries(
      binding,
      [delivery(), delivery({ id: "fallback-b", channel: "email" })],
      now,
    ).length,
    1,
  ));
test("a different or disabled participant never matches", () => {
  assert.equal(
    openDeliveries({ ...binding, actor_id: "quality_owner" }, [delivery()], now)
      .length,
    0,
  );
  assert.equal(
    openDeliveries({ ...binding, enabled: false }, [delivery()], now).length,
    0,
  );
});
test("a stale task, expired case or message predating a send never matches", () => {
  const stale = state();
  stale.obligations[0]!.revision++;
  assert.equal(
    openDeliveries(binding, [delivery({ snapshot: stale })], now).length,
    0,
  );
  const expired = state();
  expired.deadline = new Date(Date.now() - 1000).toISOString();
  assert.equal(
    openDeliveries(binding, [delivery({ snapshot: expired })], now).length,
    0,
  );
  assert.equal(
    openDeliveries(binding, [delivery({ attempt_at: later })], now).length,
    0,
  );
});
test("a received answer needs independent verification before completion", () => {
  const initial = initialize(state(), textilePolicy, now);
  const answered = transition(
    initial.state,
    textilePolicy,
    resolveActor(textilePolicy, "stores_owner"),
    {
      type: "reply",
      obligationId: "stock",
      expectedObligationRevision: 1,
      statement: "500 kg usable, not 700 kg physical",
      observedAt: now,
      validUntil: later,
      subjectRevision: "2",
    },
    "external-answer",
    now,
  );
  assert.equal(answered.state.obligations[0]!.status, "answered");
  assert.notEqual(answered.state.status, "completed");
  assert.throws(() =>
    transition(
      answered.state,
      textilePolicy,
      resolveActor(textilePolicy, "stores_owner"),
      {
        type: "verify",
        obligationId: "stock",
        replyRevision: 2,
        accept: true,
        reason: "self verify",
      },
      "bad-check",
      now,
    ),
  );
  const verified = transition(
    answered.state,
    textilePolicy,
    resolveActor(textilePolicy, "stores_verifier"),
    {
      type: "verify",
      obligationId: "stock",
      replyRevision: 2,
      accept: true,
      reason: "Independent count confirmed",
    },
    "external-check",
    now,
  );
  assert.equal(verified.state.status, "completed");
  assert.equal(
    verified.state.obligations[0]!.reply!.statement,
    "500 kg usable, not 700 kg physical",
  );
});
test("a child dependency blocks closure and cannot create a cycle", () => {
  const initial = initialize(state(), textilePolicy, now);
  const child = transition(
    initial.state,
    textilePolicy,
    resolveActor(textilePolicy, "stores_owner"),
    {
      type: "add_child",
      parentId: "stock",
      obligationId: "qa-check",
      group: "quality",
      kind: "evidence",
      question: "Has the quarantined roll passed inspection?",
    },
    "external-request",
    now,
  );
  assert.deepEqual(child.state.obligations[0]!.dependencies, ["qa-check"]);
  assert.throws(() =>
    transition(
      child.state,
      textilePolicy,
      resolveActor(textilePolicy, "coordinator"),
      {
        type: "link_dependency",
        obligationId: "qa-check",
        dependencyId: "stock",
      },
      "cycle",
      now,
    ),
  );
  assert.notEqual(child.state.status, "completed");
});
