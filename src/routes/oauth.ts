import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { syncToR2, restartGateway } from '../gateway';
import {
  generatePKCE,
  generateState,
  readOAuthCredentials,
  writeOAuthCredentials,
  removeProviderCredentials,
  writePendingState,
  readPendingState,
  clearPendingState,
  patchOAuthProviderConfig,
  removeOAuthProviderConfig,
  exchangeForApiKey,
  type OpenAIPendingState,
  type AnthropicPendingState,
} from '../gateway/oauth';

// OpenAI OAuth constants
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_REDIRECT_URI = 'http://localhost:1455/auth/callback';

// Anthropic OAuth constants
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_AUTH_URL = 'https://console.anthropic.com/oauth/authorize';
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const ANTHROPIC_CREATE_KEY_URL = 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key';
const ANTHROPIC_SCOPES = 'org:create_api_key user:profile user:inference';

const CURL_TIMEOUT = 15;

/**
 * OAuth API routes
 * All routes protected by Cloudflare Access JWT middleware
 */
const oauthApi = new Hono<AppEnv>();

// Middleware: Verify Cloudflare Access JWT for all OAuth routes
oauthApi.use('*', createAccessMiddleware({ type: 'json' }));

// GET /status - Get OAuth connection status
oauthApi.get('/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const credentials = await readOAuthCredentials(sandbox);
    const openaiPending = (await readPendingState(sandbox, 'openai')) as OpenAIPendingState | null;
    const anthropicPending =
      (await readPendingState(sandbox, 'anthropic')) as AnthropicPendingState | null;

    return c.json({
      openai: {
        connected: !!credentials.openai?.access_token,
        pending: !!openaiPending,
        obtainedAt: credentials.openai?.obtained_at,
      },
      anthropic: {
        connected: !!credentials.anthropic?.access_token,
        pending: !!anthropicPending,
        obtainedAt: credentials.anthropic?.obtained_at,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /openai/start - Generate OpenAI PKCE authorize URL
oauthApi.post('/openai/start', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Clear any existing pending state
    await clearPendingState(sandbox, 'openai');

    // Generate PKCE
    const { codeVerifier, codeChallenge } = await generatePKCE();
    const state = generateState();

    // Save pending state
    await writePendingState(sandbox, 'openai', {
      code_verifier: codeVerifier,
      code_challenge: codeChallenge,
      state,
      started_at: Date.now(),
    });

    // Build authorize URL (same as Codex CLI)
    const authUrl = new URL(OPENAI_AUTH_URL);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', OPENAI_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', OPENAI_REDIRECT_URI);
    authUrl.searchParams.set('scope', 'openid profile email offline_access');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('id_token_add_organizations', 'true');
    authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
    authUrl.searchParams.set('originator', 'codex_cli_rs');
    authUrl.searchParams.set('state', state);

    return c.json({ auth_url: authUrl.toString(), state });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /openai/exchange - Exchange OpenAI authorization code for tokens
oauthApi.post('/openai/exchange', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const body = (await c.req.json()) as { code?: string; callback_url?: string };
    let authCode = body.code;

    // Accept full callback URL and extract code
    if (!authCode && body.callback_url) {
      try {
        const url = new URL(body.callback_url);
        authCode = url.searchParams.get('code') || undefined;
      } catch {
        return c.json({ status: 'error', error: 'Invalid callback URL' }, 400);
      }
    }

    if (!authCode || typeof authCode !== 'string') {
      return c.json({ status: 'error', error: 'code or callback_url is required' }, 400);
    }

    const pending = (await readPendingState(sandbox, 'openai')) as OpenAIPendingState | null;

    if (!pending) {
      return c.json({ status: 'error', error: 'No pending OpenAI auth flow' }, 400);
    }

    // Exchange authorization code for tokens
    const exchangeCmd = `curl -s -X POST '${OPENAI_TOKEN_URL}' \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      -d 'grant_type=authorization_code&client_id=${OPENAI_CLIENT_ID}&code=${authCode}&redirect_uri=${encodeURIComponent(OPENAI_REDIRECT_URI)}&code_verifier=${pending.code_verifier}' \
      --max-time ${CURL_TIMEOUT}`;

    const exchangeResult = await sandbox.exec(exchangeCmd);
    const exchangeStdout = exchangeResult.stdout?.trim();

    if (!exchangeStdout) {
      return c.json({ status: 'error', error: 'Empty exchange response' }, 500);
    }

    console.log('[OpenAI OAuth] Token exchange response:', exchangeStdout);

    const tokens = JSON.parse(exchangeStdout) as {
      access_token: string;
      refresh_token: string;
      id_token: string;
      token_type: string;
      expires_in?: number;
    };

    if (!tokens.access_token || !tokens.refresh_token) {
      return c.json({
        status: 'error',
        error: `Invalid token response from OpenAI: ${exchangeStdout.substring(0, 200)}`,
      }, 500);
    }

    // Stage 2: id_token → API key (RFC 8693)
    let apiKey = tokens.access_token; // fallback
    if (tokens.id_token) {
      console.log('[OpenAI OAuth] id_token present, attempting RFC 8693 exchange');
      try {
        apiKey = await exchangeForApiKey(sandbox, tokens.id_token);
        console.log('[OpenAI OAuth] API key obtained via token exchange, prefix:', apiKey.substring(0, 6));
      } catch (err) {
        console.error('[OpenAI OAuth] Token exchange failed, falling back to access_token:', err);
      }
    } else {
      console.warn('[OpenAI OAuth] No id_token in response — RFC 8693 exchange skipped');
    }

    // Save credentials
    const credentials = await readOAuthCredentials(sandbox);
    credentials.openai = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      api_key: apiKey,
      token_type: tokens.token_type,
      expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      obtained_at: Date.now(),
    };
    await writeOAuthCredentials(sandbox, credentials);

    // Clean up pending state
    await clearPendingState(sandbox, 'openai');

    // Patch config to add provider immediately (route through CF AI Gateway if configured)
    const gwConfig = c.env.CF_AI_GATEWAY_ACCOUNT_ID && c.env.CF_AI_GATEWAY_GATEWAY_ID
      ? { accountId: c.env.CF_AI_GATEWAY_ACCOUNT_ID, gatewayId: c.env.CF_AI_GATEWAY_GATEWAY_ID }
      : undefined;
    await patchOAuthProviderConfig(sandbox, 'openai', credentials, gwConfig);

    // Sync to R2
    await syncToR2(sandbox, c.env);

    // Restart gateway to pick up new OAuth provider
    const restartPromise = restartGateway(sandbox).catch((err) => {
      console.error('Gateway restart failed after OpenAI OAuth:', err);
    });
    c.executionCtx.waitUntil(restartPromise);

    return c.json({ status: 'complete' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ status: 'error', error: errorMessage }, 500);
  }
});

// POST /anthropic/start - Generate Anthropic auth URL
oauthApi.post('/anthropic/start', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Clear any existing pending state
    await clearPendingState(sandbox, 'anthropic');

    // Generate PKCE
    const { codeVerifier, codeChallenge } = await generatePKCE();
    const state = generateState();

    // Save pending state
    await writePendingState(sandbox, 'anthropic', {
      code_verifier: codeVerifier,
      code_challenge: codeChallenge,
      state,
      started_at: Date.now(),
    });

    // Build auth URL
    const authUrl = new URL(ANTHROPIC_AUTH_URL);
    authUrl.searchParams.set('client_id', ANTHROPIC_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', ANTHROPIC_REDIRECT_URI);
    authUrl.searchParams.set('code', 'true');
    authUrl.searchParams.set('scope', ANTHROPIC_SCOPES);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('response_type', 'code');

    return c.json({ auth_url: authUrl.toString(), state });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /anthropic/exchange - Exchange Anthropic authorization code
oauthApi.post('/anthropic/exchange', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const body = (await c.req.json()) as { code: string };
    const { code } = body;

    if (!code || typeof code !== 'string') {
      return c.json({ status: 'error', error: 'code is required' }, 400);
    }

    // Validate code format (alphanumeric + hyphens only for security)
    if (!/^[a-zA-Z0-9-]+$/.test(code)) {
      return c.json({ status: 'error', error: 'Invalid code format' }, 400);
    }

    const pending = (await readPendingState(sandbox, 'anthropic')) as AnthropicPendingState | null;

    if (!pending) {
      return c.json({ status: 'error', error: 'No pending Anthropic auth flow' }, 400);
    }

    // Exchange code for tokens
    const exchangeCmd = `curl -s -X POST '${ANTHROPIC_TOKEN_URL}' \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      -d 'grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(ANTHROPIC_REDIRECT_URI)}&client_id=${ANTHROPIC_CLIENT_ID}&code_verifier=${pending.code_verifier}' \
      --max-time ${CURL_TIMEOUT}`;

    const exchangeResult = await sandbox.exec(exchangeCmd);
    const exchangeStdout = exchangeResult.stdout?.trim();

    if (!exchangeStdout) {
      return c.json({ status: 'error', error: 'Empty exchange response' }, 500);
    }

    const tokens = JSON.parse(exchangeStdout) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in?: number;
    };

    // Validate token response
    if (!tokens.access_token) {
      return c.json({ status: 'error', error: 'Invalid token response from Anthropic' }, 500);
    }

    // Create API key
    const createKeyCmd = `curl -s -X POST '${ANTHROPIC_CREATE_KEY_URL}' \
      -H 'Authorization: Bearer ${tokens.access_token}' \
      -H 'Content-Type: application/json' \
      --max-time ${CURL_TIMEOUT}`;

    const createKeyResult = await sandbox.exec(createKeyCmd);
    const createKeyStdout = createKeyResult.stdout?.trim();

    let apiKey: string | undefined;
    if (createKeyStdout) {
      try {
        const keyResponse = JSON.parse(createKeyStdout) as { api_key?: string };
        apiKey = keyResponse.api_key;
      } catch {
        // API key creation optional, continue without it
      }
    }

    // Save credentials
    const credentials = await readOAuthCredentials(sandbox);
    credentials.anthropic = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      api_key: apiKey,
      token_type: tokens.token_type,
      expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      obtained_at: Date.now(),
    };
    await writeOAuthCredentials(sandbox, credentials);

    // Clean up pending state
    await clearPendingState(sandbox, 'anthropic');

    // Patch config to add provider immediately (route through CF AI Gateway if configured)
    const anthropicGwConfig = c.env.CF_AI_GATEWAY_ACCOUNT_ID && c.env.CF_AI_GATEWAY_GATEWAY_ID
      ? { accountId: c.env.CF_AI_GATEWAY_ACCOUNT_ID, gatewayId: c.env.CF_AI_GATEWAY_GATEWAY_ID }
      : undefined;
    await patchOAuthProviderConfig(sandbox, 'anthropic', credentials, anthropicGwConfig);

    // Sync to R2
    await syncToR2(sandbox, c.env);

    // Restart gateway to pick up new OAuth provider
    const restartPromise = restartGateway(sandbox).catch((err) => {
      console.error('Gateway restart failed after Anthropic OAuth:', err);
    });
    c.executionCtx.waitUntil(restartPromise);

    return c.json({ status: 'complete' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ status: 'error', error: errorMessage }, 500);
  }
});

// DELETE /:provider - Remove provider credentials
oauthApi.delete('/:provider', async (c) => {
  const sandbox = c.get('sandbox');
  const provider = c.req.param('provider');

  if (provider !== 'openai' && provider !== 'anthropic') {
    return c.json({ error: 'Invalid provider' }, 400);
  }

  try {
    await removeProviderCredentials(sandbox, provider);
    await clearPendingState(sandbox, provider);

    // Remove provider from config immediately
    await removeOAuthProviderConfig(sandbox, provider);

    await syncToR2(sandbox, c.env);

    // Restart gateway to remove OAuth provider from UI
    const restartPromise = restartGateway(sandbox).catch((err) => {
      console.error(`Gateway restart failed after ${provider} logout:`, err);
    });
    c.executionCtx.waitUntil(restartPromise);

    return c.json({ success: true, message: `${provider} credentials removed` });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

export { oauthApi };
