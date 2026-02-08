#!/bin/bash
# 시크릿 일괄 등록 + Worker 배포
set -e

cd "$(dirname "$0")"

# secrets.env 로드
if [ ! -f secrets.env ]; then
    echo "Error: secrets.env not found. Copy secrets.env.example first." >&2
    exit 1
fi

source secrets.env

# 필수 시크릿 체크
: "${MOLTBOT_GATEWAY_TOKEN:?Required}"

# 시크릿 등록 (값이 있는 것만)
for secret in MOLTBOT_GATEWAY_TOKEN CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD \
              CLOUDFLARE_AI_GATEWAY_API_KEY CF_AI_GATEWAY_ACCOUNT_ID \
              CF_AI_GATEWAY_GATEWAY_ID CF_AI_GATEWAY_MODEL \
              ANTHROPIC_API_KEY R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY \
              CF_ACCOUNT_ID SANDBOX_SLEEP_AFTER; do
    value="${!secret}"
    [ -n "$value" ] && echo "$value" | npx wrangler secret put "$secret"
done

# Worker 배포
cd ..
npm run deploy
