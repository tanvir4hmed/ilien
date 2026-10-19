module "console" {
  source  = "../modules/console"
  account = local.account
  api_url = aws_apigatewayv2_api.api.api_endpoint
}
resource "aws_apigatewayv2_authorizer" "operators" {
  api_id           = aws_apigatewayv2_api.api.id
  name             = "ilien-operators"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    issuer   = module.console.issuer
    audience = [module.console.client_id]
  }
}
resource "aws_apigatewayv2_route" "console" {
  api_id               = aws_apigatewayv2_api.api.id
  route_key            = "ANY /console/{proxy+}"
  authorization_type   = "JWT"
  authorizer_id        = aws_apigatewayv2_authorizer.operators.id
  authorization_scopes = ["openid"]
  target               = "integrations/${aws_apigatewayv2_integration.api.id}"
}
output "console_url" { value = module.console.url }
output "operator_pool_id" { value = module.console.pool_id }
