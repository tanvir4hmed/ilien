resource "aws_sns_topic" "cost" {
  name = "ilien-cost-alerts"
  tags = { Project = "ilien" }
}
resource "aws_sns_topic_policy" "cost" {
  arn = aws_sns_topic.cost.arn
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "BudgetAlerts", Effect = "Allow", Principal = { Service = "budgets.amazonaws.com" }, Action = "sns:Publish", Resource = aws_sns_topic.cost.arn,
    Condition = { StringEquals = { "aws:SourceAccount" = local.account } }
  }] })
}
resource "aws_budgets_budget" "demo" {
  name         = "ilien-demo-advisory"
  budget_type  = "COST"
  limit_amount = "100"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  cost_filter {
    name   = "TagKeyValue"
    values = ["Project$ilien"]
  }
  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value
      threshold_type            = "PERCENTAGE"
      notification_type         = "ACTUAL"
      subscriber_sns_topic_arns = [aws_sns_topic.cost.arn]
    }
  }
}
