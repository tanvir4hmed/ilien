import type { Policy, CaseState } from "../../coordination/src/types.js";
import type { SourceEvent } from "../../contracts/src/index.js";
import { z } from "zod";
export const textilePolicy: Policy = {
  version: "textile-demo-v1",
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
  siteId: z.literal("demo-site-001"),
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
export function template(
  event: SourceEvent,
): {
  workflow: string;
  goal: string;
  branches: { group: string; kind: string; question: string }[];
} | null {
  if (event.payloadVersion !== "1.0" || !event.subject.revision) return null;
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
    event.payload.siteId === "demo-site-001"
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
): CaseState | null {
  const definition = template(event);
  if (!definition) return null;
  return {
    ...input,
    revision: 1,
    subject: { ...event.subject, revision: event.subject.revision! },
    workflow: definition.workflow,
    configurationVersion: policy.version,
    origin: "simulated",
    status: "active",
    goal: definition.goal,
    createdAt: now,
    deadline: new Date(
      Date.parse(now) + policy.deadlineSeconds * 1000,
    ).toISOString(),
    contacts: 0,
    obligations: definition.branches.map((branch, i) => ({
      ...branch,
      id: `root_${i + 1}`,
      required: true,
      dependencies: [],
      assignee: `${branch.group}_owner`,
      revision: 1,
      status: "waiting",
      reminders: 0,
      escalated: false,
      nextContactAt: now,
    })),
  };
}
