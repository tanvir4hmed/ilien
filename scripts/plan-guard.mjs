import {readFileSync} from 'node:fs';
const plan=JSON.parse(readFileSync(process.argv[2],'utf8'));
const namespaceMigration = new Set([
  'aws_lambda_event_source_mapping.coordination',
  'aws_lambda_event_source_mapping.intake',
  'aws_lambda_permission.gateway',
  ...['api', 'coordination', 'intake', 'migrate', 'relay'].flatMap(name => [
    `module.${name}.aws_cloudwatch_log_group.runtime`,
    `module.${name}.aws_iam_role.runtime`,
    `module.${name}.aws_iam_role_policy.runtime`,
    `module.${name}.aws_lambda_function.runtime`,
  ]),
  ...['coordination_queue', 'queue'].flatMap(name => [
    `module.${name}.aws_sqs_queue.dead`,
    `module.${name}.aws_sqs_queue.work`,
  ]),
]);
const destructive = (plan.resource_changes ?? []).filter(r => r.change.actions.includes('delete'));
const rejected = destructive.filter(r => {
  const actions = r.change.actions;
  const before = JSON.stringify(r.change.before ?? {});
  const after = JSON.stringify(r.change.after ?? {});
  return !namespaceMigration.has(r.address)
    || !actions.includes('create')
    || !before.includes('ilien-demo')
    || after.includes('ilien-demo');
});
if (rejected.length) {
  console.error('Automatic deployment refuses deletion/replacement outside the approved identifier migration:', rejected.map(r => r.address).join(', '));
  process.exit(1);
}
if (destructive.length) console.log(`Approved identifier-only replacements: ${destructive.map(r => r.address).join(', ')}`);
console.log(`Plan contains ${(plan.resource_changes ?? []).length} resource entries; destructive actions are limited to the explicit ilien-demo to ilien identifier migration.`);
