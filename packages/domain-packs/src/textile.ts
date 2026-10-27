import type { Policy, CaseState } from "../../coordination/src/types.js";
import type { SourceEvent } from "../../contracts/src/index.js";
import type { ProductConfiguration } from "../../product/src/configuration.js";
import { z } from "zod";
import { createHash } from "node:crypto";
export const textilePolicy: Policy = {
  version: "textile-v1",
  groups: [
    "stores",
    "quality",
    "planning",
    "procurement",
    "production",
    "supplier",
  ],
  actors: [
    {
      id: "coordinator",
      group: "coordination",
      role: "coordinator",
      enabled: true,
    },
    ...[
      "stores",
      "quality",
      "planning",
      "procurement",
      "production",
      "supplier",
    ].flatMap((group) => [
      {
        id: `${group}_owner`,
        group,
        role: "respondent" as const,
        enabled: true,
      },
      {
        id: `${group}_backup`,
        group,
        role: "respondent" as const,
        enabled: true,
      },
      {
        id: `${group}_verifier`,
        group,
        role: "verifier" as const,
        enabled: true,
      },
    ]),
  ],
  deadlineSeconds: 3600,
  reminderSeconds: 300,
  maxReminders: 1,
  maxContacts: 64,
  maxNodes: 32,
  maxDepth: 5,
  evidenceAgeSeconds: 3600,
};
const materialPayload = z.object({
  siteId: z.literal("sample-site-001"),
  materialLotId: z.string().min(1).max(160),
  requiredQuantity: z.object({
    value: z.string().regex(/^\d+(\.\d+)?$/),
    unit: z.string().min(1).max(32),
  }),
  neededBy: z.iso.datetime({ offset: true }),
  requestedInformation: z
    .array(
      z.enum([
        "usable_stock",
        "quality_disposition",
        "supplier_commitment",
        "allocation",
      ]),
    )
    .min(1),
});
export function template(event: SourceEvent): {
  workflow: string;
  goal: string;
  autonomous?: boolean;
  branches: { id?: string; optional?:boolean; dependencies?: string[]; requiredFacts?:string[]; acceptance?: "responsible_reply"|"independent"; proposalStatement?: string; group: string; kind: string; question: string }[];
} | null {
  if (event.payloadVersion !== "1.0" || !event.subject.revision) return null;
  if(event.eventType === "manufacturing.dispatch_exception_requested") {
    if(!materialPayload.safeParse(event.payload).success)return null;
    return {workflow:"dispatch-exception-v1",autonomous:true,goal:"Coordinate an inspection exception, confirmed allocation and an exact authorized partial-dispatch decision; return the result to the requesting source without executing shipment.",branches:[
      {id:"inspection",group:"quality",kind:"fact",requiredFacts:["passing_quantity","quarantined_quantity","dispatch_deadline"],question:"Report passing and quarantined quantities for the referenced lot and the exact dispatch deadline with timezone. Preserve limitations; ask for missing information rather than assuming release."},
      {id:"allocation",group:"stores",kind:"fact",dependencies:["inspection"],requiredFacts:["usable_quantity"],question:"Using the reported inspection disposition and deadline, confirm the usable quantity actually available for allocation now. Keep reserved or unavailable material separate. This is an information request, not a stock release command."},
      {id:"approval",group:"quality",kind:"decision",dependencies:["allocation"],question:"Approve or reject the exact partial-dispatch proposal and its quantity, deadline and quarantine conditions. Conditional agreement requires clarification. Approval is reported to the source; ILIEN does not execute shipment."},
    ]};
  }
  if (event.eventType === "manufacturing.production_coordination_requested") {
    if(!materialPayload.safeParse(event.payload).success) return null;
    return {workflow:"production-coordination-v1",autonomous:true,goal:"Coordinate available quantity, schedule impact and an authorized plan; track production-ready evidence and return structured progress to the source.",branches:[
      {id:"stock",requiredFacts:["usable_quantity"],group:"stores",kind:"fact",question:"Report currently usable quantity and unit for this material lot. Distinguish unavailable or quarantined material."},
      {id:"impact",dependencies:["stock"],requiredFacts:["completion_time"],group:"production",kind:"commitment",question:"Using the reported available quantity, explain production impact and confirm a specific completion time. Request clarification if timing is unknown."},
      {id:"approval",dependencies:["impact"],group:"planning",kind:"decision",question:"Approve or reject the exact proposed quantity and completion schedule. No approval is inferred from silence."},
      {id:"ready",dependencies:["approval"],requiredFacts:["completion_reference"],group:"production",kind:"completion",question:"Acknowledge the authorized plan, report progress, and explicitly confirm production-ready status with a completion reference when ready. Starting work does not complete this request."},
    ]};
  }
  if(event.eventType === "communication.request_raised") {
    const parsed=z.strictObject({summary:z.string().min(1).max(1000),group:z.string().min(1).max(80),kind:z.enum(["fact","decision","acknowledgement","evidence","commitment","completion"]),proposal:z.string().min(1).max(1000).optional(),requiredFacts:z.array(z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/)).max(12).optional(),context:z.record(z.string(),z.unknown()).optional(),communicationContext:z.record(z.string(),z.record(z.string(),z.unknown())).optional(),businessDeadline:z.iso.datetime({offset:true}).optional()}).safeParse(event.payload);
    if(!parsed.success || (parsed.data.kind==="decision" && !parsed.data.proposal)) return null;
    return {workflow:"generic-communication-v1",autonomous:true,goal:parsed.data.summary,branches:[{id:"request",group:parsed.data.group,kind:parsed.data.kind,question:parsed.data.summary,proposalStatement:parsed.data.proposal,requiredFacts:parsed.data.requiredFacts}]};
  }
  if (
    [
      "manufacturing.material_readiness_requested",
      "planning.upstream_supply_shifted",
    ].includes(event.eventType)
  ) {
    const parsed = materialPayload.safeParse(event.payload);
    if (!parsed.success) return null;
    return {
      workflow: "material-readiness-v1",
      goal: "Collect verified material readiness information; source retains operational decisions.",
      branches: [
        {
          group: "stores",
          kind: "fact",
          question:
            "Report usable stock for the referenced material lot, preserving quantity and unit; distinguish uncertainty.",
        },
        {
          group: "quality",
          kind: "evidence",
          question:
            "Confirm current quality disposition for the referenced lot and evidence supporting the reported status.",
        },
        {
          group: "planning",
          kind: "fact",
          question:
            "Confirm allocation and readiness constraints for the referenced production order.",
        },
        {
          group: "procurement",
          kind: "commitment",
          question:
            "Obtain the supplier commitment and its validity for the referenced material requirement.",
        },
      ],
    };
  }
  if (
    event.eventType === "plm.techpack_approved" &&
    event.payload.siteId === "sample-site-001"
  )
    return {
      workflow: "revision-acknowledgement-v1",
      goal: "Collect acknowledgements of the exact supplied revision; no manufacturing execution.",
      branches: ["production", "quality"].map((group) => ({
        group,
        kind: "acknowledgement",
        question:
          "Acknowledge the exact subject revision and identify any unresolved clarification.",
      })),
    };
  return null;
}
export function seedCase(
  event: SourceEvent,
  input: Pick<CaseState, "id" | "inboxId" | "sourceId" | "sourceEvidenceId">,
  policy: Policy,
  now: string,
  configuration?: ProductConfiguration,
): CaseState | null {
  const configured = configuration?.workflows.find(
    (w) => w.eventType === event.eventType,
  );
  if (
    configured &&
    (!event.subject.revision ||
      event.payloadVersion !== "1.0" ||
      configured.requiredPayloadKeys.some(
        (k) => event.payload[k] === undefined || event.payload[k] === null,
      ))
  )
    return null;
  let definition = configured ?? template(event);
  if(!definition && configuration?.assistedIntake && event.subject.revision && event.payloadVersion==="1.0") {
    const summary=event.payload.requestedOutcome ?? event.payload.summary ?? event.payload.description;
    const group=configuration.intakeGroup;
    if(typeof summary==="string" && summary.trim() && summary.length<=1000 && group && policy.groups.includes(group)) {
      definition={workflow:"assisted-intake-v1",goal:summary,autonomous:true,branches:[{id:"request",group,kind:"evidence",question:summary}]};
    }
  }
  if (!definition) return null;
  if (
    definition.branches.some(
      (b) =>
        !policy.groups.includes(b.group) ||
        !policy.actors.some(
          (a) => a.enabled && a.group === b.group && a.role === "respondent",
        ) ||
        (!definition.autonomous || b.acceptance === "independent") && !policy.actors.some(
          (a) => a.enabled && a.group === b.group && a.role === "verifier",
        ),
    )
  )
    return null;
  return {
    ...input,
    revision: 1,
    subject: { ...event.subject, revision: event.subject.revision! },
    workflow: definition.workflow,
    autonomous: definition.autonomous ?? false,
    awaitingPlan: definition.autonomous ?? false,
    configurationVersion: policy.version,
    origin: "simulated",
    status: "active",
    goal: definition.goal,
    createdAt: now,
    deadline: new Date(
      Date.parse(now) + policy.deadlineSeconds * 1000,
    ).toISOString(),
    contacts: 0,
    businessDeadline: typeof event.payload.businessDeadline==="string" && Number.isFinite(Date.parse(event.payload.businessDeadline)) ? event.payload.businessDeadline : undefined,
    obligations: definition.branches.map((branch, i) => ({
      ...branch,
      id: branch.id ?? `root_${i + 1}`,
      required: !branch.optional,
      dependencies: branch.dependencies ?? [],
      acceptance: branch.acceptance ?? (definition.autonomous ? "responsible_reply" : "independent"),
      assignee: policy.actors.find(
        (a) => a.enabled && a.group === branch.group && a.role === "respondent",
      )!.id,
      revision: 1,
      preferredChannel:policy.actors.find(a=>a.enabled&&a.group===branch.group&&a.role==="respondent")?.preferredChannel,
      status: "waiting",
      reminders: 0,
      escalated: false,
      nextContactAt: now,
      ...(branch.proposalStatement ? {proposal:(()=>{
        const proposal={id:`proposal_${branch.id ?? `root_${i+1}`}`,revision:1,statement:branch.proposalStatement,subjectRevision:event.subject.revision!};
        return {...proposal,sha256:createHash("sha256").update(JSON.stringify(proposal)).digest("hex"),evidenceId:input.sourceEvidenceId};
      })()} : {}),
    })),
  };
}
