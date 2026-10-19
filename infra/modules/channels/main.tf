variable "name" { type = string }
variable "mail_domain" { type = string }
variable "waba_arn" { type = string }
data "aws_caller_identity" "current" {}
locals { account = data.aws_caller_identity.current.account_id }

resource "aws_kms_key" "notifications" {
  description             = "ILIEN channel notification encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Principal = { AWS = "arn:aws:iam::${local.account}:root" }, Action = "kms:*", Resource = "*" },
    { Effect = "Allow", Principal = { Service = ["ses.amazonaws.com", "social-messaging.amazonaws.com"] }, Action = ["kms:GenerateDataKey*", "kms:Decrypt"], Resource = "*", Condition = { StringEquals = { "aws:SourceAccount" = local.account }, ArnLike = { "aws:SourceArn" = [var.waba_arn, "arn:aws:ses:us-east-1:${local.account}:*"] } } }
  ] })
  tags = { Project = "ilien" }
}
resource "aws_kms_alias" "notifications" {
  name          = "alias/ilien-channel-notifications"
  target_key_id = aws_kms_key.notifications.key_id
}
resource "aws_sns_topic" "events" {
  for_each          = toset(["whatsapp", "email", "email-events"])
  name              = "${var.name}-${each.key}"
  kms_master_key_id = aws_kms_key.notifications.arn
  tags              = { Project = "ilien" }
}
resource "aws_sns_topic_policy" "events" {
  for_each = aws_sns_topic.events
  arn      = each.value.arn
  policy   = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = each.key == "whatsapp" ? "social-messaging.amazonaws.com" : "ses.amazonaws.com" }, Action = "sns:Publish", Resource = each.value.arn, Condition = { StringEquals = { "aws:SourceAccount" = local.account }, ArnLike = { "aws:SourceArn" = each.key == "whatsapp" ? var.waba_arn : "arn:aws:ses:us-east-1:${local.account}:*" } } }] })
}
module "inbound" {
  source = "../queue"
  name   = "${var.name}-channel-receive"
}
module "outbound" {
  source = "../queue"
  name   = "${var.name}-channel-send"
}
resource "aws_sqs_queue_policy" "inbound" {
  queue_url = module.inbound.url
  policy    = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "sns.amazonaws.com" }, Action = "sqs:SendMessage", Resource = module.inbound.arn, Condition = { ArnEquals = { "aws:SourceArn" = [for t in aws_sns_topic.events : t.arn] } } }] })
}
resource "aws_sns_topic_subscription" "inbound" {
  for_each             = aws_sns_topic.events
  topic_arn            = each.value.arn
  protocol             = "sqs"
  endpoint             = module.inbound.arn
  raw_message_delivery = false
  depends_on           = [aws_sqs_queue_policy.inbound]
}
resource "aws_s3_bucket" "evidence" {
  bucket = "${var.name}-channel-evidence-${local.account}-us-east-1"
  tags   = { Project = "ilien" }
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket                  = aws_s3_bucket.evidence.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  rule {
    id     = "raw-evidence-retention"
    status = "Enabled"
    filter {}
    expiration { days = 90 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}
resource "aws_s3_bucket_policy" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.evidence.arn, "${aws_s3_bucket.evidence.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } },
    { Effect = "Allow", Principal = { Service = "ses.amazonaws.com" }, Action = "s3:PutObject", Resource = "${aws_s3_bucket.evidence.arn}/raw/*", Condition = { StringEquals = { "aws:SourceAccount" = local.account }, ArnEquals = { "aws:SourceArn" = "arn:aws:ses:us-east-1:${local.account}:receipt-rule-set/${var.name}:receipt-rule/${var.name}" } } }
  ] })
}
resource "aws_ses_domain_identity" "mail" { domain = var.mail_domain }
resource "aws_ses_domain_dkim" "mail" { domain = aws_ses_domain_identity.mail.domain }
resource "aws_ses_domain_mail_from" "mail" {
  domain                 = aws_ses_domain_identity.mail.domain
  mail_from_domain       = "bounce.${var.mail_domain}"
  behavior_on_mx_failure = "RejectMessage"
}
resource "aws_ses_receipt_rule_set" "mail" { rule_set_name = var.name }
resource "aws_ses_receipt_rule" "mail" {
  name          = var.name
  rule_set_name = aws_ses_receipt_rule_set.mail.rule_set_name
  recipients    = [var.mail_domain]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"
  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.evidence.id
    object_key_prefix = "raw/"
    topic_arn         = aws_sns_topic.events["email"].arn
  }
  depends_on = [aws_s3_bucket_policy.evidence, aws_sns_topic_policy.events]
}
resource "aws_ses_active_receipt_rule_set" "mail" {
  rule_set_name = aws_ses_receipt_rule_set.mail.rule_set_name
  depends_on    = [aws_ses_receipt_rule.mail]
}
resource "aws_sesv2_configuration_set" "mail" {
  configuration_set_name = var.name
  suppression_options { suppressed_reasons = ["BOUNCE", "COMPLAINT"] }
  tags = { Project = "ilien" }
}
resource "aws_sesv2_configuration_set_event_destination" "mail" {
  configuration_set_name = aws_sesv2_configuration_set.mail.configuration_set_name
  event_destination_name = "ilien-receipts"
  event_destination {
    enabled              = true
    matching_event_types = ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"]
    sns_destination { topic_arn = aws_sns_topic.events["email-events"].arn }
  }
  depends_on = [aws_sns_topic_policy.events]
}
output "inbound_arn" { value = module.inbound.arn }
output "outbound_arn" { value = module.outbound.arn }
output "outbound_url" { value = module.outbound.url }
output "bucket" { value = aws_s3_bucket.evidence.id }
output "bucket_arn" { value = aws_s3_bucket.evidence.arn }
output "topics" { value = { for k, v in aws_sns_topic.events : k => v.arn } }
output "dns_records" {
  value = concat([
    { type = "TXT", name = "_amazonses.${var.mail_domain}", value = aws_ses_domain_identity.mail.verification_token },
    { type = "MX", name = var.mail_domain, value = "10 inbound-smtp.us-east-1.amazonaws.com" },
    { type = "MX", name = "bounce.${var.mail_domain}", value = "10 feedback-smtp.us-east-1.amazonses.com" },
    { type = "TXT", name = "bounce.${var.mail_domain}", value = "v=spf1 include:amazonses.com -all" },
    { type = "TXT", name = "_dmarc.${var.mail_domain}", value = "v=DMARC1; p=reject; adkim=s; aspf=r" }
  ], [for token in aws_ses_domain_dkim.mail.dkim_tokens : { type = "CNAME", name = "${token}._domainkey.${var.mail_domain}", value = "${token}.dkim.amazonses.com" }])
}

output "notification_key_arn" { value = aws_kms_key.notifications.arn }
