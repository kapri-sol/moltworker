terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

resource "cloudflare_r2_bucket" "moltbot_data" {
  account_id = var.cloudflare_account_id
  name       = "moltbot-data"
  location   = "WNAM"
}
