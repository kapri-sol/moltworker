# Troubleshooting Guide (문제 해결 가이드)

## OpenClaw 초기화 실패 문제

### 증상
- 브라우저에서 페이지는 로드되지만 채팅 메시지 전송 시 "..." 무한 반복
- WebSocket 연결은 성공 (101 Switching Protocols)하지만 즉시 종료 (Error 1006)
- 로그에 "no config file found" 에러

### 근본 원인

**문제 1: `start-openclaw.sh`의 `set -e`**

`start-openclaw.sh` 스크립트의 9번 라인에 `set -e`가 설정되어 있어, 어떤 명령이든 실패하면 스크립트가 즉시 종료됩니다.

```bash
set -e  # 명령 실패 시 스크립트 종료
```

**문제 2: `openclaw onboard` 실패**

Lines 128-146에서 Cloudflare AI Gateway 인증으로 onboard를 시도하지만 실패:

```bash
AUTH_ARGS="--auth-choice cloudflare-ai-gateway-api-key ..."
openclaw onboard --non-interactive --accept-risk \
    --mode local \
    $AUTH_ARGS \
    ...
```

OpenClaw가 `cloudflare-ai-gateway-api-key` auth-choice를 인식하지 못해 onboard 실패 → `set -e`로 인해 스크립트 종료 → Lines 161-285의 Node.js 패칭 스크립트가 실행되지 않음 → 설정 파일 미생성

**문제 3: 연쇄적인 배포로 인한 초기화 중단**

시크릿 업데이트할 때마다 Durable Object가 리셋되어 컨테이너가 재시작되면서 OpenClaw 초기화가 중단됨.

### 해결 방법

**1. `openclaw onboard` 실패 시에도 계속 진행하도록 수정**

`start-openclaw.sh` Line 139-147 수정:

```bash
# Before:
openclaw onboard --non-interactive --accept-risk \
    --mode local \
    $AUTH_ARGS \
    ...
echo "Onboard completed"

# After:
openclaw onboard --non-interactive --accept-risk \
    --mode local \
    $AUTH_ARGS \
    ... || echo "Onboard failed or skipped, will use config patching"
echo "Onboard completed or skipped"
```

**2. ANTHROPIC_API_KEY 더미 값 설정**

OpenClaw onboard가 실패해도 괜찮지만, 혹시 모를 경우를 대비해 더미 값 설정:

```bash
echo "sk-ant-dummy-key-for-onboard-only" | npx wrangler secret put ANTHROPIC_API_KEY
```

**3. Node.js 패칭 스크립트가 실제 AI Provider 설정**

Lines 203-240의 CF_AI_GATEWAY_MODEL 로직이 실제 Gemini 설정을 생성:

```javascript
// CF_AI_GATEWAY_MODEL=google-ai-studio/gemini-2.5-flash
const gwProvider = 'google-ai-studio';
const modelId = 'gemini-2.5-flash';
const baseUrl = 'https://gateway.ai.cloudflare.com/v1/...';
// Provider 설정 생성 및 기본 모델로 지정
```

### 필수 환경 변수

**Cloudflare AI Gateway (Gemini) 사용 시:**

```bash
CLOUDFLARE_AI_GATEWAY_API_KEY=<your-gemini-api-key>
CF_AI_GATEWAY_ACCOUNT_ID=<your-cloudflare-account-id>
CF_AI_GATEWAY_GATEWAY_ID=<your-gateway-id>
CF_AI_GATEWAY_MODEL=google-ai-studio/gemini-2.5-flash
MOLTBOT_GATEWAY_TOKEN=<your-gateway-token>
```

**로컬 개발:**
- `.dev.vars` 파일에 위 값들 설정
- `DEV_MODE=true` 추가 (Cloudflare Access 인증 건너뛰기)

**프로덕션:**
- `npx wrangler secret put <KEY>` 명령으로 각 시크릿 등록

### 디버깅 팁

**1. 로그 확인:**
```bash
npx wrangler tail --format pretty
```

**2. 배포 상태 확인:**
```bash
npx wrangler deployments list
```

**3. 시크릿 목록 확인:**
```bash
npx wrangler secret list
```

**4. WebSocket 연결 오류 (1006)가 발생하면:**
- OpenClaw 설정 파일이 생성되었는지 확인
- 로그에서 "no config file found" 확인
- start-openclaw.sh의 onboard 실패 메시지 확인

**5. "Missing Variables" 오류가 발생하면:**
- `.dev.vars` (로컬) 또는 wrangler secrets (프로덕션) 확인
- 배포 후 30초 정도 대기 (시크릿 전파 시간)

### 주의사항

**시크릿 업데이트 후 안정화 대기:**
- 시크릿 업데이트 후 즉시 테스트하면 Durable Object 리셋으로 실패 가능
- 배포 후 1-2분 대기하여 컨테이너가 안정화되도록 함

**Gemini 모델 이름 형식:**
- `CF_AI_GATEWAY_MODEL`은 `provider/model-id` 형식 필수
- 예: `google-ai-studio/gemini-2.5-flash`
- 예: `anthropic/claude-sonnet-4-5`
- 예: `openai/gpt-4o`

**사용 가능한 Gemini 모델:**
```bash
source ~/.zshrc
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" \
  | jq -r '.models[] | select(.name | contains("gemini")) | .name'
```

일반적인 모델:
- `models/gemini-2.5-flash` (빠르고 효율적)
- `models/gemini-2.5-pro` (더 강력함)
- `models/gemini-2.0-flash` (이전 버전)

### 성공 확인

배포 후 정상 작동 확인:

1. ✅ 브라우저에서 페이지 로드
2. ✅ "Waiting for Moltworker to load" 후 채팅 UI 표시
3. ✅ 메시지 전송 시 AI 응답 수신
4. ✅ 로그에 "no config file found" 없음
5. ✅ WebSocket 연결 안정적 유지

### 참고

- 원본 이슈 해결 날짜: 2026-02-08
- OpenClaw 버전: 2026.2.3
- Cloudflare Workers Container 사용
