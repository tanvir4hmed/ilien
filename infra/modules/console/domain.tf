variable "custom_domain" {
  type    = string
  default = ""
  validation {
    condition     = var.custom_domain == "" || can(regex("^[a-z0-9][a-z0-9.-]+\\.[a-z]{2,}$", var.custom_domain))
    error_message = "Use a lowercase DNS hostname without scheme or path."
  }
}
variable "custom_domain_ready" {
  type    = bool
  default = false
}
locals {
  custom_enabled  = var.custom_domain != "" && var.custom_domain_ready
  public_url      = local.custom_enabled ? "https://${var.custom_domain}" : "https://${aws_cloudfront_distribution.console.domain_name}"
  allowed_origins = concat(["https://${aws_cloudfront_distribution.console.domain_name}"], local.custom_enabled ? ["https://${var.custom_domain}"] : [])
}
resource "aws_acm_certificate" "console" {
  count             = var.custom_domain == "" ? 0 : 1
  domain_name       = var.custom_domain
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
  tags = { Project = "ilien" }
}
output "app_url" { value = local.public_url }
output "allowed_origins" { value = local.allowed_origins }
output "web_dns_records" {
  value = concat([for record in try(aws_acm_certificate.console[0].domain_validation_options, []) : { type = record.resource_record_type, name = record.resource_record_name, value = record.resource_record_value, purpose = "TLS certificate validation; keep DNS-only" }], var.custom_domain == "" ? [] : [{ type = "CNAME", name = var.custom_domain, value = aws_cloudfront_distribution.console.domain_name, purpose = "Application hosting" }])
}
