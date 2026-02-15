/**
 * Auth Service ECP Adapter
 *
 * Maps JSON-RPC 2.0 methods to authentication operations.
 * Handles OAuth flows and API key management.
 */

import { debugLog } from '../../debug.ts';
import type { SecretService } from '../secret/interface.ts';
import * as claudeOAuth from '../oauth/claude-oauth.ts';
import type { HandlerResult } from '../../protocol/types.ts';

/**
 * ECP error codes for auth service.
 */
export const AuthErrorCodes = {
  InvalidRequest: -32602,
  AuthFailed: -32020,
  NotAuthenticated: -32021,
  ProviderNotSupported: -32022,
} as const;

/**
 * Supported auth providers.
 */
export type AuthProvider = 'claude' | 'openai' | 'gemini' | 'ollama';

/**
 * Auth method types.
 */
export type AuthMethod = 'oauth' | 'apikey' | 'none';

/**
 * Provider auth configuration.
 */
export interface ProviderAuthConfig {
  provider: AuthProvider;
  methods: AuthMethod[];
  oauthModes?: string[];
  secretKey: string;
  envVar: string;
}

/**
 * Auth configurations for each provider.
 */
const PROVIDER_AUTH_CONFIG: Record<AuthProvider, ProviderAuthConfig> = {
  claude: {
    provider: 'claude',
    methods: ['oauth', 'apikey'],
    oauthModes: ['max', 'console'],
    secretKey: 'ANTHROPIC_API_KEY',
    envVar: 'ANTHROPIC_API_KEY',
  },
  openai: {
    provider: 'openai',
    methods: ['apikey'],
    secretKey: 'OPENAI_API_KEY',
    envVar: 'OPENAI_API_KEY',
  },
  gemini: {
    provider: 'gemini',
    methods: ['apikey'],
    secretKey: 'GEMINI_API_KEY',
    envVar: 'GEMINI_API_KEY',
  },
  ollama: {
    provider: 'ollama',
    methods: ['none'],
    secretKey: '',
    envVar: '',
  },
};

/**
 * Auth Service ECP Adapter.
 */
export class AuthServiceAdapter {
  private secretService: SecretService;

  constructor(secretService: SecretService) {
    this.secretService = secretService;
    this.debugLog('AuthServiceAdapter initialized');
  }

  private debugLog(msg: string): void {
    debugLog(`[AuthServiceAdapter] ${msg}`);
  }

