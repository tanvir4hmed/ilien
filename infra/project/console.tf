module "console" {
  source              = "../modules/console"
  account             = local.account
  custom_domain       = var.app_domain
  custom_domain_ready = var.custom_domain_ready
  api_url             = aws_apigatewayv2_api.api.api_endpoint
  guest_username      = var.guest_username
  guest_password      = var.guest_password
}
resource "aws_apigatewayv2_authorizer" "operators" {
  api_id           = aws_apigatewayv2_api.api.id
  name             = "ilien-operators"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    issuer   = module.console.issuer
    audience = [module.console.client_id, module.console.guest_client_id]
  }
}
resource "aws_apigatewayv2_route" "console" {
  api_id               = aws_apigatewayv2_api.api.id
  route_key            = "ANY /console/{proxy+}"
  authorization_type   = "JWT"
  authorizer_id        = aws_apigatewayv2_authorizer.operators.id
  authorization_scopes = ["openid", "aws.cognito.signin.user.admin"]
  target               = "integrations/${aws_apigatewayv2_integration.api.id}"
}
resource "aws_apigatewayv2_route" "console_preflight" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "OPTIONS /console/{proxy+}"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
}
output "console_url" { value = module.console.app_url }
output "operator_pool_id" { value = module.console.pool_id }

variable "app_domain" { type = string }
variable "custom_domain_ready" {
  type    = bool
  default = false
}
output "web_dns_records" { value = module.console.web_dns_records }
variable "guest_username" {
  type    = string
  default = ""
}
variable "guest_password" {
  type      = string
  default   = ""
  sensitive = true
}
