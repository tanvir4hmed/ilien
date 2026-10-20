import {
  RDSDataClient,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  ExecuteStatementCommand,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";
const client = new RDSDataClient({ maxAttempts: 3 });
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export function config() {
  return {
    resourceArn: env("DB_CLUSTER_ARN"),
    secretArn: env("DB_SECRET_ARN"),
    database: "ilien",
  };
}
export const param = (name: string, value: string): SqlParameter => ({
  name,
  value: { stringValue: value },
});
export async function query(
  sql: string,
  parameters: SqlParameter[] = [],
  transactionId?: string,
) {
  return client.send(
    new ExecuteStatementCommand({
      ...config(),
      sql,
      parameters,
      transactionId,
      formatRecordsAs: "JSON",
    }),
  );
}
export function rows<T>(result: { formattedRecords?: string }): T[] {
  return JSON.parse(result.formattedRecords ?? "[]") as T[];
}
export async function transaction<T>(
  tenant: string | null,
  operation: (tx: string) => Promise<T>,
  consistentRead = false,
): Promise<T> {
  const { transactionId } = await client.send(
    new BeginTransactionCommand(config()),
  );
  if (!transactionId) throw new Error("Transaction unavailable");
  try {
    if (consistentRead)
      await query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        [],
        transactionId,
      );
    if (tenant)
      await query(
        "SELECT set_config('app.tenant_id', :tenant, true)",
        [param("tenant", tenant)],
        transactionId,
      );
    const result = await operation(transactionId);
    await client.send(
      new CommitTransactionCommand({ ...config(), transactionId }),
    );
    return result;
  } catch (error) {
    await client
      .send(new RollbackTransactionCommand({ ...config(), transactionId }))
      .catch(() => undefined);
    throw error;
  }
}
