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
locals {
  name             = "ilien"
  account          = data.aws_caller_identity.current.account_id
  boundary         = "arn:aws:iam::${local.account}:policy/ilien-runtime-boundary"
  common           = { DB_CLUSTER_ARN = module.data.cluster_arn, DB_SECRET_ARN = module.data.app_secret_arn }
  log_statement    = { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:us-east-1:${local.account}:log-group:/aws/lambda/ilien-*:*" }
  data_statement   = { Effect = "Allow", Action = ["rds-data:BeginTransaction", "rds-data:CommitTransaction", "rds-data:RollbackTransaction", "rds-data:ExecuteStatement"], Resource = module.data.cluster_arn }
  secret_statement = { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = module.data.app_secret_arn }
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
  source          = "../modules/compute"
  name            = "${local.name}-relay"
  timeout         = 120
  boundary_arn    = local.boundary
  artifact_bucket = "ilien-terraform-${local.account}-us-east-1"
  zip_path        = "../../dist/relay.zip"
  environment     = merge(local.common, { QUEUE_URL = module.queue.url, COORDINATION_QUEUE_URL = module.coordination_queue.url })
  policy          = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [{ Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [module.queue.arn, module.coordination_queue.arn] }]) })
}
module "api" {
  source          = "../modules/compute"
  name            = "${local.name}-api"
  boundary_arn    = local.boundary
  artifact_bucket = "ilien-terraform-${local.account}-us-east-1"
  zip_path        = "../../dist/api.zip"
  environment     = merge(local.common, { RELAY_FUNCTION = module.relay.name })
  policy          = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = module.relay.arn }]) })
}
module "intake" {
  source          = "../modules/compute"
  name            = "${local.name}-intake"
  boundary_arn    = local.boundary
  artifact_bucket = "ilien-terraform-${local.account}-us-east-1"
  zip_path        = "../../dist/intake.zip"
  environment     = merge(local.common, { RELAY_FUNCTION = module.relay.name })
  timeout         = 60
  policy          = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [{ Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = module.queue.arn }, { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = module.relay.arn }]) })
}
module "coordination" {
  source          = "../modules/compute"
  name            = "${local.name}-coordination"
  boundary_arn    = local.boundary
  artifact_bucket = "ilien-terraform-${local.account}-us-east-1"
  zip_path        = "../../dist/coordination.zip"
  timeout         = 60
  environment     = merge(local.common, { RELAY_FUNCTION = module.relay.name })
  policy          = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [{ Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = module.coordination_queue.arn }, { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = module.relay.arn }]) })
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
  tags          = { Project = "ilien" }
}
resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.api.invoke_arn
  payload_format_version = "2.0"
}
resource "aws_apigatewayv2_route" "events" {
  for_each           = toset(["GET /v1/events", "POST /v1/events", "GET /v1/cases", "GET /v1/cases/{caseId}", "GET /v1/cases/{caseId}/{section}", "GET /v1/cases/{caseId}/evidence/{evidenceId}", "POST /v1/cases/{caseId}/commands", "POST /v1/cases/{caseId}/acknowledgements"])
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
