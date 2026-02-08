output "r2_bucket_name" {
  value       = cloudflare_r2_bucket.moltbot_data.name
  description = "Name of the R2 bucket for moltbot data"
}

output "r2_bucket_location" {
  value       = cloudflare_r2_bucket.moltbot_data.location
  description = "Location of the R2 bucket"
}
