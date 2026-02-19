#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Restores config/workspace/skills from R2 via rclone (if configured)
# 2. Runs openclaw onboard --non-interactive to configure from env vars
# 3. Patches config for features onboard doesn't cover (channels, gateway auth)
# 4. Starts a background sync loop (rclone, watches for file changes)
# 5. Starts the gateway

set -e

if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "OpenClaw gateway is already running, exiting."
    exit 0
fi

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
WORKSPACE_DIR="/root/clawd"
SKILLS_DIR="/root/clawd/skills"
RCLONE_CONF="/root/.config/rclone/rclone.conf"
LAST_SYNC_FILE="/tmp/.last-sync"

echo "Config directory: $CONFIG_DIR"

mkdir -p "$CONFIG_DIR"

# ============================================================
# RCLONE SETUP
# ============================================================

r2_configured() {
    [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ] && [ -n "$CF_ACCOUNT_ID" ]
}

R2_BUCKET="${R2_BUCKET_NAME:-moltbot-data}"

setup_rclone() {
    mkdir -p "$(dirname "$RCLONE_CONF")"
    cat > "$RCLONE_CONF" << EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_ACCESS_KEY_ID
secret_access_key = $R2_SECRET_ACCESS_KEY
endpoint = https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
    touch /tmp/.rclone-configured
    echo "Rclone configured for bucket: $R2_BUCKET"
}

RCLONE_FLAGS="--transfers=16 --fast-list --s3-no-check-bucket"

# ============================================================
# RESTORE FROM R2
# ============================================================

if r2_configured; then
    setup_rclone

    echo "Checking R2 for existing backup..."
    # Check if R2 has an openclaw config backup
    if rclone ls "r2:${R2_BUCKET}/openclaw/openclaw.json" $RCLONE_FLAGS 2>/dev/null | grep -q openclaw.json; then
        echo "Restoring config from R2..."
        rclone copy "r2:${R2_BUCKET}/openclaw/" "$CONFIG_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: config restore failed with exit code $?"
        echo "Config restored"
    elif rclone ls "r2:${R2_BUCKET}/clawdbot/clawdbot.json" $RCLONE_FLAGS 2>/dev/null | grep -q clawdbot.json; then
        echo "Restoring from legacy R2 backup..."
        rclone copy "r2:${R2_BUCKET}/clawdbot/" "$CONFIG_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: legacy config restore failed with exit code $?"
        if [ -f "$CONFIG_DIR/clawdbot.json" ] && [ ! -f "$CONFIG_FILE" ]; then
            mv "$CONFIG_DIR/clawdbot.json" "$CONFIG_FILE"
        fi
        echo "Legacy config restored and migrated"
    else
        echo "No backup found in R2, starting fresh"
    fi

    # Restore workspace
    REMOTE_WS_COUNT=$(rclone ls "r2:${R2_BUCKET}/workspace/" $RCLONE_FLAGS 2>/dev/null | wc -l)
    if [ "$REMOTE_WS_COUNT" -gt 0 ]; then
        echo "Restoring workspace from R2 ($REMOTE_WS_COUNT files)..."
        mkdir -p "$WORKSPACE_DIR"
        rclone copy "r2:${R2_BUCKET}/workspace/" "$WORKSPACE_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: workspace restore failed with exit code $?"
        echo "Workspace restored"
    fi

    # Restore skills
    REMOTE_SK_COUNT=$(rclone ls "r2:${R2_BUCKET}/skills/" $RCLONE_FLAGS 2>/dev/null | wc -l)
    if [ "$REMOTE_SK_COUNT" -gt 0 ]; then
        echo "Restoring skills from R2 ($REMOTE_SK_COUNT files)..."
        mkdir -p "$SKILLS_DIR"
        rclone copy "r2:${R2_BUCKET}/skills/" "$SKILLS_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: skills restore failed with exit code $?"
        echo "Skills restored"
    fi
else
    echo "R2 not configured, starting fresh"
