module "result_queue" {
  source = "../modules/queue"
  name   = "ilien-results"
}
resource "aws_sns_topic" "results" {
  name              = "ilien-source-results"
  kms_master_key_id = module.channels.notification_key_arn
  tags              = { Project = "ilien" }
}
module "result_worker" {
  source               = "../modules/compute"
  name                 = "ilien-results"
  enable_async_failure = true
  async_failure_arn    = aws_sqs_queue.runtime_failures.arn
  boundary_arn         = local.boundary
  artifact_bucket      = "ilien-terraform-${local.account}-us-east-1"
  zip_path             = "../../dist/result.zip"
  timeout              = 60
  environment          = merge(local.common, { TENANT_ID = local.channel_env.TENANT_ID, SOURCE_ID = local.channel_env.SOURCE_ID, RESULT_TOPIC_ARN = aws_sns_topic.results.arn })
  policy = jsonencode({ Version = "2012-10-17", Statement = concat(local.base_statements, [
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = module.result_queue.arn },
    { Effect = "Allow", Action = ["sns:Publish"], Resource = aws_sns_topic.results.arn },
    { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = module.channels.notification_key_arn, Condition = { StringEquals = { "kms:ViaService" = "sns.us-east-1.amazonaws.com" } } }
  ]) })
}
resource "aws_lambda_event_source_mapping" "results" {
  event_source_arn        = module.result_queue.arn
  function_name           = module.result_worker.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config { maximum_concurrency = 2 }
}
output "source_result_topic" { value = aws_sns_topic.results.arn }
