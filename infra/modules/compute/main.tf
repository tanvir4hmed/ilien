variable "name" {
  type = string
}
variable "boundary_arn" {
  type = string
}
variable "zip_path" {
  type = string
}
variable "artifact_bucket" {
  type = string
}
variable "environment" {
  type = map(string)
}
variable "policy" {
  type = string
}
variable "timeout" {
  type    = number
  default = 30
}
variable "reserved_concurrency" {
  type    = number
  default = -1
}
resource "aws_iam_role" "runtime" {
  name                 = var.name
  permissions_boundary = var.boundary_arn
  assume_role_policy   = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  tags                 = { Project = "ilien" }
}
resource "aws_iam_role_policy" "runtime" {
  role   = aws_iam_role.runtime.id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat(jsondecode(var.policy).Statement, var.async_failure_arn == null ? [] : [{ Effect = "Allow", Action = ["sqs:SendMessage"], Resource = var.async_failure_arn }]) })
}
resource "aws_cloudwatch_log_group" "runtime" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = 14
  tags              = { Project = "ilien" }
}
resource "aws_lambda_function" "runtime" {
  function_name                  = var.name
  role                           = aws_iam_role.runtime.arn
  runtime                        = "nodejs24.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  s3_bucket                      = var.artifact_bucket
  s3_key                         = "ilien/artifacts/${filesha256(var.zip_path)}.zip"
  source_code_hash               = filebase64sha256(var.zip_path)
  timeout                        = var.timeout
  memory_size                    = 256
  reserved_concurrent_executions = var.reserved_concurrency
  environment { variables = var.environment }
  depends_on = [aws_iam_role_policy.runtime, aws_cloudwatch_log_group.runtime]
  tags       = { Project = "ilien" }
}
output "arn" {
  value = aws_lambda_function.runtime.arn
}
output "name" {
  value = aws_lambda_function.runtime.function_name
}
output "invoke_arn" {
  value = aws_lambda_function.runtime.invoke_arn
}
variable "async_failure_arn" {
  type    = string
  default = null
}
resource "aws_lambda_function_event_invoke_config" "runtime" {
  count                        = var.async_failure_arn == null ? 0 : 1
  function_name                = aws_lambda_function.runtime.function_name
  maximum_event_age_in_seconds = 3600
  maximum_retry_attempts       = 2
  destination_config {
    on_failure { destination = var.async_failure_arn }
  }
}