fi

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    AUTH_ARGS=""
    if [ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && [ -n "$CF_AI_GATEWAY_ACCOUNT_ID" ] && [ -n "$CF_AI_GATEWAY_GATEWAY_ID" ]; then
        AUTH_ARGS="--auth-choice cloudflare-ai-gateway-api-key \
            --cloudflare-ai-gateway-account-id $CF_AI_GATEWAY_ACCOUNT_ID \
            --cloudflare-ai-gateway-gateway-id $CF_AI_GATEWAY_GATEWAY_ID \
            --cloudflare-ai-gateway-api-key $CLOUDFLARE_AI_GATEWAY_API_KEY"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        AUTH_ARGS="--auth-choice apiKey --anthropic-api-key $ANTHROPIC_API_KEY"
    elif [ -n "$OPENAI_API_KEY" ]; then
        AUTH_ARGS="--auth-choice openai-api-key --openai-api-key $OPENAI_API_KEY"
    fi

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        $AUTH_ARGS \
        --gateway-port 18789 \
        --gateway-bind lan \
        --skip-channels \
        --skip-skills \
        --skip-health || echo "Onboard failed or skipped, will use config patching"

    echo "Onboard completed or skipped"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, trusted proxies)
# ============================================================
# openclaw onboard handles provider/model config, but we need to patch in:
# - Channel config (Telegram, Discord, Slack)
# - Gateway token auth
# - Trusted proxies for sandbox networking
# - Base URL override for legacy AI Gateway path
node << 'EOFPATCH'
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Patching config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// Legacy AI Gateway base URL override:
// ANTHROPIC_BASE_URL is picked up natively by the Anthropic SDK,
// so we don't need to patch the provider config. Writing a provider
// entry without a models array breaks OpenClaw's config validation.

// Initialize config structure for providers
config.models = config.models || {};
config.models.providers = config.models.providers || {};

// Track first available provider for fallback default
let firstProvider = null;

// AI Gateway model override (CF_AI_GATEWAY_MODEL=provider/model-id)
// Adds a provider entry for any AI Gateway provider.
// Examples:
//   workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
//   openai/gpt-4o
//   anthropic/claude-sonnet-4-5
//   google-ai-studio/gemini-2.5-flash
if (process.env.CF_AI_GATEWAY_MODEL) {
    const raw = process.env.CF_AI_GATEWAY_MODEL;
    const slashIdx = raw.indexOf('/');
    const gwProvider = raw.substring(0, slashIdx);
    const modelId = raw.substring(slashIdx + 1);

    const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
    const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
    const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

    let baseUrl;
    if (accountId && gatewayId) {
        const urlProvider = (gwProvider === 'google') ? 'google-ai-studio' : gwProvider;
        baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + urlProvider;
        if (gwProvider === 'workers-ai') baseUrl += '/v1';
        else if (gwProvider === 'google-ai-studio' || gwProvider === 'google') baseUrl += '/v1beta';
    } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
        baseUrl = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID + '/ai/v1';
    }

    if (baseUrl && apiKey) {
        let api;
        if (gwProvider === 'anthropic') api = 'anthropic-messages';
        else if (gwProvider === 'google-ai-studio' || gwProvider === 'google') api = 'google-generative-ai';
        else api = 'openai-completions';
        const providerName = 'cf-ai-gw-' + gwProvider;

        config.models.providers[providerName] = {
            baseUrl: baseUrl,
            apiKey: apiKey,
            api: api,
            models: [{ id: modelId, name: modelId, contextWindow: 131072, maxTokens: 8192 }],
        };
        firstProvider = firstProvider || (providerName + '/' + modelId);
        console.log('AI Gateway provider registered: ' + providerName + '/' + modelId + ' via ' + baseUrl);
    } else {
        console.warn('CF_AI_GATEWAY_MODEL set but missing required config (account ID, gateway ID, or API key)');
    }
}

// Direct Google API key (bypasses Cloudflare AI Gateway)
// NOTE: Removed exclusive condition - this can coexist with CF_AI_GATEWAY_MODEL
if (process.env.GOOGLE_API_KEY) {
    const modelId = process.env.GOOGLE_MODEL || 'gemini-2.5-flash';
    const googleBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    config.models.providers['google-direct'] = {
        baseUrl: googleBaseUrl,
        apiKey: process.env.GOOGLE_API_KEY,
        api: 'google-generative-ai',
        models: [{ id: modelId, name: modelId, contextWindow: 1048576, maxTokens: 8192 }],
    };
    firstProvider = firstProvider || ('google-direct/' + modelId);
    console.log('Direct Google API provider registered: google-direct/' + modelId + ' via ' + googleBaseUrl);
}

