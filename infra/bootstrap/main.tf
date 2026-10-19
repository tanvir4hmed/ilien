terraform {
  required_version = "= 1.15.8"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 6.0" } }
}
provider "aws" {
  region = "us-east-1"
}
data "aws_caller_identity" "current" {

}
variable "oidc_subject" {
  type = string
}
variable "mail_domain" { type = string }
variable "whatsapp_phone_number_id" { type = string }
variable "whatsapp_waba_id" { type = string }
locals {
  account = data.aws_caller_identity.current.account_id
  bucket  = "ilien-terraform-${local.account}-us-east-1"
}
resource "aws_s3_bucket" "state" {
  bucket = local.bucket
  lifecycle { prevent_destroy = true }
  tags = { Project = "ilien", Purpose = "terraform-state" }
}
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
resource "aws_iam_policy" "runtime_boundary" {
  name = "ilien-runtime-boundary"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = "arn:aws:kms:us-east-1:${local.account}:key/*", Condition = { StringEquals = { "kms:ViaService" = "sns.us-east-1.amazonaws.com", "aws:ResourceTag/Project" = "ilien" } } },
    { Effect = "Allow", Action = ["sns:Publish"], Resource = "arn:aws:sns:us-east-1:${local.account}:ilien-source-results" },
    { Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0" },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:us-east-1:${local.account}:log-group:/aws/lambda/ilien-*" },
    { Effect = "Allow", Action = ["rds-data:*"], Resource = "arn:aws:rds:us-east-1:${local.account}:cluster:ilien" },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"], Resource = ["arn:aws:secretsmanager:us-east-1:${local.account}:secret:ilien-*", "arn:aws:secretsmanager:us-east-1:${local.account}:secret:rds!cluster-*"] },
    { Effect = "Allow", Action = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = "arn:aws:sqs:us-east-1:${local.account}:ilien-*" },
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "arn:aws:s3:::ilien-channel-evidence-${local.account}-us-east-1/raw/*" },
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = "arn:aws:s3:::ilien-channel-evidence-${local.account}-us-east-1/notifications/*", Condition = { StringEquals = { "s3:if-none-match" = "*" } } },
    { Effect = "Allow", Action = ["ses:SendEmail"], Resource = ["arn:aws:ses:us-east-1:${local.account}:identity/${var.mail_domain}", "arn:aws:ses:us-east-1:${local.account}:configuration-set/ilien"] },
    { Effect = "Allow", Action = ["social-messaging:GetWhatsAppMessageTemplate"], Resource = "arn:aws:social-messaging:us-east-1:${local.account}:waba/${trimprefix(var.whatsapp_waba_id, "waba-")}" },
    { Effect = "Allow", Action = ["social-messaging:SendWhatsAppMessage"], Resource = "arn:aws:social-messaging:us-east-1:${local.account}:phone-number-id/${trimprefix(var.whatsapp_phone_number_id, "phone-number-id-")}" },
    { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = ["arn:aws:lambda:us-east-1:${local.account}:function:ilien-relay", "arn:aws:lambda:us-east-1:${local.account}:function:ilien-reconcile"] }
  ] })
}
resource "aws_iam_role" "deploy" {
  name               = "ilien-github-deploy"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Federated = "arn:aws:iam::${local.account}:oidc-provider/token.actions.githubusercontent.com" }, Action = "sts:AssumeRoleWithWebIdentity", Condition = { StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = var.oidc_subject } } }] })
}
resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.state.arn, Condition = { StringLike = { "s3:prefix" = ["ilien/*"] } } },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.state.arn}/ilien/*" },
    { Effect = "Allow", Action = ["s3:DeleteObject"], Resource = "${aws_s3_bucket.state.arn}/ilien/*.tflock" },
    { Effect = "Allow", Action = ["iam:CreateRole"], Resource = "arn:aws:iam::${local.account}:role/ilien-*", Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.runtime_boundary.arn } } },
    { Effect = "Allow", Action = ["iam:GetRole", "iam:GetRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:TagRole", "iam:UntagRole", "iam:UpdateAssumeRolePolicy"], Resource = "arn:aws:iam::${local.account}:role/ilien-*" },
    { Effect = "Allow", Action = ["iam:PassRole"], Resource = "arn:aws:iam::${local.account}:role/ilien-*", Condition = { StringEquals = { "iam:PassedToService" = "lambda.amazonaws.com" } } },
    { Effect = "Allow", Action = ["lambda:*"], Resource = ["arn:aws:lambda:us-east-1:${local.account}:function:ilien-*", "arn:aws:lambda:us-east-1:${local.account}:event-source-mapping:*"] },
    { Effect = "Allow", Action = ["lambda:ListEventSourceMappings", "lambda:GetEventSourceMapping", "lambda:CreateEventSourceMapping"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = "us-east-1" } } },
    { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource"], Resource = "arn:aws:logs:us-east-1:${local.account}:log-group:/aws/lambda/ilien-*" },
    { Effect = "Allow", Action = ["logs:DescribeLogGroups"], Resource = "*" },
    { Effect = "Allow", Action = ["sqs:*"], Resource = "arn:aws:sqs:us-east-1:${local.account}:ilien-*" },
    { Effect = "Allow", Action = ["rds:Describe*", "rds:ListTagsForResource"], Resource = "*" },
    { Effect = "Allow", Action = ["rds:CreateDBCluster", "rds:ModifyDBCluster", "rds:DeleteDBCluster", "rds:CreateDBInstance", "rds:ModifyDBInstance", "rds:DeleteDBInstance", "rds:CreateDBSubnetGroup", "rds:DeleteDBSubnetGroup", "rds:ModifyDBSubnetGroup", "rds:EnableHttpEndpoint", "rds:DisableHttpEndpoint", "rds:AddTagsToResource", "rds:RemoveTagsFromResource"], Resource = ["arn:aws:rds:us-east-1:${local.account}:cluster:ilien", "arn:aws:rds:us-east-1:${local.account}:db:ilien-*", "arn:aws:rds:us-east-1:${local.account}:subgrp:ilien", "arn:aws:rds:us-east-1:${local.account}:pg:default.*", "arn:aws:rds:us-east-1:${local.account}:cluster-pg:default.*"] },
    { Effect = "Allow", Action = ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:TagResource", "secretsmanager:UntagResource", "secretsmanager:UpdateSecret", "secretsmanager:DeleteSecret", "secretsmanager:GetResourcePolicy"], Resource = ["arn:aws:secretsmanager:us-east-1:${local.account}:secret:ilien-*", "arn:aws:secretsmanager:us-east-1:${local.account}:secret:rds!cluster-*"] },
    { Effect = "Allow", Action = ["kms:DescribeKey"], Resource = "*" },
    { Effect = "Allow", Action = ["ec2:Describe*"], Resource = "*" },
    { Effect = "Allow", Action = ["ec2:CreateSubnet", "ec2:CreateSecurityGroup"], Resource = "arn:aws:ec2:us-east-1:${local.account}:vpc/*", Condition = { StringEquals = { "aws:ResourceTag/Project" = "ilien" } } },
    { Effect = "Allow", Action = ["ec2:CreateVpc", "ec2:CreateSubnet", "ec2:CreateSecurityGroup"], Resource = "*", Condition = { StringEquals = { "aws:RequestTag/Project" = "ilien" } } },
    { Effect = "Allow", Action = ["ec2:CreateTags"], Resource = "arn:aws:ec2:us-east-1:${local.account}:*/*", Condition = { StringEquals = { "aws:RequestTag/Project" = "ilien" } } },
    { Effect = "Allow", Action = ["ec2:CreateTags"], Resource = "arn:aws:ec2:us-east-1:${local.account}:*/*", Condition = { StringEquals = { "aws:ResourceTag/Project" = "ilien" } } },
    { Effect = "Allow", Action = ["ec2:ModifyVpcAttribute", "ec2:DeleteVpc", "ec2:DeleteSubnet", "ec2:DeleteSecurityGroup", "ec2:RevokeSecurityGroupEgress", "ec2:AuthorizeSecurityGroupEgress"], Resource = "*", Condition = { StringEquals = { "aws:ResourceTag/Project" = "ilien" } } },
    { Effect = "Allow", Action = ["apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE"], Resource = ["arn:aws:apigateway:us-east-1::/apis*", "arn:aws:apigateway:us-east-1::/tags/*"] }
  ] })
}
output "state_bucket" {
  value = aws_s3_bucket.state.id
}
output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}
output "runtime_boundary_arn" {
  value = aws_iam_policy.runtime_boundary.arn
}

