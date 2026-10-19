variable "reconciliation_minutes" {
  type    = number
  default = 60
  validation {
    condition     = var.reconciliation_minutes >= 15 && var.reconciliation_minutes <= 1440 && floor(var.reconciliation_minutes) == var.reconciliation_minutes
    error_message = "Reconciliation interval must be 15 to 1440 whole minutes."
  }
}
resource "aws_sqs_queue" "runtime_failures" {
  name                      = "ilien-runtime-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = { Project = "ilien" }
}
module "reconcile" {
  source               = "../modules/compute"
  name                 = "ilien-reconcile"
  boundary_arn         = local.boundary
  artifact_bucket      = "ilien-terraform-${local.account}-us-east-1"
  zip_path             = "../../dist/reconcile.zip"
  timeout              = 120
  reserved_concurrency = 1
  async_failure_arn    = aws_sqs_queue.runtime_failures.arn
  environment          = merge(local.common, { TENANT_ID = local.channel_env.TENANT_ID, SOURCE_ID = local.channel_env.SOURCE_ID, RELAY_FUNCTION = module.relay.name })
  policy               = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = module.relay.arn }]) })
}
resource "aws_cloudwatch_event_rule" "reconcile" {
  name                = "ilien-reconcile"
  description         = "Bounded safety sweep; normal work is event driven."
  schedule_expression = "rate(${var.reconciliation_minutes} minutes)"
  tags                = { Project = "ilien" }
}
resource "aws_cloudwatch_event_target" "reconcile" {
  rule      = aws_cloudwatch_event_rule.reconcile.name
  target_id = "ilien-reconcile"
  arn       = module.reconcile.arn
  input     = jsonencode({ tenantId = local.channel_env.TENANT_ID, sourceId = local.channel_env.SOURCE_ID })
  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 2
  }
  dead_letter_config { arn = aws_sqs_queue.runtime_failures.arn }
}
resource "aws_lambda_permission" "reconcile_schedule" {
  statement_id  = "HourlyReconciliation"
  action        = "lambda:InvokeFunction"
  function_name = module.reconcile.name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reconcile.arn
}
resource "aws_sqs_queue_policy" "runtime_failures" {
  queue_url = aws_sqs_queue.runtime_failures.id
  policy    = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "events.amazonaws.com" }, Action = "sqs:SendMessage", Resource = aws_sqs_queue.runtime_failures.arn, Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.reconcile.arn } } }, { Effect = "Deny", Principal = "*", Action = "sqs:*", Resource = aws_sqs_queue.runtime_failures.arn, Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
locals {
  runtime_functions = { api = module.api.name, relay = module.relay.name, intake = module.intake.name, coordination = module.coordination.name, channel_send = module.channel_send.name, channel_receive = module.channel_receive.name, agent = module.agent.name, result = module.result_worker.name, reconcile = module.reconcile.name }
  work_queues       = { intake = { name = module.queue.name, arn = module.queue.arn, url = module.queue.url }, coordination = { name = module.coordination_queue.name, arn = module.coordination_queue.arn, url = module.coordination_queue.url }, inbound = { name = module.channels.inbound_name, arn = module.channels.inbound_arn, url = module.channels.inbound_url }, outbound = { name = module.channels.outbound_name, arn = module.channels.outbound_arn, url = module.channels.outbound_url }, agent = { name = module.agent_queue.name, arn = module.agent_queue.arn, url = module.agent_queue.url }, result = { name = module.result_queue.name, arn = module.result_queue.arn, url = module.result_queue.url } }
  dead_queues       = { intake = { name = module.queue.dead_name, arn = module.queue.dead_arn, url = module.queue.dead_url }, coordination = { name = module.coordination_queue.dead_name, arn = module.coordination_queue.dead_arn, url = module.coordination_queue.dead_url }, inbound = { name = module.channels.inbound_dead_name, arn = module.channels.inbound_dead_arn, url = module.channels.inbound_dead_url }, outbound = { name = module.channels.outbound_dead_name, arn = module.channels.outbound_dead_arn, url = module.channels.outbound_dead_url }, agent = { name = module.agent_queue.dead_name, arn = module.agent_queue.dead_arn, url = module.agent_queue.dead_url }, result = { name = module.result_queue.dead_name, arn = module.result_queue.dead_arn, url = module.result_queue.dead_url }, runtime = { name = aws_sqs_queue.runtime_failures.name, arn = aws_sqs_queue.runtime_failures.arn, url = aws_sqs_queue.runtime_failures.id } }
  dashboard_url     = "https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=ilien"
}
module "observability" {
  source                 = "../modules/observability"
  api_id                 = aws_apigatewayv2_api.api.id
  account                = local.account
  functions              = local.runtime_functions
  work_queues            = { for k, v in local.work_queues : k => v.name }
  dead_queues            = { for k, v in local.dead_queues : k => v.name }
  notification_key_arn   = module.channels.notification_key_arn
  reconciliation_minutes = var.reconciliation_minutes
}
output "operations_dashboard_url" { value = local.dashboard_url }
output "operations_alert_topic" { value = module.observability.alert_topic_arn }
resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/ilien"
  retention_in_days = 14
  tags              = { Project = "ilien" }
}
