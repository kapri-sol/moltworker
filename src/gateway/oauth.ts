import type { Sandbox } from '@cloudflare/sandbox';

/**
 * OAuth credentials stored in /root/.openclaw/credentials/oauth.json
 */
export interface OAuthCredentials {
  openai?: {
    access_token: string;    // OAuth session JWT (not for API calls)
    refresh_token: string;
    id_token: string;        // RFC 8693 교환에 필요
    api_key: string;         // 실제 API key (RFC 8693 교환 결과)
    token_type: string;
    expires_at?: number;
    obtained_at: number;
  };
  anthropic?: {
    access_token: string;
    refresh_token: string;
    api_key?: string;
    token_type: string;
    expires_at?: number;
    obtained_at: number;
  };
}

/**
 * OpenAI PKCE authorization code flow pending state
 */
export interface OpenAIPendingState {
  code_verifier: string;
  code_challenge: string;
  state: string;
  started_at: number;
}

/**
 * Anthropic PKCE flow pending state
 */
export interface AnthropicPendingState {
  code_verifier: string;
  code_challenge: string;
  state: string;
  started_at: number;
}

/**
 * Generate PKCE code verifier and challenge (S256)
 * Uses Web Crypto API (available in Workers)
 */
export async function generatePKCE(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  // Generate random verifier (43-128 chars, base64url)
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const codeVerifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  // Generate challenge: SHA-256(verifier) -> base64url
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return { codeVerifier, codeChallenge };
}

/**
 * Generate random state parameter
 */
export function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * RFC 8693 token exchange: id_token → OpenAI API key
 * Mirrors Codex CLI's obtain_api_key function
 */
export async function exchangeForApiKey(sandbox: Sandbox, idToken: string): Promise<string> {
  const cmd = `curl -s -X POST 'https://auth.openai.com/oauth/token' \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange&subject_token=${idToken}&subject_token_type=urn:ietf:params:oauth:token-type:id_token&requested_token=openai-api-key&client_id=app_EMoamEEZ73f0CkXaXp7hrann' \
    --max-time 15`;

  const result = await sandbox.exec(cmd);
  const stdout = result.stdout?.trim();
  if (!stdout) throw new Error('Empty response from token exchange');

  const response = JSON.parse(stdout) as { access_token?: string };
  if (!response.access_token) {
    throw new Error(`Token exchange failed: ${stdout.substring(0, 200)}`);
  }
  return response.access_token;
}

/**
 * Read OAuth credentials from container
 */
export async function readOAuthCredentials(sandbox: Sandbox): Promise<OAuthCredentials> {
  try {
    const result = await sandbox.exec('cat /root/.openclaw/credentials/oauth.json 2>/dev/null || echo "{}"');
    const stdout = result.stdout?.trim() || '{}';
    return JSON.parse(stdout) as OAuthCredentials;
  } catch {
    return {};
  }
}

/**
 * Write OAuth credentials to container
 */
export async function writeOAuthCredentials(
  sandbox: Sandbox,
  credentials: OAuthCredentials,
): Promise<void> {
  // Ensure directory exists
  await sandbox.exec('mkdir -p /root/.openclaw/credentials');

  // Write credentials file
  const content = JSON.stringify(credentials, null, 2);
  await sandbox.writeFile('/root/.openclaw/credentials/oauth.json', content);
}

/**
 * Remove specific provider credentials
 */
export async function removeProviderCredentials(
  sandbox: Sandbox,
  provider: 'openai' | 'anthropic',
): Promise<void> {
  const credentials = await readOAuthCredentials(sandbox);
  delete credentials[provider];
  await writeOAuthCredentials(sandbox, credentials);
}

/**
 * Write pending OAuth flow state to temp file
 */
export async function writePendingState(
  sandbox: Sandbox,
  provider: string,
  state: object,
): Promise<void> {
  const content = JSON.stringify(state);
  await sandbox.writeFile(`/tmp/.oauth-pending-${provider}.json`, content);
}

/**
 * Read pending OAuth flow state from temp file
 */
