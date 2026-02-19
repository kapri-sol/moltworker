# Moltworker 커스텀 설정 가이드

## 전체 구조

- **Phase 1:** upstream 리셋 + Google AI Studio gwProvider 지원 (API Key 방식)
- **Phase 2:** OAuth 로그인으로 구독 모델(ChatGPT Plus, Claude Pro) 사용

---

# Phase 1: Google AI Studio gwProvider 지원 추가

## Context

로컬 커스텀 변경을 모두 버리고 upstream 최신 코드(`6510afd`)로 리셋한 뒤, Google AI Studio를 AI Gateway를 통해 사용하기 위한 최소한의 패치만 적용한다.

upstream에는 `gwProvider`가 `anthropic`, `openai`, `workers-ai`만 처리됨. `google-ai-studio`/`google`을 추가해야 Google Gemini가 AI Gateway를 통해 작동한다.

## 1단계: upstream으로 리셋

```bash
# docs/ 폴더를 /tmp에 백업 (untracked라 git reset으로 날아감)
cp -r docs /tmp/docs-backup

# upstream으로 리셋
git reset --hard HEAD
git checkout upstream/main -- .

# docs 복원
cp -r /tmp/docs-backup docs
```

`.dev.vars`는 `.gitignore`에 포함되어 있으므로 git reset의 영향을 받지 않음 (자동 보존).

## 2단계: `start-openclaw.sh` 패치 (핵심)

upstream 파일의 AI Gateway model override 블록 (line 193~219)에 Google 처리 추가.

### 2-1. baseUrl: Google provider 이름 매핑 + `/v1beta` suffix

**upstream (line 195-196):**
```javascript
baseUrl = '...' + '/' + gwProvider;
if (gwProvider === 'workers-ai') baseUrl += '/v1';
```

**변경 후:**
```javascript
const urlProvider = (gwProvider === 'google') ? 'google-ai-studio' : gwProvider;
baseUrl = '...' + '/' + urlProvider;
if (gwProvider === 'workers-ai') baseUrl += '/v1';
else if (gwProvider === 'google-ai-studio' || gwProvider === 'google') baseUrl += '/v1beta';
```

- `google` → `google-ai-studio`로 URL 매핑 (AI Gateway 엔드포인트 이름)
- `/v1beta` suffix: Google v1 API는 `systemInstruction`, `tools` 필드 미지원

### 2-2. api: Google용 `google-generative-ai` 타입 추가

**upstream (line 202):**
```javascript
const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
```

**변경 후:**
```javascript
let api;
if (gwProvider === 'anthropic') api = 'anthropic-messages';
else if (gwProvider === 'google-ai-studio' || gwProvider === 'google') api = 'google-generative-ai';
else api = 'openai-completions';
```

- `openai-completions`는 OpenAI 전용 필드(`store`, `stream_options`)를 Google에 보내서 에러 발생
- `google-generative-ai`는 Google 네이티브 형식으로 정상 작동

### 2-3. onboard 실패 방지

**upstream (line 123):**
```bash
--skip-health
```

**변경 후:**
```bash
--skip-health || echo "Onboard failed or skipped, will use config patching"
```

`set -e` 환경에서 `openclaw onboard`가 실패하면 스크립트 전체가 중단됨. config 패칭 스크립트가 실행되지 않아 설정 파일이 생성되지 않음.

## 3단계: `src/gateway/env.ts` — Google 환경변수 전달

**upstream에 없는 항목 추가 (line 25 부근):**
```typescript
if (env.GOOGLE_API_KEY) envVars.GOOGLE_API_KEY = env.GOOGLE_API_KEY;
if (env.GOOGLE_MODEL) envVars.GOOGLE_MODEL = env.GOOGLE_MODEL;
```

직접 Google API 사용 시 (AI Gateway 없이) 필요한 환경변수.

## 4단계: `src/types.ts` — MoltbotEnv에 Google 타입 추가

**upstream에 없는 항목 추가 (`OPENAI_API_KEY` 아래):**
```typescript
GOOGLE_API_KEY?: string;
GOOGLE_MODEL?: string; // Default: gemini-2.5-flash
```

## 5단계: `start-openclaw.sh` — 직접 Google API 폴백 경로 추가

AI Gateway 없이 `GOOGLE_API_KEY`만 설정한 경우를 위한 폴백. upstream에는 이 블록이 없음.

