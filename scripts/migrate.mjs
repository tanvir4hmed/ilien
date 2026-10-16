import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
const client = new LambdaClient({ maxAttempts: 3 });
for (let attempt = 1; attempt <= 4; attempt++) {
  const response = await client.send(new InvokeCommand({
    FunctionName: 'ilien-demo-migrate', Payload: Buffer.from('{}'),
  }));
  const result = JSON.parse(Buffer.from(response.Payload ?? []).toString('utf8'));
  if (!response.FunctionError && result.schemaVersion === 1) {
    console.log('Database schema version 1 applied.');
    break;
  }
  // Never print error messages, SQL, credentials, or raw Lambda payloads.
  const type = typeof result.errorType === 'string' && /^[A-Za-z0-9_.]{1,100}$/.test(result.errorType)
    ? result.errorType : 'UnknownMigrationFailure';
  console.error(`Migration attempt ${attempt}: ${type}`);
  if (attempt < 4 && ['DatabaseResumingException', 'DatabaseUnavailableException'].includes(type)) {
    await new Promise(resolve => setTimeout(resolve, 15000));
    continue;
  }
  process.exitCode = 1;
  break;
}
