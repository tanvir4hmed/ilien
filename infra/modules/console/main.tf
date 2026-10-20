variable "account" { type = string }
variable "api_url" { type = string }
resource "aws_cognito_user_pool" "operators" {
  name                = "ilien-operators"
  deletion_protection = "ACTIVE"
  username_attributes = ["email"]
  username_configuration { case_sensitive = false }
  admin_create_user_config { allow_admin_create_user_only = true }
  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }
  # Temporarily disabled for operator onboarding. Restore ON and enabled=true
  # before the release security review; changing this is an explicit deployment.
  mfa_configuration = "OFF"
  # software_token_mfa_configuration { enabled = true }
  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }
  tags = { Project = "ilien" }
}
resource "aws_cognito_user_pool_domain" "operators" {
  domain       = "ilien-${var.account}"
  user_pool_id = aws_cognito_user_pool.operators.id
}
resource "aws_cognito_user_pool_client" "console" {
  name                                 = "ilien-console"
  user_pool_id                         = aws_cognito_user_pool.operators.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = [for origin in local.allowed_origins : "${origin}/"]
  logout_urls                          = [for origin in local.allowed_origins : "${origin}/"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  access_token_validity                = 15
  id_token_validity                    = 15
  refresh_token_validity               = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }
  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]
}
resource "aws_s3_bucket" "console" {
  bucket = "ilien-console-${var.account}-us-east-1"
  tags   = { Project = "ilien" }
}
resource "aws_s3_bucket_public_access_block" "console" {
  bucket                  = aws_s3_bucket.console.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "console" {
  bucket = aws_s3_bucket.console.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_cloudfront_origin_access_control" "console" {
  name                              = "ilien-console"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
resource "aws_cloudfront_response_headers_policy" "console" {
  name = "ilien-console"
  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' https://*.execute-api.us-east-1.amazonaws.com https://${aws_cognito_user_pool_domain.operators.domain}.auth.us-east-1.amazoncognito.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests"
      override                = true
    }
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      override                   = true
    }
  }
}
resource "aws_cloudfront_distribution" "console" {
  aliases = local.custom_enabled ? [var.custom_domain] : []
  lifecycle {
    precondition {
      condition     = !local.custom_enabled || try(aws_acm_certificate.console[0].status == "ISSUED", false)
      error_message = "Publish the ACM DNS validation record and wait for ISSUED before enabling the custom hostname."
    }
  }
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  comment             = "ILIEN operator workspace"
  origin {
    domain_name              = aws_s3_bucket.console.bucket_regional_domain_name
    origin_id                = "console"
    origin_access_control_id = aws_cloudfront_origin_access_control.console.id
  }
  default_cache_behavior {
    target_origin_id           = "console"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.console.id
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate {
    cloudfront_default_certificate = !local.custom_enabled
    acm_certificate_arn            = local.custom_enabled ? aws_acm_certificate.console[0].arn : null
    ssl_support_method             = local.custom_enabled ? "sni-only" : null
    minimum_protocol_version       = local.custom_enabled ? "TLSv1.2_2021" : "TLSv1"
  }
  tags = { Project = "ilien" }
}
resource "aws_s3_bucket_policy" "console" {
  bucket = aws_s3_bucket.console.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Principal = { Service = "cloudfront.amazonaws.com" }, Action = "s3:GetObject", Resource = "${aws_s3_bucket.console.arn}/*", Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.console.arn } } },
    { Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.console.arn, "${aws_s3_bucket.console.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }
  ] })
}
resource "aws_s3_object" "assets" {
  for_each               = fileset("../../dist/console", "**")
  bucket                 = aws_s3_bucket.console.id
  key                    = each.value
  source                 = "../../dist/console/${each.value}"
  source_hash            = filemd5("../../dist/console/${each.value}")
  content_type           = endswith(each.value, ".html") ? "text/html; charset=utf-8" : endswith(each.value, ".css") ? "text/css; charset=utf-8" : endswith(each.value, ".js") ? "text/javascript; charset=utf-8" : "application/json"
  cache_control          = "no-store"
  server_side_encryption = "AES256"
}
resource "aws_s3_object" "config" {
  bucket                 = aws_s3_bucket.console.id
  key                    = "config.json"
  content_type           = "application/json"
  cache_control          = "no-store"
  server_side_encryption = "AES256"
  content                = jsonencode({ apiUrl = var.api_url, authDomain = "https://${aws_cognito_user_pool_domain.operators.domain}.auth.us-east-1.amazoncognito.com", clientId = aws_cognito_user_pool_client.console.id, redirectUri = "${local.public_url}/", redirectUris = [for origin in local.allowed_origins : "${origin}/"] })
}
output "url" { value = "https://${aws_cloudfront_distribution.console.domain_name}" }
output "issuer" { value = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.operators.id}" }
output "client_id" { value = aws_cognito_user_pool_client.console.id }
output "pool_id" { value = aws_cognito_user_pool.operators.id }