**CF_AI_GATEWAY_MODEL 블록 닫는 `}` 바로 뒤에 추가:**
```javascript
// Direct Google API key (bypasses Cloudflare AI Gateway)
if (process.env.GOOGLE_API_KEY && !process.env.CF_AI_GATEWAY_MODEL) {
    const modelId = process.env.GOOGLE_MODEL || 'gemini-2.5-flash';
    const googleBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    config.models.providers['google-direct'] = {
        baseUrl: googleBaseUrl,
        apiKey: process.env.GOOGLE_API_KEY,
        api: 'google-generative-ai',
        models: [{ id: modelId, name: modelId, contextWindow: 1048576, maxTokens: 8192 }],
    };
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = { primary: 'google-direct/' + modelId };
    console.log('Direct Google API: model=' + modelId + ' via ' + googleBaseUrl);
}
```

## 변경 파일 요약

| 파일 | 변경 내용 |
|------|----------|
| `start-openclaw.sh` | gwProvider에 google 분기 추가 (3곳) + onboard 실패 방지 + 직접 Google API 폴백 |
| `src/gateway/env.ts` | GOOGLE_API_KEY, GOOGLE_MODEL 전달 (2줄) |
| `src/types.ts` | GOOGLE_API_KEY, GOOGLE_MODEL 타입 (2줄) |

## 환경변수 설정

> **참고:** `.dev.vars` 파일에 현재 설정된 시크릿 값이 있음. 프로덕션 시크릿은 `npx wrangler secret list`로 확인.

### AI Gateway 경유 (권장)
```bash
npx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID   # Cloudflare 계정 ID
npx wrangler secret put CF_AI_GATEWAY_GATEWAY_ID    # AI Gateway ID
npx wrangler secret put GOOGLE_API_KEY              # Google API 키
npx wrangler secret put CF_AI_GATEWAY_MODEL         # 값: google-ai-studio/gemini-2.0-flash
```

### 직접 Google API (AI Gateway 없이)
```bash
npx wrangler secret put GOOGLE_API_KEY
npx wrangler secret put GOOGLE_MODEL                # 선택, 기본값: gemini-2.5-flash
```

## Phase 1 검증

1. `npm run typecheck` — 타입 체크
2. `npm test` — 테스트 통과
3. `npm run deploy` — 배포
4. OpenClaw 채팅 테스트 → AI Gateway 대시보드 로그 확인

---

# Phase 2: OAuth 로그인으로 구독 모델 사용

## Context

ChatGPT Plus/Pro, Claude Pro 등 구독이 이미 있는 경우, API Key 방식은 추가 과금이 발생한다.
OAuth 인증으로 기존 구독을 활용하면 API 비용을 절약할 수 있다.

## 배경 리서치 결과

### OAuth 지원 현황

| Provider | OAuth 지원 | 인증 방식 | 참고 |
|----------|-----------|----------|------|
| **OpenAI (ChatGPT Plus/Pro)** | OpenClaw, OpenCode 모두 지원 | OAuth 2.0 PKCE + 자동 토큰 갱신 | 공식: https://developers.openai.com/codex/auth/ |
| **Anthropic (Claude Pro/Max)** | OpenCode에서 지원 (비공식) | 브라우저 인증 | Anthropic이 차단할 가능성 있음 |
| **Google Gemini** | OpenClaw에서 지원 | Google OAuth 플로우 | 번들 플러그인 (기본 비활성) |

### Headless 환경 해결 방법

Moltworker는 headless 컨테이너라 브라우저를 직접 열 수 없다. 두 가지 방법:

**방법 A — oauth.json 복사 (OpenClaw 공식 문서)**
1. 로컬에서 `openclaw onboard` → OAuth 로그인 (브라우저)
2. `~/.openclaw/credentials/oauth.json` 파일 생성됨
3. 이 파일을 moltworker에 업로드 (Admin UI 또는 R2)
4. 컨테이너 시작 시 자동 복원
5. OpenClaw이 refresh token으로 자동 갱신
- 참고: https://docs.openclaw.ai/concepts/oauth

**방법 B — Device Code Flow (OpenCode 방식)**
1. 서버(컨테이너)가 OpenAI에 device code 요청
2. Admin UI에 코드 + URL 표시
3. 사용자가 폰/노트북으로 URL 열고 코드 입력
4. 서버가 토큰 수신 → 저장 → 자동 갱신
- 참고: https://github.com/tumf/opencode-openai-device-auth

### 권장: 방법 A (oauth.json 복사)

구현이 간단하고, 기존 R2 백업 인프라를 그대로 활용 가능.

## 구현 계획

### 1. 로컬에서 OAuth 토큰 획득

```bash
# 로컬 머신에서 openclaw 설치 (한 번만)
npm install -g openclaw

# OAuth 로그인 — 브라우저가 열림
openclaw onboard --auth-choice openai-codex
# → ~/.openclaw/credentials/oauth.json 생성됨
```

### 2. `start-openclaw.sh` — R2에서 OAuth 토큰 복원

