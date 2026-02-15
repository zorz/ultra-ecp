/**
 * Claude OAuth Service
 *
 * Implements OAuth 2.0 with PKCE for Claude Pro/Max authentication.
 * Allows users to use their Claude subscription instead of API keys.
 */

import { generatePKCE, type PKCEChallenge } from './pkce.ts';
import { localSecretService } from '../secret/local.ts';

// Public client ID for CLI tools (from Anthropic)
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';

export type ClaudeAuthMode = 'max' | 'console';

export interface ClaudeOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  mode: ClaudeAuthMode;
}

export interface ClaudeAuthStatus {
  authenticated: boolean;
  mode?: ClaudeAuthMode;
  expiresAt?: number;
  expired?: boolean;
}

// Store pending PKCE challenges by state
const pendingChallenges = new Map<string, PKCEChallenge>();

/**
 * Start the OAuth authorization flow.
 *
 * @param mode - 'max' for Claude Pro/Max subscription, 'console' for API key creation
 * @returns URL to open in browser and the state/verifier for callback
 */
export function startAuthorization(mode: ClaudeAuthMode): {
  url: string;
  state: string;
} {
  const pkce = generatePKCE();

  const baseUrl =
    mode === 'console'
      ? 'https://console.anthropic.com/oauth/authorize'
      : 'https://claude.ai/oauth/authorize';

  const url = new URL(baseUrl);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', 'org:create_api_key user:profile user:inference');
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', pkce.verifier);

  // Store the PKCE challenge for later verification
  pendingChallenges.set(pkce.verifier, pkce);

  // Clean up old challenges after 10 minutes
  setTimeout(() => {
    pendingChallenges.delete(pkce.verifier);
  }, 10 * 60 * 1000);

  return {
    url: url.toString(),
    state: pkce.verifier,
  };
}

/**
 * Exchange the authorization code for tokens.
 *
 * @param code - The authorization code from the callback (may include state after #)
 * @param state - The state/verifier from the initial request
 * @param mode - The auth mode used
 */
export async function exchangeCode(
  code: string,
  state: string,
  mode: ClaudeAuthMode
): Promise<{ success: true; tokens: ClaudeOAuthTokens } | { success: false; error: string }> {
  // Get the PKCE verifier
  const pkce = pendingChallenges.get(state);
  if (!pkce) {
    return { success: false, error: 'Invalid or expired state' };
  }

  // Clean up the pending challenge
  pendingChallenges.delete(state);

  // Parse code (may have state appended after #)
  const [authCode, codeState] = code.split('#');

  try {
    const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: authCode,
        state: codeState || state,
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: pkce.verifier,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Token exchange failed: ${response.status} ${text}` };
    }

    const json = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const tokens: ClaudeOAuthTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + json.expires_in * 1000,
      mode,
    };

    // Store tokens securely
    await storeTokens(tokens);

    return { success: true, tokens };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Token exchange failed',
    };
  }
}

/**
 * Refresh the access token using the refresh token.
 */
export async function refreshAccessToken(): Promise<
  { success: true; tokens: ClaudeOAuthTokens } | { success: false; error: string }
> {
  const storedTokens = await getStoredTokens();
  if (!storedTokens) {
    return { success: false, error: 'No stored tokens' };
  }

  try {
    const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: storedTokens.refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    if (!response.ok) {
      return { success: false, error: `Token refresh failed: ${response.status}` };
    }

    const json = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const tokens: ClaudeOAuthTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + json.expires_in * 1000,
      mode: storedTokens.mode,
    };

    // Store updated tokens
    await storeTokens(tokens);

    return { success: true, tokens };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Token refresh failed',
    };
  }
}

/**
 * Get a valid access token, refreshing if necessary.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = await getStoredTokens();
  if (!tokens) {
    return null;
  }

  // Check if token is expired or will expire in the next minute
  if (tokens.expiresAt < Date.now() + 60 * 1000) {
    const refreshResult = await refreshAccessToken();
    if (!refreshResult.success) {
      console.error('[ClaudeOAuth] Token refresh failed:', refreshResult.error);
      return null;
    }
    return refreshResult.tokens.accessToken;
  }

  return tokens.accessToken;
}

/**
 * Store OAuth tokens securely.
 */
async function storeTokens(tokens: ClaudeOAuthTokens): Promise<void> {
  await localSecretService.set('CLAUDE_OAUTH_ACCESS_TOKEN', tokens.accessToken);
  await localSecretService.set('CLAUDE_OAUTH_REFRESH_TOKEN', tokens.refreshToken);
  await localSecretService.set('CLAUDE_OAUTH_EXPIRES_AT', String(tokens.expiresAt));
  await localSecretService.set('CLAUDE_OAUTH_MODE', tokens.mode);
}

/**
 * Get stored OAuth tokens.
 */
export async function getStoredTokens(): Promise<ClaudeOAuthTokens | null> {
  const accessToken = await localSecretService.get('CLAUDE_OAUTH_ACCESS_TOKEN');
  const refreshToken = await localSecretService.get('CLAUDE_OAUTH_REFRESH_TOKEN');
  const expiresAtStr = await localSecretService.get('CLAUDE_OAUTH_EXPIRES_AT');
  const mode = await localSecretService.get('CLAUDE_OAUTH_MODE') as ClaudeAuthMode | null;

  if (!accessToken || !refreshToken || !expiresAtStr || !mode) {
    return null;
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: parseInt(expiresAtStr, 10),
    mode,
  };
}

/**
 * Get the current authentication status.
 */
export async function getAuthStatus(): Promise<ClaudeAuthStatus> {
  const tokens = await getStoredTokens();
  if (!tokens) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    mode: tokens.mode,
    expiresAt: tokens.expiresAt,
    expired: tokens.expiresAt < Date.now(),
  };
}

/**
 * Clear stored OAuth tokens (logout).
 */
export async function logout(): Promise<void> {
  await localSecretService.delete('CLAUDE_OAUTH_ACCESS_TOKEN');
  await localSecretService.delete('CLAUDE_OAUTH_REFRESH_TOKEN');
  await localSecretService.delete('CLAUDE_OAUTH_EXPIRES_AT');
  await localSecretService.delete('CLAUDE_OAUTH_MODE');
}

/**
 * Create an API key using the OAuth access token.
 * Only works when authenticated via console mode.
 */
export async function createApiKey(): Promise<
  { success: true; apiKey: string } | { success: false; error: string }
> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    const response = await fetch(
      'https://api.anthropic.com/api/oauth/claude_cli/create_api_key',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      return { success: false, error: `API key creation failed: ${response.status}` };
    }

    const json = (await response.json()) as { raw_key: string };
    return { success: true, apiKey: json.raw_key };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'API key creation failed',
    };
  }
}
