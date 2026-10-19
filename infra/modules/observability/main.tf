variable "account" { type = string }
variable "functions" { type = map(string) }
variable "work_queues" { type = map(string) }
variable "dead_queues" { type = map(string) }
variable "notification_key_arn" { type = string }
variable "reconciliation_minutes" { type = number }
resource "aws_sns_topic" "alerts" {
  name              = "ilien-operations-alerts"
  kms_master_key_id = var.notification_key_arn
  tags              = { Project = "ilien" }
}
resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "cloudwatch.amazonaws.com" }, Action = "sns:Publish", Resource = aws_sns_topic.alerts.arn, Condition = { StringEquals = { "aws:SourceAccount" = var.account }, ArnLike = { "aws:SourceArn" = "arn:aws:cloudwatch:us-east-1:${var.account}:alarm:ilien-*" } } }, { Effect = "Deny", Principal = "*", Action = "sns:Publish", Resource = aws_sns_topic.alerts.arn, Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
resource "aws_cloudwatch_metric_alarm" "errors" {
  for_each            = var.functions
  alarm_name          = "ilien-${each.key}-errors"
  alarm_description   = "Function invocation errors. Runbook: docs/OPERATIONS.md. No human subscriber is configured automatically."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = each.value }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = { Project = "ilien" }
}
resource "aws_cloudwatch_metric_alarm" "throttles" {
  for_each            = var.functions
  alarm_name          = "ilien-${each.key}-throttles"
  alarm_description   = "Worker throttled; inspect concurrency and queue age before increasing limits."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = each.value }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = { Project = "ilien" }
}
resource "aws_cloudwatch_metric_alarm" "dead" {
  for_each            = var.dead_queues
  alarm_name          = "ilien-${each.key}-dead-letters"
  alarm_description   = "Retained failed work requires inspection; do not blindly redrive provider effects."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = each.value }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = { Project = "ilien" }
}
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each            = var.work_queues
  alarm_name          = "ilien-${each.key}-queue-age"
  alarm_description   = "Old ready work; check pauses, retries and provider capacity. Delayed timers are tracked separately."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = each.value }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = { Project = "ilien" }
}
resource "aws_cloudwatch_metric_alarm" "heartbeat" {
  alarm_name          = "ilien-reconciliation-heartbeat"
  alarm_description   = "No successful safety sweep for two intervals. Monitor is outside the supervised Lambda."
  namespace           = "ILIEN/Operations"
  metric_name         = "ReconciliationHeartbeat"
  statistic           = "Sum"
  period              = var.reconciliation_minutes * 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  dimensions          = { Service = "ilien" }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = { Project = "ilien" }
}
resource "aws_cloudwatch_metric_alarm" "attention" {
  for_each            = toset(["UncertainEffects", "ExhaustedDispatches", "InvariantViolations"])
  alarm_name          = "ilien-${each.value}"
  namespace           = "ILIEN/Operations"
  metric_name         = each.value
  statistic           = "Sum"
  period              = var.reconciliation_minutes * 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { Service = "ilien" }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = { Project = "ilien" }
}
resource "aws_cloudwatch_metric_alarm" "database_cpu" {
  alarm_name          = "ilien-database-cpu"
  alarm_description   = "Sustained database CPU; inspect workload before scaling."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { DBInstanceIdentifier = "ilien-writer" }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = { Project = "ilien" }
}
resource "aws_cloudwatch_dashboard" "operations" {
  dashboard_name = "ilien"
  dashboard_body = jsonencode({ widgets = [
    { type = "metric", width = 24, height = 6, x = 0, y = 0, properties = { title = "Worker errors and throttles", view = "timeSeries", region = "us-east-1", period = 300, stat = "Sum", metrics = concat([for name in values(var.functions) : ["AWS/Lambda", "Errors", "FunctionName", name]], [for name in values(var.functions) : ["AWS/Lambda", "Throttles", "FunctionName", name]]) } },
    { type = "metric", width = 12, height = 6, x = 0, y = 6, properties = { title = "Ready queue oldest age (seconds)", view = "timeSeries", region = "us-east-1", period = 300, stat = "Maximum", metrics = [for name in values(var.work_queues) : ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", name]] } },
    { type = "metric", width = 12, height = 6, x = 12, y = 6, properties = { title = "Dead letters and asynchronous failures", view = "timeSeries", region = "us-east-1", period = 300, stat = "Maximum", metrics = [for name in values(var.dead_queues) : ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", name]] } },
    { type = "metric", width = 12, height = 6, x = 0, y = 12, properties = { title = "Database capacity (not a semantic health signal)", view = "timeSeries", region = "us-east-1", period = 300, metrics = [["AWS/RDS", "ServerlessDatabaseCapacity", "DBClusterIdentifier", "ilien"]] } },
    { type = "metric", width = 12, height = 6, x = 12, y = 12, properties = { title = "Reconciliation and attention", view = "timeSeries", region = "us-east-1", period = var.reconciliation_minutes * 60, stat = "Sum", metrics = [["ILIEN/Operations", "ReconciliationHeartbeat", "Service", "ilien"], ["ILIEN/Operations", "UncertainEffects", "Service", "ilien"], ["ILIEN/Operations", "ExhaustedDispatches", "Service", "ilien"]] } }
  ] })
}
output "alert_topic_arn" { value = aws_sns_topic.alerts.arn }
variable "api_id" { type = string }
resource "aws_cloudwatch_metric_alarm" "api_failures" {
  alarm_name          = "ilien-api-server-errors"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { ApiId = var.api_id }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = { Project = "ilien" }
}
resource "aws_cloudwatch_metric_alarm" "async_failures" {
  for_each            = toset(["DestinationDeliveryFailures", "AsyncEventsDropped"])
  alarm_name          = "ilien-${each.value}"
  alarm_description   = "Lambda dropped an async event or could not preserve it in its failure destination."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dynamic "metric_query" {
    for_each = { for i, name in sort(values(var.functions)) : "m${i}" => name }
    content {
      id          = metric_query.key
      return_data = false
      metric {
        metric_name = each.value
        namespace   = "AWS/Lambda"
        dimensions  = { FunctionName = metric_query.value }
        period      = 300
        stat        = "Sum"
      }
    }
  }
  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    return_data = true
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  tags          = { Project = "ilien" }
}