resource "aws_iam_role_policy" "channel_deploy" {
  name = "ilien-channel-provisioning"
  role = aws_iam_role.deploy.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["sns:CreateTopic", "sns:DeleteTopic", "sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:TagResource", "sns:UntagResource", "sns:ListTagsForResource", "sns:Subscribe"], Resource = "arn:aws:sns:us-east-1:${local.account}:ilien-*" },
    { Effect = "Allow", Action = ["sns:GetSubscriptionAttributes", "sns:SetSubscriptionAttributes", "sns:Unsubscribe"], Resource = "arn:aws:sns:us-east-1:${local.account}:ilien-*" },
    { Effect = "Allow", Action = ["s3:CreateBucket", "s3:DeleteBucket", "s3:Get*", "s3:ListBucket", "s3:PutBucketPolicy", "s3:PutBucketPublicAccessBlock", "s3:PutEncryptionConfiguration", "s3:PutLifecycleConfiguration", "s3:PutBucketTagging"], Resource = "arn:aws:s3:::ilien-channel-evidence-${local.account}-us-east-1" },
    { Effect = "Allow", Action = ["ses:VerifyDomainIdentity", "ses:VerifyDomainDkim", "ses:GetIdentityVerificationAttributes", "ses:GetIdentityDkimAttributes", "ses:GetIdentityMailFromDomainAttributes", "ses:GetIdentityNotificationAttributes", "ses:SetIdentityMailFromDomain", "ses:DeleteIdentity", "ses:CreateReceiptRuleSet", "ses:DeleteReceiptRuleSet", "ses:DescribeReceiptRuleSet", "ses:DescribeActiveReceiptRuleSet", "ses:CreateReceiptRule", "ses:UpdateReceiptRule", "ses:DeleteReceiptRule", "ses:DescribeReceiptRule", "ses:SetActiveReceiptRuleSet", "ses:CreateConfigurationSet", "ses:DeleteConfigurationSet", "ses:GetConfigurationSet", "ses:PutConfigurationSetSuppressionOptions", "ses:CreateConfigurationSetEventDestination", "ses:UpdateConfigurationSetEventDestination", "ses:DeleteConfigurationSetEventDestination", "ses:GetConfigurationSetEventDestinations", "ses:TagResource", "ses:UntagResource", "ses:ListTagsForResource"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = "us-east-1" } } },
    { Effect = "Allow", Action = ["kms:CreateKey"], Resource = "*", Condition = { StringEquals = { "aws:RequestTag/Project" = "ilien" } } },
    { Effect = "Allow", Action = ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags", "kms:PutKeyPolicy", "kms:EnableKeyRotation", "kms:DisableKeyRotation", "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:UpdateKeyDescription"], Resource = "arn:aws:kms:us-east-1:${local.account}:key/*", Condition = { StringEquals = { "aws:ResourceTag/Project" = "ilien" } } },
    { Effect = "Allow", Action = ["kms:CreateAlias", "kms:DeleteAlias", "kms:UpdateAlias"], Resource = ["arn:aws:kms:us-east-1:${local.account}:alias/ilien-*", "arn:aws:kms:us-east-1:${local.account}:key/*"] },
    { Effect = "Allow", Action = ["kms:ListAliases"], Resource = "*" },
    { Effect = "Allow", Action = ["social-messaging:GetLinkedWhatsAppBusinessAccount", "social-messaging:PutWhatsAppBusinessAccountEventDestinations"], Resource = "arn:aws:social-messaging:us-east-1:${local.account}:waba/${trimprefix(var.whatsapp_waba_id, "waba-")}" }
  ] })
}
