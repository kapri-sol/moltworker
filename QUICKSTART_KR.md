# Moltworker 설정 가이드

Cloudflare Workers에서 실행되는 AI 에이전트(OpenClaw). 코드 변경 없이 환경 변수 설정만으로 배포 가능.

---

## 필수 요구사항

- **Cloudflare Workers Paid 플랜** ($5/월) - Sandbox 필수
- **AI 제공자 API 키** (Gemini 무료 250 req/day 또는 Anthropic Claude)
- Node.js 22+

---

## 빠른 시작

### 1. Cloudflare 설정

```bash
# Containers 활성화
# Dashboard → Workers & Pages → Containers → Enable

# R2 활성화
# Dashboard → R2 → Get Started
```

### 2. 프로젝트 설치

```bash
cd /path/to/moltworker
npm install
npx wrangler login
```

### 3. AI Gateway + Gemini 설정 (추천)

**⚠️ 중요**: Moltworker는 `GOOGLE_API_KEY` 직접 지원 안 함. AI Gateway 경유 필요.

```bash
# AI Gateway 생성
# https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/create-gateway
# Gateway ID 복사

# 시크릿 등록
npx wrangler secret put CLOUDFLARE_AI_GATEWAY_API_KEY  # Gemini API 키
npx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID       # Cloudflare Account ID
npx wrangler secret put CF_AI_GATEWAY_GATEWAY_ID       # Gateway ID
npx wrangler secret put CF_AI_GATEWAY_MODEL            # google-ai-studio/gemini-2.5-flash

# 게이트웨이 토큰 (macOS 키체인 저장)
export MOLTBOT_GATEWAY_TOKEN=$(openssl rand -hex 32)
security add-generic-password -s moltworker -a gateway-token -w "$MOLTBOT_GATEWAY_TOKEN"
echo "$MOLTBOT_GATEWAY_TOKEN" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN
```

**대안: Anthropic 직접 연결**
```bash
npx wrangler secret put ANTHROPIC_API_KEY  # Claude ($3/$15)
echo "$MOLTBOT_GATEWAY_TOKEN" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN
```

### 4. Cloudflare Access 설정

```bash
# Workers Dashboard → moltbot-sandbox → Settings → Domains & Routes
# workers.dev 행에서 "Enable Cloudflare Access" 클릭
# AUD 태그 복사

# Zero Trust → Settings → Custom Pages에서 Team Domain 확인
# 예: ksm6902-eb0.cloudflareaccess.com

npx wrangler secret put CF_ACCESS_TEAM_DOMAIN  # xxx.cloudflareaccess.com
npx wrangler secret put CF_ACCESS_AUD          # AUD 태그 붙여넣기
```

### 5. 배포

```bash
npm run deploy
```

배포 완료 후 URL: `https://moltbot-sandbox.<subdomain>.workers.dev`

### 6. 접속 및 디바이스 페어링

```bash
# 쉘 alias 등록 (한번만)
echo 'alias moltworker="open \"https://moltbot-sandbox.<subdomain>.workers.dev/?token=\$(security find-generic-password -s moltworker -a gateway-token -w)\""' >> ~/.zshrc
source ~/.zshrc

# 접속
moltworker
```

1. Control UI에 "Pairing required" 메시지 표시됨
2. `/_admin/` 접속 → Cloudflare Access 이메일 인증
3. Admin UI에서 Pending requests → **Approve** 클릭
4. Control UI 탭으로 돌아가면 자동 연결

---

## 선택 설정

### R2 영구 스토리지 (권장)

대화 기록 영구 저장. 미설정 시 컨테이너 재시작마다 초기화.

**1. R2 버킷 생성**
```bash
# Dashboard → R2 → Create bucket
# 버킷 이름: moltbot-data
```

**2. R2 API 토큰 생성**
```bash
# Dashboard → R2 → Manage R2 API Tokens → Create API Token
# 권한: Object Read & Write
# 버킷 선택: moltbot-data
# Access Key ID와 Secret Access Key 복사 (한 번만 표시됨)
```

**3. 시크릿 등록 및 배포**
```bash
npx wrangler secret put R2_ACCESS_KEY_ID       # 2단계 Access Key ID
npx wrangler secret put R2_SECRET_ACCESS_KEY   # 2단계 Secret Access Key
npx wrangler secret put CF_ACCOUNT_ID          # Dashboard 우상단 Account ID

npm run deploy
```

**확인**: `npx wrangler tail --format pretty`로 R2 싱크 로그 확인

### 비용 최적화

유휴 시 컨테이너를 슬립시켜 비용 절감 (70% 절감 가능).

**설정**
```bash
npx wrangler secret put SANDBOX_SLEEP_AFTER  # 입력: 10m (10분 유휴 후 슬립)
npm run deploy
```

**비용 비교**
- 24/7 상시: ~$34.50/월 (인프라) + AI API
- 하루 4시간: ~$10/월 (인프라) + AI API ← **70% 절감**

**주의**: 슬립 후 재접속 시 콜드 스타트(1-2분) 발생. `10m`, `30m`, `1h` 등 자유 설정 가능하며 언제든 변경 가능.