// Direct Anthropic API key
if (process.env.ANTHROPIC_API_KEY) {
    const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    config.models.providers['anthropic-direct'] = {
        baseUrl: baseUrl,
        apiKey: process.env.ANTHROPIC_API_KEY,
        api: 'anthropic-messages',
        models: [
            { id: 'claude-sonnet-4-5-20250514', name: 'claude-sonnet-4-5-20250514', contextWindow: 200000, maxTokens: 8192 },
        ],
    };
    firstProvider = firstProvider || ('anthropic-direct/claude-sonnet-4-5-20250514');
    console.log('Direct Anthropic provider registered: anthropic-direct/claude-sonnet-4-5-20250514 via ' + baseUrl);
}

// Direct OpenAI API key
if (process.env.OPENAI_API_KEY) {
    config.models.providers['openai-direct'] = {
        apiKey: process.env.OPENAI_API_KEY,
        api: 'openai-completions',
        models: [
            { id: 'gpt-4o', name: 'gpt-4o', contextWindow: 128000, maxTokens: 16384 },
        ],
    };
    firstProvider = firstProvider || ('openai-direct/gpt-4o');
    console.log('Direct OpenAI provider registered: openai-direct/gpt-4o');
}

// OAuth credentials (from Admin UI OAuth login)
try {
    const oauthPath = '/root/.openclaw/credentials/oauth.json';
    const oauth = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));

    // Build base URLs — route through CF AI Gateway if configured
    var oauthOpenaiBaseUrl = 'https://api.openai.com/v1';
    var oauthAnthropicBaseUrl = 'https://api.anthropic.com';
    if (process.env.CF_AI_GATEWAY_ACCOUNT_ID && process.env.CF_AI_GATEWAY_GATEWAY_ID) {
        var oauthGwBase = 'https://gateway.ai.cloudflare.com/v1/'
            + process.env.CF_AI_GATEWAY_ACCOUNT_ID + '/'
            + process.env.CF_AI_GATEWAY_GATEWAY_ID;
        oauthOpenaiBaseUrl = oauthGwBase + '/openai';
        oauthAnthropicBaseUrl = oauthGwBase + '/anthropic';
        console.log('OAuth providers will route through CF AI Gateway:', oauthGwBase);
    }

    if (oauth.openai && oauth.openai.access_token) {
        config.models.providers['openai-oauth'] = {
            baseUrl: oauthOpenaiBaseUrl,
            api: 'openai-completions',
            apiKey: oauth.openai.api_key || oauth.openai.access_token,
            models: [
                // GPT-5 series (latest)
                { id: 'gpt-5.2', name: 'gpt-5.2 (thinking)', contextWindow: 200000, maxTokens: 16384 },
                { id: 'gpt-5.2-chat-latest', name: 'gpt-5.2 instant', contextWindow: 200000, maxTokens: 16384 },
                { id: 'gpt-5.2-codex', name: 'gpt-5.2-codex (coding)', contextWindow: 200000, maxTokens: 16384 },
                // GPT-4 series (keep 4.1 for long context, 4o for multimodal)
                { id: 'gpt-4.1', name: 'gpt-4.1 (1M context)', contextWindow: 1000000, maxTokens: 32768 },
                { id: 'gpt-4o', name: 'gpt-4o (vision)', contextWindow: 128000, maxTokens: 16384 },
                // o-series reasoning models (keep latest variants only)
                { id: 'o4-mini', name: 'o4-mini (fast reasoning)', contextWindow: 200000, maxTokens: 100000 },
                { id: 'o3-pro', name: 'o3-pro (deep reasoning)', contextWindow: 200000, maxTokens: 100000 },
                { id: 'o4-mini-deep-research', name: 'o4-mini deep research', contextWindow: 200000, maxTokens: 100000 },
            ],
        };
        firstProvider = firstProvider || ('openai-oauth/gpt-4o');
        console.log('OpenAI OAuth provider registered: openai-oauth/gpt-4o');
    }
    if (oauth.anthropic) {
        var anthropicKey = oauth.anthropic.api_key || oauth.anthropic.access_token;
        if (anthropicKey) {
            config.models.providers['anthropic-oauth'] = {
                baseUrl: oauthAnthropicBaseUrl,
                apiKey: anthropicKey,
                api: 'anthropic-messages',
                models: [
                    { id: 'claude-sonnet-4-5-20250514', name: 'claude-sonnet-4-5-20250514', contextWindow: 200000, maxTokens: 8192 },
                ],
            };
            firstProvider = firstProvider || ('anthropic-oauth/claude-sonnet-4-5-20250514');
            console.log('Anthropic OAuth provider registered: anthropic-oauth/claude-sonnet-4-5-20250514');
        }
    }
} catch (e) {
    // No OAuth credentials file, skip
}

