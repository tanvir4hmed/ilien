variable "name" {
  type = string
}
variable "engine_version" {
  type = string
}
data "aws_availability_zones" "available" {
  state = "available"
}
resource "aws_vpc" "main" {
  cidr_block           = "10.82.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name, Project = "ilien" }
}
resource "aws_subnet" "database" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${var.name}-db-${count.index}", Project = "ilien" }
}
resource "aws_security_group" "database" {
  name        = "${var.name}-database"
  vpc_id      = aws_vpc.main.id
  description = "No network ingress; access through authenticated RDS Data API"
  tags        = { Project = "ilien" }
}
resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.database[*].id
  tags       = { Project = "ilien" }
}
resource "aws_rds_cluster" "main" {
  cluster_identifier          = var.name
  engine                      = "aurora-postgresql"
  engine_version              = var.engine_version
  database_name               = "ilien"
  master_username             = "ilien_migrator"
  manage_master_user_password = true
  storage_encrypted           = true
  enable_http_endpoint        = true
  db_subnet_group_name        = aws_db_subnet_group.main.name
  vpc_security_group_ids      = [aws_security_group.database.id]
  backup_retention_period     = 7
  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${var.name}-final"
  serverlessv2_scaling_configuration {
    min_capacity             = 0
    max_capacity             = 2
    seconds_until_auto_pause = 300
  }
  tags = { Project = "ilien" }
}
resource "aws_rds_cluster_instance" "main" {
  identifier          = "${var.name}-writer"
  cluster_identifier  = aws_rds_cluster.main.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.main.engine
  engine_version      = aws_rds_cluster.main.engine_version
  publicly_accessible = false
  tags                = { Project = "ilien" }
}
resource "aws_secretsmanager_secret" "application" {
  name                    = "${var.name}-database-app"
  recovery_window_in_days = 7
  tags                    = { Project = "ilien" }
}
output "cluster_arn" {
  value = aws_rds_cluster.main.arn
}
output "master_secret_arn" {
  value = aws_rds_cluster.main.master_user_secret[0].secret_arn
}
output "app_secret_arn" {
  value = aws_secretsmanager_secret.application.arn
}