---

## 설정 자동화 (선택)

매번 시크릿을 하나씩 입력하기 번거롭다면 IaC(Infrastructure as Code)로 관리 가능.

### 디렉토리 구조

```
infra/
├── main.tf                  # Terraform: R2 버킷 생성
├── variables.tf             # Terraform 변수 선언
├── outputs.tf               # 출력값
├── terraform.tfvars         # 실제 값 (gitignored)
├── terraform.tfvars.example # 템플릿
├── secrets.env              # 시크릿 값 (gitignored)
├── secrets.env.example      # 시크릿 템플릿
└── deploy.sh                # 시크릿 일괄 등록 + 배포
```

### 파일 생성

#### `infra/main.tf`
```hcl
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
```

#### `infra/variables.tf`
```hcl
variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "cloudflare_account_id" {
  type = string
}
```

#### `infra/terraform.tfvars.example`
```hcl
cloudflare_api_token  = "your-api-token"
cloudflare_account_id = "your-account-id"
```

#### `infra/secrets.env.example`
```bash
# 필수: AI 제공자 (하나 이상)
CLOUDFLARE_AI_GATEWAY_API_KEY=
CF_AI_GATEWAY_ACCOUNT_ID=
CF_AI_GATEWAY_GATEWAY_ID=
CF_AI_GATEWAY_MODEL=google-ai-studio/gemini-2.5-flash
# ANTHROPIC_API_KEY=

# 필수: 인증
MOLTBOT_GATEWAY_TOKEN=
CF_ACCESS_TEAM_DOMAIN=
CF_ACCESS_AUD=

# R2 스토리지
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
CF_ACCOUNT_ID=

# 선택: 비용 최적화
SANDBOX_SLEEP_AFTER=10m
```

#### `infra/deploy.sh`
```bash
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
```

### 사용 방법

#### 최초 설정
```bash
# 1. 템플릿 복사
cd infra
cp terraform.tfvars.example terraform.tfvars
cp secrets.env.example secrets.env

# 2. 값 입력
vi terraform.tfvars  # cloudflare_api_token, cloudflare_account_id
vi secrets.env       # 모든 시크릿 값

# 3. 인프라 생성
terraform init
terraform apply

# 4. 시크릿 등록 + 배포
./deploy.sh
```

#### 시크릿 변경 시
```bash
vi infra/secrets.env    # 값 수정
./infra/deploy.sh       # 재등록 + 재배포
```

#### 인프라 변경 시
```bash
vi infra/terraform.tfvars
cd infra && terraform apply
```

### .gitignore 추가 완료
다음 항목이 이미 추가되어 있습니다:
```
infra/secrets.env
infra/terraform.tfvars
```

### 장점
- 모든 설정을 파일로 관리, 재현 가능
- 시크릿 일괄 등록으로 시간 절약 (20+ 시크릿 → 1번 실행)
- 다른 환경(개발/프로덕션) 복사 쉬움
- E2E 테스트에서 검증된 패턴 재활용

---

## 문제 해결

### "Missing Variables" 에러
```bash
# 시크릿 확인
npx wrangler secret list

# 필수 시크릿:
# - CLOUDFLARE_AI_GATEWAY_API_KEY + CF_AI_GATEWAY_ACCOUNT_ID + CF_AI_GATEWAY_GATEWAY_ID
# 또는 ANTHROPIC_API_KEY
# - MOLTBOT_GATEWAY_TOKEN
# - CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD
```

### "Unauthorized" 에러
```bash
# CF_ACCESS_TEAM_DOMAIN 확인
# Zero Trust → Settings → Custom Pages
# 형식: xxx.cloudflareaccess.com (https:// 제외)

# 재등록
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npm run deploy
```

### 로그 확인
```bash
npx wrangler tail --format pretty
```

---

## 예상 비용

| 시나리오 | 인프라 | AI | 합계 |
|---------|-------|-----|------|
| **절약 모드** (하루 4시간) | $10 | Gemini 무료 | **$10/월** |
| **24/7** + Gemini 무료 | $34.50 | $0-20 | **$35-55/월** |
| **24/7** + Claude Sonnet | $34.50 | $50-150 | **$85-185/월** |

---

## AI 제공자 비교

| 제공자 | 비용 | 무료 | 설정 |
|--------|------|------|------|
| **Gemini via AI Gateway** ⭐ | $0.15/$0.60 | 250 req/day | 시크릿 4개 |
| **Anthropic Claude** | $3/$15 (Sonnet) | 없음 | 시크릿 1개 |
| **OpenRouter** | 공식+5.5% | 50 req/day | 시크릿 1개 |

**추천**: Gemini (가성비) → 복잡한 작업만 Claude

---

## 참고

- 실험적 PoC, Cloudflare 공식 제품 아님
- 게이트웨이 토큰 키체인 조회: `security find-generic-password -s moltworker -a gateway-token -w`
- 로컬 개발: `.dev.vars`에 `DEV_MODE=true` 설정

상세 문서: [README.md](./README.md)