// Set default model: user preference > first available provider
const userDefaultFile = '/root/.openclaw/.user-default-model';
let defaultModel = null;
try {
    defaultModel = fs.readFileSync(userDefaultFile, 'utf8').trim();
    if (defaultModel) {
        console.log('Using user-selected default model: ' + defaultModel);
    }
} catch (e) {
    // File doesn't exist, will use firstProvider
}

if (!defaultModel && firstProvider) {
    defaultModel = firstProvider;
    console.log('Using first available provider as default: ' + defaultModel);
}

if (defaultModel) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = { primary: defaultModel };
}

// Telegram configuration
// Overwrite entire channel object to drop stale keys from old R2 backups
// that would fail OpenClaw's strict config validation (see #47)
if (process.env.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    config.channels.telegram = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        enabled: true,
        dmPolicy: dmPolicy,
    };
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open') {
        config.channels.telegram.allowFrom = ['*'];
    }
}

// Discord configuration
// Discord uses a nested dm object: dm.policy, dm.allowFrom (per DiscordDmConfig)
if (process.env.DISCORD_BOT_TOKEN) {
    const dmPolicy = process.env.DISCORD_DM_POLICY || 'pairing';
    const dm = { policy: dmPolicy };
    if (dmPolicy === 'open') {
        dm.allowFrom = ['*'];
    }
    config.channels.discord = {
        token: process.env.DISCORD_BOT_TOKEN,
        enabled: true,
        dm: dm,
    };
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
    };
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# BACKGROUND SYNC LOOP
# ============================================================
if r2_configured; then
    echo "Starting background R2 sync loop..."
    (
        MARKER=/tmp/.last-sync-marker
        LOGFILE=/tmp/r2-sync.log
        touch "$MARKER"

        while true; do
            sleep 30

            CHANGED=/tmp/.changed-files
            {
                find "$CONFIG_DIR" -newer "$MARKER" -type f -printf '%P\n' 2>/dev/null
                find "$WORKSPACE_DIR" -newer "$MARKER" \
                    -not -path '*/node_modules/*' \
                    -not -path '*/.git/*' \
                    -type f -printf '%P\n' 2>/dev/null
            } > "$CHANGED"

            COUNT=$(wc -l < "$CHANGED" 2>/dev/null || echo 0)

            if [ "$COUNT" -gt 0 ]; then
                echo "[sync] Uploading changes ($COUNT files) at $(date)" >> "$LOGFILE"
                rclone sync "$CONFIG_DIR/" "r2:${R2_BUCKET}/openclaw/" \
                    $RCLONE_FLAGS --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' --exclude='.git/**' 2>> "$LOGFILE"
                if [ -d "$WORKSPACE_DIR" ]; then
                    rclone sync "$WORKSPACE_DIR/" "r2:${R2_BUCKET}/workspace/" \
                        $RCLONE_FLAGS --exclude='skills/**' --exclude='.git/**' --exclude='node_modules/**' 2>> "$LOGFILE"
                fi
                if [ -d "$SKILLS_DIR" ]; then
                    rclone sync "$SKILLS_DIR/" "r2:${R2_BUCKET}/skills/" \
                        $RCLONE_FLAGS 2>> "$LOGFILE"
                fi
                date -Iseconds > "$LAST_SYNC_FILE"
                touch "$MARKER"
                echo "[sync] Complete at $(date)" >> "$LOGFILE"
            fi
        done
    ) &
    echo "Background sync loop started (PID: $!)"
fi

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"

rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan --token "$OPENCLAW_GATEWAY_TOKEN"
else
    echo "Starting gateway with device pairing (no token)..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan
fi
