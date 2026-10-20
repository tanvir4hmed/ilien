terraform {
  required_version = "= 1.15.8"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 6.0" } }
  backend "s3" {
    key          = "ilien/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
provider "aws" {
  region = "us-east-1"
}
data "aws_caller_identity" "current" {

}
variable "source_principal_arn" {
  type = string
}
variable "mail_domain" { type = string }
variable "whatsapp_waba_id" { type = string }
variable "whatsapp_phone_number_id" { type = string }
variable "whatsapp_meta_api_version" {
  type    = string
  default = "v23.0"
}
locals {
  name             = "ilien"
  account          = data.aws_caller_identity.current.account_id
  boundary         = "arn:aws:iam::${local.account}:policy/ilien-runtime-boundary"
  common           = { DB_CLUSTER_ARN = module.data.cluster_arn, DB_SECRET_ARN = module.data.app_secret_arn }
  log_statement    = { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:us-east-1:${local.account}:log-group:/aws/lambda/ilien-*:*" }
  data_statement   = { Effect = "Allow", Action = ["rds-data:BeginTransaction", "rds-data:CommitTransaction", "rds-data:RollbackTransaction", "rds-data:ExecuteStatement"], Resource = module.data.cluster_arn }
  secret_statement = { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = module.data.app_secret_arn }
  waba_arn         = "arn:aws:social-messaging:us-east-1:${local.account}:waba/${trimprefix(var.whatsapp_waba_id, "waba-")}"
  phone_arn        = "arn:aws:social-messaging:us-east-1:${local.account}:phone-number-id/${trimprefix(var.whatsapp_phone_number_id, "phone-number-id-")}"
  channel_env      = { TENANT_ID = "00000000-0000-4000-8000-000000000001", SOURCE_ID = "00000000-0000-4000-8000-000000000002", AWS_ACCOUNT_ID = local.account, WHATSAPP_WABA_ARN = local.waba_arn, WHATSAPP_PHONE_ARN = local.phone_arn, WHATSAPP_PHONE_NUMBER_ID = var.whatsapp_phone_number_id, WHATSAPP_META_API_VERSION = var.whatsapp_meta_api_version, MAIL_DOMAIN = var.mail_domain, CHANNEL_BUCKET = module.channels.bucket, WHATSAPP_TOPIC_ARN = module.channels.topics.whatsapp, EMAIL_TOPIC_ARN = module.channels.topics.email, EMAIL_EVENTS_TOPIC_ARN = module.channels.topics["email-events"] }
  base_statements  = [local.log_statement, local.data_statement, local.secret_statement]
}
module "data" {
  source         = "../modules/data"
  name           = local.name
  engine_version = "16.11"
}
module "queue" {
  source = "../modules/queue"
  name   = local.name
}
module "coordination_queue" {
  source = "../modules/queue"
  name   = "${local.name}-coordination"
}
module "relay" {
  source               = "../modules/compute"
  name                 = "${local.name}-relay"
  timeout              = 120
  enable_async_failure = true
  async_failure_arn    = aws_sqs_queue.runtime_failures.arn
  boundary_arn         = local.boundary
  artifact_bucket      = "ilien-terraform-${local.account}-us-east-1"
  zip_path             = "../../dist/relay.zip"
  environment          = merge(local.common, { QUEUE_URL = module.queue.url, COORDINATION_QUEUE_URL = module.coordination_queue.url, CHANNEL_QUEUE_URL = module.channels.outbound_url, AGENT_QUEUE_URL = module.agent_queue.url, RESULT_QUEUE_URL = module.result_queue.url })
  policy               = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [{ Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [module.queue.arn, module.coordination_queue.arn, module.channels.outbound_arn, module.agent_queue.arn, module.result_queue.arn] }]) })
}
module "api" {
  source          = "../modules/compute"
  name            = "${local.name}-api"
  boundary_arn    = local.boundary
  artifact_bucket = "ilien-terraform-${local.account}-us-east-1"
  zip_path        = "../../dist/api.zip"
  environment     = merge(local.common, { RELAY_FUNCTION = module.relay.name, RECONCILE_FUNCTION = module.reconcile.name, TENANT_ID = local.channel_env.TENANT_ID, SOURCE_ID = local.channel_env.SOURCE_ID, OPERATIONS_QUEUES = jsonencode(merge({ for k, v in local.work_queues : k => v.url }, { for k, v in local.dead_queues : "${k}-dead" => v.url })), OPERATIONS_DASHBOARD_URL = local.dashboard_url, OPERATOR_CLIENT_ID = module.console.client_id, OPERATOR_GUEST_CLIENT_ID = module.console.guest_client_id, OPERATOR_ISSUER = module.console.issuer })
  policy          = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = [module.relay.arn, module.reconcile.arn] }, { Effect = "Allow", Action = ["sqs:GetQueueAttributes"], Resource = concat([for v in local.work_queues : v.arn], [for v in local.dead_queues : v.arn]) }]) })
}
module "intake" {
  source               = "../modules/compute"
  name                 = "${local.name}-intake"
  enable_async_failure = true
  async_failure_arn    = aws_sqs_queue.runtime_failures.arn
  boundary_arn         = local.boundary
  artifact_bucket      = "ilien-terraform-${local.account}-us-east-1"
  zip_path             = "../../dist/intake.zip"
  environment          = merge(local.common, { RELAY_FUNCTION = module.relay.name })
  timeout              = 60
  policy               = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [{ Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = module.queue.arn }, { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = module.relay.arn }]) })
}
module "coordination" {
  source               = "../modules/compute"
  name                 = "${local.name}-coordination"
  enable_async_failure = true
  async_failure_arn    = aws_sqs_queue.runtime_failures.arn
  boundary_arn         = local.boundary
  artifact_bucket      = "ilien-terraform-${local.account}-us-east-1"
  zip_path             = "../../dist/coordination.zip"
  timeout              = 60
  environment          = merge(local.common, { RELAY_FUNCTION = module.relay.name })
  policy               = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [{ Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = module.coordination_queue.arn }, { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = module.relay.arn }]) })
}
resource "aws_lambda_event_source_mapping" "coordination" {
  event_source_arn        = module.coordination_queue.arn
  function_name           = module.coordination.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config { maximum_concurrency = 2 }
}
module "migrate" {
  source          = "../modules/compute"
  name            = "${local.name}-migrate"
  boundary_arn    = local.boundary
  artifact_bucket = "ilien-terraform-${local.account}-us-east-1"
  zip_path        = "../../dist/migrate.zip"
  timeout         = 120
  environment     = { DB_CLUSTER_ARN = module.data.cluster_arn, DB_SECRET_ARN = module.data.master_secret_arn, APP_SECRET_ARN = module.data.app_secret_arn, TENANT_ID = "00000000-0000-4000-8000-000000000001", SOURCE_ID = "00000000-0000-4000-8000-000000000002", SOURCE_PRINCIPAL_ARN = var.source_principal_arn }
  policy          = jsonencode({ Version = "2012-10-17", Statement = [local.log_statement, local.data_statement, { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [module.data.master_secret_arn, module.data.app_secret_arn] }, { Effect = "Allow", Action = ["secretsmanager:PutSecretValue"], Resource = module.data.app_secret_arn }] })
}
resource "aws_lambda_event_source_mapping" "intake" {
  event_source_arn        = module.queue.arn
  function_name           = module.intake.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config { maximum_concurrency = 2 }
}
resource "aws_apigatewayv2_api" "api" {
  name          = local.name
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = module.console.allowed_origins
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 300
  }
  tags = { Project = "ilien" }
}
resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.api.invoke_arn
  payload_format_version = "2.0"
}
resource "aws_apigatewayv2_route" "events" {
  for_each           = toset(["GET /v1/events", "POST /v1/events", "GET /v1/cases", "GET /v1/cases/{caseId}", "GET /v1/cases/{caseId}/{section}", "GET /v1/cases/{caseId}/evidence/{evidenceId}", "POST /v1/cases/{caseId}/commands", "POST /v1/cases/{caseId}/acknowledgements", "GET /v1/channels/{section}", "POST /v1/channels/{section}", "POST /v1/cases/{caseId}/agent", "GET /v1/ai/{section}", "POST /v1/ai/{section}", "GET /v1/ai/runs/{runId}", "POST /v1/ai/runs/{runId}/review"])
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = each.value
  authorization_type = "AWS_IAM"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
}
resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}
resource "aws_apigatewayv2_stage" "default" {
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format          = jsonencode({ requestId = "$context.requestId", route = "$context.routeKey", method = "$context.httpMethod", status = "$context.status", responseLength = "$context.responseLength", requestTimeEpoch = "$context.requestTimeEpoch" })
  }
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
}
resource "aws_lambda_permission" "gateway" {
  statement_id  = "ApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = module.api.name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}
output "api_url" {
  value = aws_apigatewayv2_api.api.api_endpoint
}
output "migrate_function" {
  value = module.migrate.name
}

module "channels" {
  source      = "../modules/channels"
  name        = local.name
  mail_domain = var.mail_domain
  waba_arn    = local.waba_arn
}
module "channel_send" {
  source               = "../modules/compute"
  name                 = "ilien-channel-send"
  enable_async_failure = true
  async_failure_arn    = aws_sqs_queue.runtime_failures.arn
  boundary_arn         = local.boundary
  artifact_bucket      = "ilien-terraform-${local.account}-us-east-1"
  zip_path             = "../../dist/channel-send.zip"
  timeout              = 60
  environment          = merge(local.common, local.channel_env, { CHANNEL_QUEUE_URL = module.channels.outbound_url })
  policy = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:SendMessage"], Resource = module.channels.outbound_arn },
    { Effect = "Allow", Action = ["social-messaging:GetWhatsAppMessageTemplate"], Resource = local.waba_arn },
    { Effect = "Allow", Action = ["social-messaging:SendWhatsAppMessage"], Resource = local.phone_arn },
    { Effect = "Allow", Action = ["ses:SendEmail"], Resource = ["arn:aws:ses:us-east-1:${local.account}:identity/${var.mail_domain}", "arn:aws:ses:us-east-1:${local.account}:configuration-set/ilien"] }
  ]) })
}
module "channel_receive" {
  source               = "../modules/compute"
  name                 = "ilien-channel-receive"
  enable_async_failure = true
  async_failure_arn    = aws_sqs_queue.runtime_failures.arn
  boundary_arn         = local.boundary
  artifact_bucket      = "ilien-terraform-${local.account}-us-east-1"
  zip_path             = "../../dist/channel-receive.zip"
  timeout              = 60
  environment          = merge(local.common, local.channel_env, { RELAY_FUNCTION = module.relay.name })
  policy = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = module.channels.inbound_arn },
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${module.channels.bucket_arn}/raw/*" },
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${module.channels.bucket_arn}/notifications/*", Condition = { StringEquals = { "s3:if-none-match" = "*" } } },
    { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = module.relay.arn }
  ]) })
}
resource "aws_lambda_event_source_mapping" "channel_send" {
  event_source_arn = module.channels.outbound_arn
  function_name    = module.channel_send.arn
  scaling_config { maximum_concurrency = 2 }
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}
resource "aws_lambda_event_source_mapping" "channel_receive" {
  event_source_arn        = module.channels.inbound_arn
  function_name           = module.channel_receive.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config { maximum_concurrency = 2 }
}
output "channel_dns_records" { value = module.channels.dns_records }
output "whatsapp_topic_arn" { value = module.channels.topics.whatsapp }

module "agent_queue" {
  source             = "../modules/queue"
  name               = "ilien-agent"
  visibility_timeout = 720
}
module "agent" {
  source               = "../modules/compute"
  name                 = "ilien-agent"
  enable_async_failure = true
  async_failure_arn    = aws_sqs_queue.runtime_failures.arn
  boundary_arn         = local.boundary
  artifact_bucket      = "ilien-terraform-${local.account}-us-east-1"
  zip_path             = "../../dist/agent.zip"
  timeout              = 120
  environment          = local.common
  policy = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = module.agent_queue.arn },
    { Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0" }
  ]) })
}
resource "aws_lambda_event_source_mapping" "agent" {
  event_source_arn        = module.agent_queue.arn
  function_name           = module.agent.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config { maximum_concurrency = 2 }
}
