variable "name" {
  type = string
}
resource "aws_sqs_queue" "dead" {
  name                      = "${var.name}-dead"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = { Project = "ilien" }
}
resource "aws_sqs_queue" "work" {
  name                       = "${var.name}-intake"
  visibility_timeout_seconds = var.visibility_timeout
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dead.arn, maxReceiveCount = 5 })
  tags                       = { Project = "ilien" }
}
output "arn" {
  value = aws_sqs_queue.work.arn
}
output "url" {
  value = aws_sqs_queue.work.url
}

variable "visibility_timeout" {
  type    = number
  default = 360
}
