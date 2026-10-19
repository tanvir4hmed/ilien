resource "aws_iam_role_policy" "console_deploy" {
  name = "ilien-console-provisioning"
  role = aws_iam_role.deploy.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["cognito-idp:CreateUserPool"], Resource = "*", Condition = { StringEquals = { "aws:RequestTag/Project" = "ilien" } } },
    { Effect = "Allow", Action = ["cognito-idp:DescribeUserPool", "cognito-idp:UpdateUserPool", "cognito-idp:DeleteUserPool", "cognito-idp:GetUserPoolMfaConfig", "cognito-idp:SetUserPoolMfaConfig", "cognito-idp:ListTagsForResource", "cognito-idp:TagResource", "cognito-idp:UntagResource", "cognito-idp:CreateUserPoolClient", "cognito-idp:DescribeUserPoolClient", "cognito-idp:UpdateUserPoolClient", "cognito-idp:DeleteUserPoolClient", "cognito-idp:CreateUserPoolDomain", "cognito-idp:UpdateUserPoolDomain", "cognito-idp:DeleteUserPoolDomain"], Resource = "arn:aws:cognito-idp:us-east-1:${local.account}:userpool/*", Condition = { StringEquals = { "aws:ResourceTag/Project" = "ilien" } } },
    { Effect = "Allow", Action = ["cognito-idp:DescribeUserPoolDomain"], Resource = "*" },
    { Effect = "Allow", Action = ["s3:CreateBucket", "s3:Get*", "s3:ListBucket", "s3:PutBucketPolicy", "s3:PutBucketPublicAccessBlock", "s3:PutEncryptionConfiguration", "s3:PutBucketTagging"], Resource = "arn:aws:s3:::ilien-console-${local.account}-us-east-1" },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:PutObjectTagging", "s3:GetObjectTagging"], Resource = "arn:aws:s3:::ilien-console-${local.account}-us-east-1/*" },
    { Effect = "Allow", Action = ["cloudfront:CreateDistribution", "cloudfront:CreateDistributionWithTags", "cloudfront:CreateOriginAccessControl", "cloudfront:GetOriginAccessControl", "cloudfront:UpdateOriginAccessControl", "cloudfront:DeleteOriginAccessControl", "cloudfront:CreateResponseHeadersPolicy", "cloudfront:GetResponseHeadersPolicy", "cloudfront:UpdateResponseHeadersPolicy", "cloudfront:DeleteResponseHeadersPolicy"], Resource = "*" },
    { Effect = "Allow", Action = ["cloudfront:GetDistribution", "cloudfront:GetDistributionConfig", "cloudfront:UpdateDistribution", "cloudfront:ListTagsForResource", "cloudfront:TagResource", "cloudfront:UntagResource"], Resource = "arn:aws:cloudfront::${local.account}:distribution/*", Condition = { StringEquals = { "aws:ResourceTag/Project" = "ilien" } } }
  ] })
}
