environment             = "staging"
aws_region              = "ap-south-1"
vpc_cidr                = "10.42.0.0/16"
domain_name             = "staging.onelinebooking.example.com"
db_instance_class       = "db.t4g.medium"
db_allocated_storage_gb = 50
api_desired_count       = 2
worker_desired_count    = 2

