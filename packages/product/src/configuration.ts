import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  param,
  query,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import { policySchema, type Source } from "../../coordination/src/service.js";
import { CoordinationError } from "../../coordination/src/types.js";
import { decode } from "../../channels/src/intents.js";
import { messageProfileSchema } from "../../contracts/src/communication.js";
const identifier = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);
export const workflowSchema = z.strictObject({
  eventType: z.string().regex(/^[A-Za-z0-9_.-]{1,160}$/),
  workflow: identifier,
  goal: z.string().min(1).max(1000),
  requiredPayloadKeys: z.array(identifier).max(16),
  autonomous: z.boolean().optional(),
  branches: z
    .array(
      z.strictObject({
        id: identifier.optional(),
        dependencies: z.array(identifier).max(12).optional(),
        acceptance: z.enum(["responsible_reply","independent"]).optional(),
        requiredFacts: z.array(identifier).max(12).optional(),
        group: identifier,
        kind: z.enum([
          "fact",
          "decision",
          "acknowledgement",
          "evidence",
          "commitment",
          "completion",
        ]),
        question: z.string().min(1).max(1000),
        proposalStatement: z.string().min(1).max(1000).optional(),
      }),
    )
    .min(1)
    .max(12),
});
export const configurationSchema = z.strictObject({
  workflows: z.array(workflowSchema).max(256),
  messageProfiles: z.array(messageProfileSchema).max(64).optional(),
  automaticFallback: z.boolean(),
  whatsappTemplate: z
    .strictObject({
      name: z.string().regex(/^[a-z0-9_]{1,128}$/),
      language: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),
      approvalRef: z.string().min(1).max(200),
      enabled: z.boolean(),
    })
    .nullable(),
});
export type ProductConfiguration = z.infer<typeof configurationSchema>;
export const defaultConfiguration: ProductConfiguration = {
  workflows: [],
  messageProfiles:[
    {group:"stores",channel:"whatsapp",format:"human",version:"stores-v1",language:"en",style:"concise",sourceFields:["siteId","materialLotId","requiredQuantity","neededBy"],factKeys:["usable_quantity","available_quantity","completion_time","passing_quantity","quarantined_quantity","dispatch_deadline"],fields:[]},
    ...["production","planning","quality","procurement"].map(group=>({group,channel:"email" as const,format:"human" as const,version:"department-v1",language:"en" as const,style:"formal" as const,sourceFields:["siteId","materialLotId","requiredQuantity","neededBy"],factKeys:["usable_quantity","available_quantity","completion_time","completion_reference","delay_days","passing_quantity","quarantined_quantity","dispatch_deadline"],fields:[]})),
  ],
  automaticFallback: false,
  whatsappTemplate: null,
};
export async function configurationFor(sourceId: string, tx: string) {
  const row = rows<{
    revision: number;
    configuration: ProductConfiguration | string;
  }>(
    await query(
      "SELECT revision,configuration FROM product_settings WHERE connection_id=CAST(:source AS uuid)",
      [param("source", sourceId)],
      tx,
    ),
  )[0];
  return row
    ? {
        revision: row.revision,
        configuration: configurationSchema.parse({...defaultConfiguration,...decode(row.configuration)}),
      }
    : { revision: 1, configuration: defaultConfiguration };
}
export async function audit(
  source: Source,
  actor: string,
  action: string,
  raw: string,
) {
  return transaction(source.tenant_id, (tx) =>
    query(
      "INSERT INTO operator_audit(tenant_id,connection_id,id,actor,action,request_hash) VALUES(CAST(:tenant AS uuid),CAST(:source AS uuid),CAST(:id AS uuid),:actor,:action,:hash)",
      [
        param("tenant", source.tenant_id),
        param("source", source.id),
        param("id", randomUUID()),
        param("actor", actor),
        param("action", action),
        param("hash", createHash("sha256").update(raw).digest("hex")),
      ],
      tx,
    ),
  );
}
export async function readConfiguration(source: Source) {
  return transaction(source.tenant_id, async (tx) => {
    const p = rows<{ policy: unknown }>(
      await query(
        "SELECT policy FROM coordination_policies WHERE connection_id=CAST(:source AS uuid)",
        [param("source", source.id)],
        tx,
      ),
    )[0];
    return {
      ...(await configurationFor(source.id, tx)),
      policy: p ? decode(p.policy) : null,
      history: rows(
        await query(
          "SELECT revision,actor,policy,configuration,created_at FROM configuration_history WHERE connection_id=CAST(:source AS uuid) ORDER BY revision DESC LIMIT 20",
          [param("source", source.id)],
          tx,
        ),
      ),
    };
  });
}
export async function publishConfiguration(
  source: Source,
  raw: string,
  actor: string,
) {
  const input = z
    .strictObject({
      action: z.enum(["preview", "publish"]),
      expectedRevision: z.number().int().positive(),
      policy: policySchema,
      configuration: configurationSchema,
    })
    .parse(JSON.parse(raw));
  if (
    new Set(input.policy.actors.map((a) => a.id)).size !==
      input.policy.actors.length ||
    new Set(input.policy.groups).size !== input.policy.groups.length ||
    !input.policy.actors.some((a) => a.enabled && a.role === "coordinator")
  )
    throw new CoordinationError("invalid_actor_registry");
  for (const a of input.policy.actors)
    if (a.role !== "coordinator" && !input.policy.groups.includes(a.group))
      throw new CoordinationError("actor_group_outside_scope");
  if (
    new Set(input.configuration.workflows.map((w) => w.eventType)).size !==
    input.configuration.workflows.length
  )
    throw new CoordinationError("duplicate_event_mapping");
  for (const w of input.configuration.workflows)
  {
    const ids=w.branches.map((b,i)=>b.id ?? `root_${i+1}`);
    if(new Set(ids).size!==ids.length || w.branches.some(b=>b.dependencies?.some(d=>!ids.includes(d)))) throw new CoordinationError("invalid_workflow_dependencies");
    const visiting=new Set<string>(),visited=new Set<string>();
    const visit=(id:string)=>{if(visiting.has(id)) throw new CoordinationError("dependency_cycle");if(visited.has(id))return; visiting.add(id); for(const d of w.branches[ids.indexOf(id)]!.dependencies ?? [])visit(d);visiting.delete(id);visited.add(id);};
    ids.forEach(visit);
    for (const b of w.branches)
      if (
        !input.policy.groups.includes(b.group) ||
        !input.policy.actors.some(
          (a) => a.enabled && a.group === b.group && a.role === "respondent",
        ) ||
        (!w.autonomous || b.acceptance === "independent") && !input.policy.actors.some(
          (a) => a.enabled && a.group === b.group && a.role === "verifier",
        )
      )
        throw new CoordinationError("workflow_authority_missing");
  }
  const profileKeys=new Set<string>();
  for (const profile of input.configuration.messageProfiles ?? []) {
    const key=`${profile.group}:${profile.channel}`;
    if(profileKeys.has(key)) throw new CoordinationError("duplicate_message_profile");
    profileKeys.add(key);
    if(!input.policy.groups.includes(profile.group)) throw new CoordinationError("profile_group_outside_scope");
    for(const f of profile.fields) {
      if(f.path.startsWith("source.") && !profile.sourceFields.includes(f.path.slice(7))) throw new CoordinationError("profile_field_not_disclosed");
      if(f.path.startsWith("facts.") && !profile.factKeys.includes(f.path.slice(6))) throw new CoordinationError("profile_fact_not_disclosed");
    }
  }
  return transaction(source.tenant_id, async (tx) => {
    const current = rows<{ revision: number }>(
      await query(
        "SELECT revision FROM product_settings WHERE connection_id=CAST(:source AS uuid) FOR UPDATE",
        [param("source", source.id)],
        tx,
      ),
    )[0];
    if (current?.revision !== input.expectedRevision)
      throw new CoordinationError("configuration_revision_conflict");
    const affected = rows(
      await query(
        "SELECT id,workflow,revision,status FROM coordination_cases WHERE connection_id=CAST(:source AS uuid) AND status IN ('active','paused','blocked') ORDER BY updated_at DESC LIMIT 100",
        [param("source", source.id)],
        tx,
      ),
    );
    if (input.action === "preview")
      return {
        valid: true,
        affectedCases: affected,
        notice:
          "Publishing requires explicit per-case adoption; old queued contacts will be blocked.",
      };
    const duplicate = rows(
      await query(
        "SELECT id FROM configuration_history WHERE connection_id=CAST(:source AS uuid) AND policy->>'version'=:version UNION ALL SELECT connection_id FROM coordination_policies WHERE connection_id=CAST(:source AS uuid) AND version=:version",
        [param("source", source.id), param("version", input.policy.version)],
        tx,
      ),
    );
    if (duplicate.length)
      throw new CoordinationError("new_policy_version_required");
    await query(
      "INSERT INTO configuration_history(tenant_id,connection_id,id,revision,actor,policy,configuration) SELECT p.tenant_id,p.connection_id,CAST(:id AS uuid),s.revision,:actor,p.policy,s.configuration FROM coordination_policies p JOIN product_settings s ON s.tenant_id=p.tenant_id AND s.connection_id=p.connection_id WHERE p.connection_id=CAST(:source AS uuid) ON CONFLICT DO NOTHING",
      [
        param("id", randomUUID()),
        param("actor", actor),
        param("source", source.id),
      ],
      tx,
    );
    await query(
      "INSERT INTO configuration_history(tenant_id,connection_id,id,revision,actor,policy,configuration) VALUES(CAST(:tenant AS uuid),CAST(:source AS uuid),CAST(:id AS uuid),CAST(:revision AS int),:actor,CAST(:policy AS jsonb),CAST(:config AS jsonb))",
      [
        param("tenant", source.tenant_id),
        param("source", source.id),
        param("id", randomUUID()),
        param("revision", String(current.revision + 1)),
        param("actor", actor),
        param("policy", JSON.stringify(input.policy)),
        param("config", JSON.stringify(input.configuration)),
      ],
      tx,
    );
    await query(
      "UPDATE coordination_policies SET version=:version,policy=CAST(:policy AS jsonb) WHERE connection_id=CAST(:source AS uuid)",
      [
        param("source", source.id),
        param("version", input.policy.version),
        param("policy", JSON.stringify(input.policy)),
      ],
      tx,
    );
    await query(
      "UPDATE product_settings SET revision=revision+1,configuration=CAST(:config AS jsonb) WHERE connection_id=CAST(:source AS uuid)",
      [
        param("source", source.id),
        param("config", JSON.stringify(input.configuration)),
      ],
      tx,
    );
    return { revision: current.revision + 1, affectedCases: affected };
  });
}
export async function members(source: Source, raw?: string, caller?: string) {
  return transaction(source.tenant_id, async (tx) => {
    if (raw) {
      const input = z
        .strictObject({
          subject: z.guid(),
          role: z.enum(["admin", "operator", "viewer"]),
          enabled: z.boolean(),
        })
        .parse(JSON.parse(raw));
      await query(
        "SELECT connection_id FROM product_settings WHERE connection_id=CAST(:source AS uuid) FOR UPDATE",
        [param("source", source.id)],
        tx,
      );
      const existing = rows<{
        connection_id: string;
        role: string;
        enabled: boolean;
      }>(
        await query(
          "SELECT connection_id,role,enabled FROM operator_memberships WHERE subject=CAST(:sub AS uuid)",
          [param("sub", input.subject)],
          tx,
        ),
      )[0];
      if (existing && existing.connection_id !== source.id)
        throw new CoordinationError("membership_source_conflict");
      if (
        input.subject === caller &&
        (!input.enabled || input.role !== "admin")
      )
        throw new CoordinationError("cannot_remove_own_admin_access");
      if (
        existing?.enabled &&
        existing.role === "admin" &&
        (!input.enabled || input.role !== "admin")
      ) {
        const count = rows<{ n: number }>(
          await query(
            "SELECT count(*)::int AS n FROM operator_memberships WHERE connection_id=CAST(:source AS uuid) AND enabled AND role='admin'",
            [param("source", source.id)],
            tx,
          ),
        )[0]!.n;
        if (count <= 1) throw new CoordinationError("last_admin_required");
      }
      await query(
        "INSERT INTO operator_memberships(tenant_id,connection_id,subject,role,enabled) VALUES(CAST(:tenant AS uuid),CAST(:source AS uuid),CAST(:sub AS uuid),:role,CAST(:enabled AS boolean)) ON CONFLICT(tenant_id,subject) DO UPDATE SET role=EXCLUDED.role,enabled=EXCLUDED.enabled",
        [
          param("tenant", source.tenant_id),
          param("source", source.id),
          param("sub", input.subject),
          param("role", input.role),
          param("enabled", String(input.enabled)),
        ],
        tx,
      );
    }
    return rows(
      await query(
        "SELECT subject,role,enabled,created_at FROM operator_memberships WHERE connection_id=CAST(:source AS uuid) ORDER BY created_at",
        [param("source", source.id)],
        tx,
      ),
    );
  });
}