export async function readPendingState(
  sandbox: Sandbox,
  provider: string,
): Promise<object | null> {
  try {
    const result = await sandbox.exec(`cat /tmp/.oauth-pending-${provider}.json 2>/dev/null || echo ""`);
    const stdout = result.stdout?.trim();
    if (!stdout) return null;
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Clear pending OAuth flow state
 */
export async function clearPendingState(sandbox: Sandbox, provider: string): Promise<void> {
  await sandbox.exec(`rm -f /tmp/.oauth-pending-${provider}.json 2>/dev/null || true`);
}

/**
 * Add OAuth provider entry to openclaw.json
 * This ensures the provider is available immediately after OAuth login
 */
export async function patchOAuthProviderConfig(
  sandbox: Sandbox,
  provider: 'openai' | 'anthropic',
  credentials: OAuthCredentials,
  gatewayConfig?: { accountId: string; gatewayId: string },
): Promise<void> {
  // Read current config
  const result = await sandbox.exec('cat /root/.openclaw/openclaw.json 2>/dev/null || echo "{}"');
  const config = JSON.parse(result.stdout?.trim() || '{}');

  // Ensure structure exists
  config.models = config.models || {};
  config.models.providers = config.models.providers || {};

  // Build base URL — route through CF AI Gateway if configured
  const gwBase = gatewayConfig
    ? `https://gateway.ai.cloudflare.com/v1/${gatewayConfig.accountId}/${gatewayConfig.gatewayId}`
    : null;

  if (provider === 'openai' && credentials.openai?.access_token) {
    const baseUrl = gwBase ? `${gwBase}/openai` : 'https://api.openai.com/v1';
    config.models.providers['openai-oauth'] = {
      baseUrl,
      api: 'openai-completions',
      apiKey: credentials.openai.api_key || credentials.openai.access_token,
      models: [
        // GPT-5 series (latest)
        { id: 'gpt-5.2', name: 'gpt-5.2 (thinking)', contextWindow: 200000, maxTokens: 16384 },
        {
          id: 'gpt-5.2-chat-latest',
          name: 'gpt-5.2 instant',
          contextWindow: 200000,
          maxTokens: 16384,
        },
        {
          id: 'gpt-5.2-codex',
          name: 'gpt-5.2-codex (coding)',
          contextWindow: 200000,
          maxTokens: 16384,
        },
        // GPT-4 series (keep 4.1 for long context, 4o for multimodal)
        { id: 'gpt-4.1', name: 'gpt-4.1 (1M context)', contextWindow: 1000000, maxTokens: 32768 },
        { id: 'gpt-4o', name: 'gpt-4o (vision)', contextWindow: 128000, maxTokens: 16384 },
        // o-series reasoning models (keep latest variants only)
        {
          id: 'o4-mini',
          name: 'o4-mini (fast reasoning)',
          contextWindow: 200000,
          maxTokens: 100000,
        },
        { id: 'o3-pro', name: 'o3-pro (deep reasoning)', contextWindow: 200000, maxTokens: 100000 },
        {
          id: 'o4-mini-deep-research',
          name: 'o4-mini deep research',
          contextWindow: 200000,
          maxTokens: 100000,
        },
      ],
    };
    console.log('[OAuth] Registered openai-oauth provider in config');
  } else if (provider === 'anthropic') {
    const key = credentials.anthropic?.api_key || credentials.anthropic?.access_token;
    if (key) {
      const baseUrl = gwBase ? `${gwBase}/anthropic` : 'https://api.anthropic.com';
      config.models.providers['anthropic-oauth'] = {
        baseUrl,
        apiKey: key,
        api: 'anthropic-messages',
        models: [
          {
            id: 'claude-sonnet-4-5-20250514',
            name: 'claude-sonnet-4-5-20250514',
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      };
      console.log('[OAuth] Registered anthropic-oauth provider in config');
    }
  }

  // Write updated config
  await sandbox.writeFile('/root/.openclaw/openclaw.json', JSON.stringify(config, null, 2));
}

/**
 * Remove OAuth provider entry from openclaw.json
 */
export async function removeOAuthProviderConfig(
  sandbox: Sandbox,
  provider: 'openai' | 'anthropic',
): Promise<void> {
  const result = await sandbox.exec('cat /root/.openclaw/openclaw.json 2>/dev/null || echo "{}"');
  const config = JSON.parse(result.stdout?.trim() || '{}');

  const providerKey = provider === 'openai' ? 'openai-oauth' : 'anthropic-oauth';
  if (config?.models?.providers?.[providerKey]) {
    delete config.models.providers[providerKey];
    console.log(`[OAuth] Removed ${providerKey} provider from config`);
    await sandbox.writeFile('/root/.openclaw/openclaw.json', JSON.stringify(config, null, 2));
  }
}
