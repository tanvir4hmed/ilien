resource "aws_iam_policy" "operations_deploy" {
  name = "ilien-operations-provisioning"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource"], Resource = "arn:aws:logs:us-east-1:${local.account}:log-group:/aws/apigateway/ilien" },
    { Effect = "Allow", Action = ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = "us-east-1" } } },
    { Effect = "Allow", Action = ["iam:CreateServiceLinkedRole"], Resource = "arn:aws:iam::${local.account}:role/aws-service-role/ops.apigateway.amazonaws.com/*", Condition = { StringEquals = { "iam:AWSServiceName" = "ops.apigateway.amazonaws.com" } } },
    { Effect = "Allow", Action = ["events:PutRule", "events:DescribeRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets", "events:ListTargetsByRule", "events:TagResource", "events:UntagResource", "events:ListTagsForResource"], Resource = "arn:aws:events:us-east-1:${local.account}:rule/ilien-*" },
    { Effect = "Allow", Action = ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:DescribeAlarms", "cloudwatch:TagResource", "cloudwatch:UntagResource", "cloudwatch:ListTagsForResource"], Resource = "arn:aws:cloudwatch:us-east-1:${local.account}:alarm:ilien-*" },
    { Effect = "Allow", Action = ["cloudwatch:PutDashboard", "cloudwatch:GetDashboard", "cloudwatch:DeleteDashboards"], Resource = "arn:aws:cloudwatch::${local.account}:dashboard/ilien" }
  ] })
}

resource "aws_iam_role_policy_attachment" "operations_deploy" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.operations_deploy.arn
}
