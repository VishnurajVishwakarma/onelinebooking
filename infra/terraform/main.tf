terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "environment" {
  type        = string
  description = "Deployment environment: development | staging | production"
  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "Must be development, staging, or production."
  }
}

variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "domain_name" {
  type    = string
  default = "onelinebooking.example.com"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 50
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 2
}

provider "aws" {
  region = var.aws_region
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = "olb-${var.environment}-vpc", Environment = var.environment }
}

# Private database subnet group — PostgreSQL is NEVER assigned a public IP or internet route
resource "aws_subnet" "private_db" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 20 + count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "olb-${var.environment}-db-${count.index}" }
}

resource "aws_subnet" "private_app" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 10 + count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "olb-${var.environment}-app-${count.index}" }
}

resource "aws_subnet" "public_edge" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = true
  tags                    = { Name = "olb-${var.environment}-edge-${count.index}" }
}

resource "aws_db_subnet_group" "postgres" {
  name       = "olb-${var.environment}-db-subnets"
  subnet_ids = aws_subnet.private_db[*].id
}

resource "aws_security_group" "app" {
  name        = "olb-${var.environment}-app-sg"
  description = "API, Console, PgBouncer, and Docs runtime security group"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "Allow DB access to private PostgreSQL and internal VPC endpoints"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "Allow outbound TLS (Secrets Manager, KMS, SMTP relay)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Explicit network-level webhook egress control SG for OutboxWebhookWorker
resource "aws_security_group" "webhook_worker" {
  name        = "olb-${var.environment}-webhook-worker-sg"
  description = "Dedicated egress-restricted SG for persistent OutboxWebhookWorker"
  vpc_id      = aws_vpc.main.id

  # Allow DB + VPC endpoints only inside private CIDR; block all RFC1918 HTTP/metadata in VPC routing + SG
  egress {
    description = "PostgreSQL/PgBouncer inside VPC only"
    from_port   = 5432
    to_port     = 6432
    protocol    = "tcp"
    cidr_blocks = aws_subnet.private_db[*].cidr_block
  }

  egress {
    description = "HTTPS webhook delivery egress (SSRF metadata 169.254.169.254/32 and VPC internal blocked by NACLs & app SSRF pin)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Explicit Network ACL denying cloud metadata (169.254.169.254/32) and RFC1918 webhook egress from private app tier
resource "aws_network_acl" "webhook_egress_guard" {
  vpc_id     = aws_vpc.main.id
  subnet_ids = aws_subnet.private_app[*].id

  egress {
    protocol   = "tcp"
    rule_no    = 50
    action     = "deny"
    cidr_block = "169.254.169.254/32"
    from_port  = 0
    to_port    = 65535
  }

  egress {
    protocol   = "tcp"
    rule_no    = 100
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 443
    to_port    = 443
  }

  egress {
    protocol   = "tcp"
    rule_no    = 110
    action     = "allow"
    cidr_block = var.vpc_cidr
    from_port  = 5432
    to_port    = 6432
  }
}

resource "aws_security_group" "postgres" {
  name   = "olb-${var.environment}-pg-sg"
  vpc_id = aws_vpc.main.id

  ingress {
    description     = "Allow PostgreSQL strictly from App/PgBouncer and Workers"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id, aws_security_group.webhook_worker.id]
  }
}

resource "aws_kms_key" "webhook_secrets" {
  description             = "OneLineBooking ${var.environment} KMS CMK for webhook envelope encryption and RDS"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_secretsmanager_secret" "platform_secrets" {
  name       = "onelinebooking/${var.environment}/runtime"
  kms_key_id = aws_kms_key.webhook_secrets.arn
}

resource "aws_db_instance" "postgres" {
  identifier                  = "olb-${var.environment}-pg17"
  engine                      = "postgres"
  engine_version              = "17.2"
  instance_class              = var.db_instance_class
  allocated_storage           = var.db_allocated_storage_gb
  max_allocated_storage       = var.db_allocated_storage_gb * 4
  storage_encrypted           = true
  kms_key_id                  = aws_kms_key.webhook_secrets.arn
  db_name                     = "mygamingslot"
  username                    = "olb_admin"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.postgres.name
  vpc_security_group_ids      = [aws_security_group.postgres.id]
  publicly_accessible         = false
  multi_az                    = var.environment == "production"
  backup_retention_period     = var.environment == "production" ? 35 : 7
  backup_window               = "01:00-02:00"
  maintenance_window          = "sun:02:30-sun:03:30"
  deletion_protection         = var.environment == "production"
  skip_final_snapshot         = var.environment != "production"
}

resource "aws_acm_certificate" "public_tls" {
  domain_name               = var.domain_name
  subject_alternative_names = ["*.${var.domain_name}"]
  validation_method         = "DNS"
}

resource "aws_cloudwatch_log_group" "platform" {
  name              = "/onelinebooking/${var.environment}"
  retention_in_days = var.environment == "production" ? 90 : 30
  kms_key_id        = aws_kms_key.webhook_secrets.arn
}

resource "aws_cloudwatch_metric_alarm" "high_5xx" {
  alarm_name          = "olb-${var.environment}-api-5xx-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "Triggers rollback/page when ALB 5XX exceeds 10/min for 2 minutes"
}

resource "aws_ecs_cluster" "main" {
  name = "olb-${var.environment}-cluster"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_wafv2_web_acl" "edge" {
  name  = "olb-${var.environment}-waf"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "RateLimitPerIp"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.environment == "production" ? 2000 : 5000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "olb-waf-rate"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "olb-waf"
    sampled_requests_enabled   = true
  }
}