  /**
   * Handle an ECP request.
   */
  async handleRequest(method: string, params: unknown): Promise<HandlerResult> {
    switch (method) {
      // Provider info
      case 'auth/providers':
        return this.handleListProviders();
      case 'auth/status':
        return this.handleGetStatus(params);

      // OAuth
      case 'auth/oauth/start':
        return this.handleOAuthStart(params);
      case 'auth/oauth/callback':
        return this.handleOAuthCallback(params);

      // API Keys
      case 'auth/apikey/set':
        return this.handleSetApiKey(params);
      case 'auth/apikey/get':
        return this.handleGetApiKey(params);
      case 'auth/apikey/delete':
        return this.handleDeleteApiKey(params);

      // Switch auth method
      case 'auth/switch':
        return this.handleSwitchMethod(params);

      // Clear specific credentials
      case 'auth/oauth/clear':
        return this.handleClearOAuth(params);
      case 'auth/apikey/clear':
        return this.handleClearApiKey(params);

      // Logout (clears all)
      case 'auth/logout':
        return this.handleLogout(params);

      default:
        return {
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }
  }

  /**
   * List all auth providers and their methods.
   */
  private handleListProviders(): HandlerResult {
    const providers = Object.values(PROVIDER_AUTH_CONFIG).map((config) => ({
      provider: config.provider,
      methods: config.methods,
      oauthModes: config.oauthModes,
    }));

    return { result: { providers } };
  }

  /**
   * Get auth status for a provider.
   * Returns info about all available auth methods and which is active.
   */
  private async handleGetStatus(params: unknown): Promise<HandlerResult> {
    const p = params as { provider?: AuthProvider };
    if (!p?.provider) {
      return {
        error: { code: AuthErrorCodes.InvalidRequest, message: 'provider is required' },
      };
    }

    const config = PROVIDER_AUTH_CONFIG[p.provider];
    if (!config) {
      return {
        error: { code: AuthErrorCodes.ProviderNotSupported, message: `Unknown provider: ${p.provider}` },
      };
    }

    // Ollama doesn't need auth
    if (p.provider === 'ollama') {
      return {
        result: {
          provider: p.provider,
          authenticated: true,
          method: 'none',
        },
      };
    }

    // Build comprehensive status for providers that support multiple auth methods
    const result: {
      provider: AuthProvider;
      authenticated: boolean;
      activeMethod?: AuthMethod;
      oauth?: {
        available: boolean;
        mode?: string;
        expiresAt?: number;
        expired?: boolean;
      };
      apiKey?: {
        available: boolean;
        source?: 'stored' | 'environment';
      };
    } = {
      provider: p.provider,
      authenticated: false,
    };

    // Check OAuth status for Claude
    let oauthAvailable = false;
    if (p.provider === 'claude') {
      const oauthStatus = await claudeOAuth.getAuthStatus();
      oauthAvailable = oauthStatus.authenticated;
      result.oauth = {
        available: oauthStatus.authenticated,
        mode: oauthStatus.mode,
        expiresAt: oauthStatus.expiresAt,
        expired: oauthStatus.expired,
      };
    }

    // Check API key
    let apiKeyAvailable = false;
    let apiKeySource: 'stored' | 'environment' | undefined;
    if (config.secretKey) {
      const apiKey = await this.secretService.get(config.secretKey);
      if (apiKey) {
        apiKeyAvailable = true;
        apiKeySource = 'stored';
      } else {
        const envKey = process.env[config.envVar];
        if (envKey) {
          apiKeyAvailable = true;
          apiKeySource = 'environment';
        }
      }
      result.apiKey = {
        available: apiKeyAvailable,
        source: apiKeySource,
      };
    }

    // Determine if authenticated and which method is active
    if (oauthAvailable || apiKeyAvailable) {
      result.authenticated = true;

      // Check preferred method from secret service
      const preferredMethod = await this.secretService.get(`${p.provider.toUpperCase()}_AUTH_METHOD`);

      if (preferredMethod === 'apikey' && apiKeyAvailable) {
        result.activeMethod = 'apikey';
      } else if (preferredMethod === 'oauth' && oauthAvailable) {
        result.activeMethod = 'oauth';
      } else {
        // Default: prefer OAuth if available, otherwise API key
        result.activeMethod = oauthAvailable ? 'oauth' : 'apikey';
      }
    }

    return { result };
  }

  /**
   * Switch active auth method for a provider.
   */
  private async handleSwitchMethod(params: unknown): Promise<HandlerResult> {
    const p = params as { provider?: AuthProvider; method?: AuthMethod };
    if (!p?.provider || !p?.method) {
      return {
        error: { code: AuthErrorCodes.InvalidRequest, message: 'provider and method are required' },
      };
    }

    // Store the preferred method
    await this.secretService.set(`${p.provider.toUpperCase()}_AUTH_METHOD`, p.method);
    this.debugLog(`Switched ${p.provider} to ${p.method} auth`);

    return { result: { success: true, method: p.method } };
  }

  /**
   * Clear only OAuth credentials (keep API key).
   */
  private async handleClearOAuth(params: unknown): Promise<HandlerResult> {
    const p = params as { provider?: AuthProvider };
    if (!p?.provider) {
      return {
        error: { code: AuthErrorCodes.InvalidRequest, message: 'provider is required' },
      };
    }

    if (p.provider === 'claude') {
      await claudeOAuth.logout();
      this.debugLog(`Cleared OAuth for ${p.provider}`);
    }

    return { result: { success: true } };
  }

  /**
   * Clear only API key (keep OAuth).
   */
  private async handleClearApiKey(params: unknown): Promise<HandlerResult> {
    const p = params as { provider?: AuthProvider };
    if (!p?.provider) {
      return {
        error: { code: AuthErrorCodes.InvalidRequest, message: 'provider is required' },
      };
    }

    const config = PROVIDER_AUTH_CONFIG[p.provider];
    if (config?.secretKey) {
      await this.secretService.delete(config.secretKey);
      this.debugLog(`Cleared API key for ${p.provider}`);
    }

    return { result: { success: true } };
  }

  /**
   * Start OAuth flow.
   */
  private handleOAuthStart(params: unknown): HandlerResult {
    const p = params as { provider?: AuthProvider; mode?: string };
    if (!p?.provider) {
      return {
        error: { code: AuthErrorCodes.InvalidRequest, message: 'provider is required' },
      };
    }

    if (p.provider !== 'claude') {
      return {
        error: {
          code: AuthErrorCodes.ProviderNotSupported,
          message: `OAuth not supported for ${p.provider}`,
        },
      };
    }

    const mode = (p.mode as 'max' | 'console') || 'max';
    const { url, state } = claudeOAuth.startAuthorization(mode);

    return {
      result: {
        url,
        state,
        instructions: 'Open the URL in a browser, authorize, then paste the code here.',
      },
    };
  }

  /**
   * Handle OAuth callback with authorization code.
   */
  private async handleOAuthCallback(params: unknown): Promise<HandlerResult> {
    const p = params as { provider?: AuthProvider; code?: string; state?: string; mode?: string };
    if (!p?.provider || !p?.code || !p?.state) {
      return {
        error: {
          code: AuthErrorCodes.InvalidRequest,
          message: 'provider, code, and state are required',
        },
      };
    }

    if (p.provider !== 'claude') {
      return {
        error: {
          code: AuthErrorCodes.ProviderNotSupported,
          message: `OAuth not supported for ${p.provider}`,
        },
      };
    }

    const mode = (p.mode as 'max' | 'console') || 'max';
    const result = await claudeOAuth.exchangeCode(p.code, p.state, mode);

    if (!result.success) {
      return {
        error: {
          code: AuthErrorCodes.AuthFailed,
          message: result.error,
        },
      };
    }

    return {
      result: {
        success: true,
        mode: result.tokens.mode,
        expiresAt: result.tokens.expiresAt,
      },
    };
  }

  /**
   * Set API key for a provider.
   */
  private async handleSetApiKey(params: unknown): Promise<HandlerResult> {
    const p = params as { provider?: AuthProvider; apiKey?: string };
    if (!p?.provider || !p?.apiKey) {
      return {
        error: {
          code: AuthErrorCodes.InvalidRequest,
          message: 'provider and apiKey are required',
        },
      };
    }

    const config = PROVIDER_AUTH_CONFIG[p.provider];
    if (!config || !config.secretKey) {
      return {
        error: {
          code: AuthErrorCodes.ProviderNotSupported,
          message: `API key not supported for ${p.provider}`,
        },
      };
    }

    await this.secretService.set(config.secretKey, p.apiKey);
    this.debugLog(`API key set for ${p.provider}`);

    return { result: { success: true } };
  }

  /**
   * Get API key for a provider (returns masked version).
   */
  private async handleGetApiKey(params: unknown): Promise<HandlerResult> {
    const p = params as { provider?: AuthProvider };
    if (!p?.provider) {
      return {
        error: { code: AuthErrorCodes.InvalidRequest, message: 'provider is required' },
      };
    }

    const config = PROVIDER_AUTH_CONFIG[p.provider];
    if (!config || !config.secretKey) {
      return {
        error: {
          code: AuthErrorCodes.ProviderNotSupported,
          message: `API key not supported for ${p.provider}`,
        },
      };
    }

    const apiKey = await this.secretService.get(config.secretKey);
    if (!apiKey) {
      return { result: { hasKey: false } };
    }

    // Return masked key (first 4 and last 4 characters)
    const masked =
      apiKey.length > 12
        ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
        : '****';

    return {
      result: {
        hasKey: true,
        masked,
      },
    };
  }

  /**
   * Delete API key for a provider.
   */
  private async handleDeleteApiKey(params: unknown): Promise<HandlerResult> {
    const p = params as { provider?: AuthProvider };
    if (!p?.provider) {
      return {
        error: { code: AuthErrorCodes.InvalidRequest, message: 'provider is required' },
      };
    }

    const config = PROVIDER_AUTH_CONFIG[p.provider];
    if (!config || !config.secretKey) {
      return {
        error: {
          code: AuthErrorCodes.ProviderNotSupported,
          message: `API key not supported for ${p.provider}`,
        },
      };
    }

    await this.secretService.delete(config.secretKey);
    this.debugLog(`API key deleted for ${p.provider}`);

    return { result: { success: true } };
  }

  /**
   * Logout from a provider (clear all credentials).
   */
  private async handleLogout(params: unknown): Promise<HandlerResult> {
    const p = params as { provider?: AuthProvider };
    if (!p?.provider) {
      return {
        error: { code: AuthErrorCodes.InvalidRequest, message: 'provider is required' },
      };
    }

    // Clear OAuth tokens for Claude
    if (p.provider === 'claude') {
      await claudeOAuth.logout();
    }

    // Clear API key
    const config = PROVIDER_AUTH_CONFIG[p.provider];
    if (config?.secretKey) {
      await this.secretService.delete(config.secretKey);
    }

    this.debugLog(`Logged out from ${p.provider}`);

    return { result: { success: true } };
  }
}
