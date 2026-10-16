import { randomBytes } from "node:crypto";
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { param,query,rows,transaction } from "../../../packages/persistence/src/database.js";
import migration from "../../../packages/persistence/migrations/001_foundation.sql";
const secrets = new SecretsManagerClient({maxAttempts:3});
export async function handler() {
  const secretId = process.env.APP_SECRET_ARN!;
  let credentials: {username:string;password:string};
  try { credentials = JSON.parse((await secrets.send(new GetSecretValueCommand({SecretId:secretId}))).SecretString!); }
  catch (error) {
    if (!(error instanceof Error) || error.name !== "ResourceNotFoundException") throw error;
    credentials = {username:"ilien_app",password:randomBytes(36).toString("hex")};
    await secrets.send(new PutSecretValueCommand({SecretId:secretId,SecretString:JSON.stringify(credentials)}));
  }
  if (credentials.username !== "ilien_app" || !/^[a-f0-9]{72}$/.test(credentials.password)) throw new Error("Unexpected application credential format");
  await transaction(null, async tx => {
    await query("SELECT pg_advisory_xact_lock(117001)::text",[],tx);
    const role = rows(await query("SELECT 1 FROM pg_roles WHERE rolname='ilien_app'",[],tx));
    if (!role.length) await query(`CREATE ROLE ilien_app LOGIN PASSWORD '${credentials.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,[],tx);
    const exists = rows<{name:string|null}>(await query("SELECT to_regclass('public.schema_migrations')::text AS name",[],tx))[0]?.name;
    if (!exists) for (const statement of migration.split("-- statement")) await query(statement.trim(),[],tx);
    const version = rows<{version:number}>(await query("SELECT max(version) AS version FROM schema_migrations",[],tx))[0]?.version;
    if (version !== 1) throw new Error("Unsupported database migration version");
    await query("INSERT INTO tenants(id,name) VALUES(CAST(:tenant AS uuid),'Synthetic textile demo') ON CONFLICT(id) DO NOTHING",[param("tenant",process.env.DEMO_TENANT_ID!)],tx);
    await query("INSERT INTO source_connections(tenant_id,id,principal_arn,origin) VALUES(CAST(:tenant AS uuid),CAST(:source AS uuid),:principal,'simulated') ON CONFLICT(tenant_id,id) DO UPDATE SET principal_arn=EXCLUDED.principal_arn",[param("tenant",process.env.DEMO_TENANT_ID!),param("source",process.env.DEMO_SOURCE_ID!),param("principal",process.env.DEMO_PRINCIPAL_ARN!)],tx);
  });
  return {schemaVersion:1};
}