rclone 복원 블록(RESTORE FROM R2 섹션)에 credentials 복원 추가:

```bash
# Restore OAuth credentials
CRED_DIR="$CONFIG_DIR/credentials"
REMOTE_CRED_COUNT=$(rclone ls "r2:${R2_BUCKET}/openclaw/credentials/" $RCLONE_FLAGS 2>/dev/null | wc -l)
if [ "$REMOTE_CRED_COUNT" -gt 0 ]; then
    echo "Restoring OAuth credentials from R2..."
    mkdir -p "$CRED_DIR"
    rclone copy "r2:${R2_BUCKET}/openclaw/credentials/" "$CRED_DIR/" $RCLONE_FLAGS -v 2>&1
    echo "OAuth credentials restored"
fi
```

### 3. Admin UI — OAuth 토큰 업로드 기능

`src/routes/api.ts`에 엔드포인트 추가:

```
POST /api/oauth-credentials
Body: { provider: "openai", oauth_json: { ... } }
```

1. Worker가 받은 JSON을 R2에 `openclaw/credentials/oauth.json`으로 저장
2. 컨테이너 재시작 시 자동 복원

또는 더 간단하게: 기존 R2 sync가 `$CONFIG_DIR/` 전체를 동기화하므로,
컨테이너 안에서 `~/.openclaw/credentials/`에 파일이 생기면 자동으로 R2에 백업됨.

### 4. 토큰 갱신 흐름

```
컨테이너 시작 → R2에서 oauth.json 복원
    ↓
OpenClaw이 요청 시 access token 사용
    ↓
만료 5분 전 → refresh token으로 자동 갱신
    ↓
갱신된 토큰 → oauth.json에 저장
    ↓
배경 sync loop → R2에 자동 백업 (30초마다 체크)
```

## 주의사항

- **Anthropic OAuth는 비공식**: Anthropic이 "Claude Code 전용" 크레덴셜이라며 차단할 수 있음
- **OpenAI OAuth는 안정적**: OpenClaw, OpenCode 모두 공식 지원
- **refresh token 만료**: 장기간(수개월) 미사용 시 만료될 수 있음 → 재인증 필요
- **Phase 1 (API Key)과 병행 가능**: Gemini는 API Key(무료), ChatGPT는 OAuth(구독)

## Phase 2 검증

1. 로컬에서 `openclaw onboard --auth-choice openai-codex` 실행
2. `~/.openclaw/credentials/oauth.json` 확인
3. R2에 업로드: `rclone copy ~/.openclaw/credentials/ r2:moltbot-data/openclaw/credentials/`
4. 배포 후 컨테이너 재시작
5. ChatGPT 모델로 채팅 테스트
6. AI Gateway 대시보드 확인 (OAuth 경유 시 Gateway 로그가 안 남을 수 있음 — 직접 연결)

---

# Phase 3: 다중 Provider 관리 + Admin UI 전환 + OAuth 로그인

## Phase 3a: 다중 Provider 동시 설정

### Context

`start-openclaw.sh`의 Node.js 패칭 스크립트가 provider를 if/else 배타적으로 설정.
`CF_AI_GATEWAY_MODEL`이 있으면 `GOOGLE_API_KEY` provider 무시됨.
모든 가용 provider를 동시 등록하고, Admin UI에서 기본 모델을 전환할 수 있게 개선.

### 변경 내용

| 파일 | 변경 |
|------|------|
| `start-openclaw.sh` | if/else 배타적 구조 제거, 다중 provider 동시 설정, `.user-default-model` 파일로 사용자 선택 보존 |
| `src/routes/api.ts` | `GET /api/admin/provider`, `POST /api/admin/provider/default` 추가 |
| `src/client/api.ts` | `getProviderStatus()`, `updateDefaultModel()` 함수 추가 |
| `src/client/pages/AdminPage.tsx` | "AI Provider" 섹션 추가 (라디오 버튼 + Apply & Restart) |
| `src/client/pages/AdminPage.css` | Provider 섹션 스타일 추가 |

### 참고

- API 함수명 `updateDefaultModel` 사용 (`setDefaultModel`은 React useState setter와 충돌)
- Admin UI(`/_admin`)에서 접속

---

## Phase 3b: Admin UI에서 OAuth 로그인 (OpenAI + Anthropic)

### Context

현재 OAuth 크레덴셜은 로컬에서 `openclaw onboard` 실행 후 파일을 수동 업로드해야 함.
Admin UI 웹페이지에서 직접 OAuth 인증을 할 수 있도록 개선.

OpenCode 리포지토리(`github.com/anomalyco/opencode`) 분석 결과:

| Provider | 인증 방식 | Client ID |
|----------|----------|-----------|
| **OpenAI** | Device Code Flow | `app_EMoamEEZ73f0CkXaXp7hrann` |
| **Anthropic** | Code Paste Flow (PKCE) | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |

### OpenAI Device Code Flow

1. POST `auth.openai.com/api/accounts/deviceauth/usercode` → `device_auth_id` + `user_code`
2. 사용자가 `auth.openai.com/codex/device`에서 코드 입력
3. Poll `auth.openai.com/api/accounts/deviceauth/token` → `authorization_code` + `code_verifier`
4. Exchange at `auth.openai.com/oauth/token` → `access_token` + `refresh_token`

### Anthropic Code Flow

1. Worker에서 PKCE 생성 (Web Crypto API), 컨테이너에 `code_verifier` 저장
2. 사용자가 `console.anthropic.com/oauth/authorize`에서 인증 → 코드 표시
3. 사용자가 코드 복사 → Admin UI에 붙여넣기
4. Exchange at `console.anthropic.com/v1/oauth/token` → 토큰 저장
5. `api.anthropic.com/api/oauth/claude_cli/create_api_key`로 API key 생성

### API 엔드포인트 (`src/routes/oauth.ts` — 신규)

| 엔드포인트 | 동작 |
|-----------|------|
| `GET /api/admin/oauth/status` | 각 provider 연결 상태 반환 |
| `POST /api/admin/oauth/openai/start` | Device Code 요청 → user_code 반환 |
| `POST /api/admin/oauth/openai/poll` | 인증 완료 폴링 → 완료 시 토큰 교환 + 저장 |
| `POST /api/admin/oauth/anthropic/start` | PKCE 생성 + 인증 URL 반환 |
| `POST /api/admin/oauth/anthropic/exchange` | 코드로 토큰 교환 |
| `DELETE /api/admin/oauth/:provider` | 크레덴셜 삭제 + R2 sync |

외부 API 호출은 `sandbox.exec('curl ...')` 사용 (컨테이너에서 outgoing HTTP).

### OAuth 유틸리티 (`src/gateway/oauth.ts` — 신규)

- `generatePKCE()`: Web Crypto API로 code_verifier + code_challenge 생성
- `readOAuthCredentials()` / `writeOAuthCredentials()`: `/root/.openclaw/credentials/oauth.json` 관리
- `writePendingState()` / `readPendingState()`: `/tmp/.oauth-pending-{provider}.json`로 진행 중 상태 관리

### Admin UI (`src/client/pages/AdminPage.tsx`)

기존 "OAuth Credentials" 파일 업로드 섹션을 "OAuth Login" 섹션으로 대체:

**미연결 상태:**
```
┌──────────────────────┐ ┌──────────────────────┐
│ OpenAI               │ │ Anthropic            │
│ ○ Not connected      │ │ ○ Not connected      │
│ [Login with OpenAI]  │ │ [Login with Claude]  │
└──────────────────────┘ └──────────────────────┘
```

**OpenAI 인증 진행 시:** 코드 표시 + "Waiting..." 스피너
**Anthropic 인증 진행 시:** 코드 입력 필드 + "Submit Code" 버튼
**연결 완료:** "Connected" 뱃지 + "Logout" 버튼

기존 파일 업로드는 "Advanced: Manual Upload" 접이식 섹션으로 유지.

### 보안

- access_token/refresh_token은 브라우저에 반환하지 않음 (연결 상태만)
- PKCE code_verifier는 컨테이너 `/tmp/`에만 저장
- 모든 엔드포인트 Cloudflare Access JWT 보호

### 변경 파일 요약

| 파일 | 변경 |
|------|------|
| `src/gateway/oauth.ts` | **신규** — PKCE, 크레덴셜 관리 유틸 |
| `src/routes/oauth.ts` | **신규** — OAuth API 엔드포인트 6개 |
| `src/routes/api.ts` | oauth 라우터 마운트 (2줄) |
| `src/client/api.ts` | OAuth 클라이언트 API 함수 6개 |
| `src/client/pages/AdminPage.tsx` | OAuth Login 섹션 |
| `src/client/pages/AdminPage.css` | OAuth 스타일 |

### Phase 3b 검증

1. `npm run typecheck` + `npm test`
2. 배포 후 Admin UI(`/_admin`)에서:
   - OpenAI: "Login" → 코드 표시 → `auth.openai.com/codex/device`에서 입력 → Connected
   - Anthropic: "Login" → 브라우저 탭 열림 → 코드 복사/붙여넣기 → Connected
   - Logout → 크레덴셜 삭제 확인
   - 컨테이너 재시작 후 R2에서 복원 확인
