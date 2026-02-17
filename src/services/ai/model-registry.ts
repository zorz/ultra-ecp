/**
 * Model Registry Service
 *
 * Manages AI model discovery and configuration.
 * Fetches available models from provider APIs and maintains a local cache.
 */

import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { localSecretService } from '../secret/local.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

// ============================================
// Types
// ============================================

export interface ModelInfo {
  id: string;
  name: string;
  provider: 'anthropic' | 'openai' | 'google' | 'ollama' | 'agent-sdk' | 'custom';
  capabilities: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: 'free' | 'low' | 'medium' | 'high' | 'premium';
  speed?: 'fast' | 'medium' | 'slow';
  quality?: 'basic' | 'good' | 'excellent' | 'best';
  available: boolean;
  deprecatedAt?: string;
  replacedBy?: string;
}

export interface ModelsConfig {
  version: number;
  lastUpdated: string;
  defaults: {
    fast: string;
    smart: string;
    code: string;
    balanced: string;
    cheap: string;
    vision: string;
  };
  providerDefaults: {
    anthropic: string;
    openai: string;
    google: string;
    ollama: string;
    custom: string;
  };
  models: ModelInfo[];
}

export interface RefreshResult {
  success: boolean;
  openai: { found: number; error?: string };
  gemini: { found: number; error?: string };
  anthropic: { found: number; error?: string };
  ollama: { found: number; error?: string };
  total: number;
  path: string;
}

// ============================================
// Constants
// ============================================

const ULTRA_DIR = join(homedir(), '.ultra');
const MODELS_FILE = join(ULTRA_DIR, 'models.json');

// Bundled config path (relative to this file's location: src/services/ai/)
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_MODELS_FILE = join(CURRENT_DIR, '..', '..', '..', 'config', 'models.json');

// Default capabilities for providers
const OPENAI_CAPABILITIES = ['chat', 'code', 'tools', 'streaming', 'json-mode'];
const GEMINI_CAPABILITIES = ['chat', 'code', 'tools', 'streaming', 'json-mode'];
const ANTHROPIC_CAPABILITIES = ['chat', 'code', 'reasoning', 'vision', 'tools', 'streaming', 'json-mode', 'long-context'];

// Known model metadata (for models we know about)
const MODEL_METADATA: Record<string, Partial<ModelInfo>> = {
  // OpenAI
  'gpt-4o': { name: 'GPT-4o', capabilities: [...OPENAI_CAPABILITIES, 'vision', 'reasoning'], pricing: 'medium', speed: 'medium', quality: 'excellent' },
  'gpt-4o-mini': { name: 'GPT-4o Mini', capabilities: [...OPENAI_CAPABILITIES, 'vision'], pricing: 'low', speed: 'fast', quality: 'good' },
  'gpt-4-turbo': { name: 'GPT-4 Turbo', capabilities: [...OPENAI_CAPABILITIES, 'vision', 'reasoning'], pricing: 'high', speed: 'medium', quality: 'excellent' },
  'gpt-4.1': { name: 'GPT-4.1', capabilities: [...OPENAI_CAPABILITIES, 'vision', 'reasoning', 'long-context'], pricing: 'medium', speed: 'medium', quality: 'excellent' },
  'gpt-4.1-mini': { name: 'GPT-4.1 Mini', capabilities: [...OPENAI_CAPABILITIES, 'vision'], pricing: 'low', speed: 'fast', quality: 'good' },
  'gpt-4.1-nano': { name: 'GPT-4.1 Nano', capabilities: [...OPENAI_CAPABILITIES], pricing: 'low', speed: 'fast', quality: 'basic' },
  'gpt-5': { name: 'GPT-5', capabilities: [...OPENAI_CAPABILITIES, 'vision', 'reasoning', 'long-context'], pricing: 'premium', speed: 'medium', quality: 'best' },
  'gpt-5-mini': { name: 'GPT-5 Mini', capabilities: [...OPENAI_CAPABILITIES, 'vision', 'reasoning'], pricing: 'medium', speed: 'fast', quality: 'excellent' },
  'gpt-5-nano': { name: 'GPT-5 Nano', capabilities: [...OPENAI_CAPABILITIES, 'vision'], pricing: 'low', speed: 'fast', quality: 'good' },
  'gpt-5-pro': { name: 'GPT-5 Pro', capabilities: [...OPENAI_CAPABILITIES, 'vision', 'reasoning', 'long-context'], pricing: 'premium', speed: 'slow', quality: 'best' },
  'gpt-5.1': { name: 'GPT-5.1', capabilities: [...OPENAI_CAPABILITIES, 'vision', 'reasoning', 'long-context'], pricing: 'premium', speed: 'medium', quality: 'best' },
  'gpt-5.2': { name: 'GPT-5.2', capabilities: [...OPENAI_CAPABILITIES, 'vision', 'reasoning', 'long-context'], pricing: 'premium', speed: 'medium', quality: 'best' },
  'gpt-5.2-pro': { name: 'GPT-5.2 Pro', capabilities: [...OPENAI_CAPABILITIES, 'vision', 'reasoning', 'long-context'], pricing: 'premium', speed: 'slow', quality: 'best' },
  'o1': { name: 'o1', capabilities: [...OPENAI_CAPABILITIES, 'reasoning', 'long-context'], pricing: 'premium', speed: 'slow', quality: 'best' },
  'o1-pro': { name: 'o1 Pro', capabilities: [...OPENAI_CAPABILITIES, 'reasoning', 'long-context'], pricing: 'premium', speed: 'slow', quality: 'best' },
  'o3': { name: 'o3', capabilities: [...OPENAI_CAPABILITIES, 'reasoning', 'long-context'], pricing: 'premium', speed: 'slow', quality: 'best' },
  'o3-mini': { name: 'o3 Mini', capabilities: [...OPENAI_CAPABILITIES, 'reasoning', 'long-context'], pricing: 'medium', speed: 'medium', quality: 'excellent' },
  'o3-pro': { name: 'o3 Pro', capabilities: [...OPENAI_CAPABILITIES, 'reasoning', 'long-context'], pricing: 'premium', speed: 'slow', quality: 'best' },
  'o4-mini': { name: 'o4 Mini', capabilities: [...OPENAI_CAPABILITIES, 'reasoning', 'long-context'], pricing: 'medium', speed: 'fast', quality: 'excellent' },
  // Gemini
  'gemini-2.0-flash': { name: 'Gemini 2.0 Flash', capabilities: [...GEMINI_CAPABILITIES, 'vision', 'long-context'], pricing: 'low', speed: 'fast', quality: 'good' },
  'gemini-2.5-flash': { name: 'Gemini 2.5 Flash', capabilities: [...GEMINI_CAPABILITIES, 'vision', 'reasoning', 'long-context'], pricing: 'low', speed: 'fast', quality: 'good' },
  'gemini-2.5-pro': { name: 'Gemini 2.5 Pro', capabilities: [...GEMINI_CAPABILITIES, 'vision', 'reasoning', 'long-context'], pricing: 'medium', speed: 'medium', quality: 'excellent' },
  'gemini-3-pro-preview': { name: 'Gemini 3 Pro', capabilities: [...GEMINI_CAPABILITIES, 'vision', 'reasoning', 'long-context'], pricing: 'premium', speed: 'medium', quality: 'best' },
  'gemini-1.5-pro': { name: 'Gemini 1.5 Pro', capabilities: [...GEMINI_CAPABILITIES, 'vision', 'reasoning', 'long-context'], pricing: 'medium', speed: 'medium', quality: 'excellent' },
  'gemini-1.5-flash': { name: 'Gemini 1.5 Flash', capabilities: [...GEMINI_CAPABILITIES, 'vision', 'long-context'], pricing: 'low', speed: 'fast', quality: 'good' },
  // Anthropic
  'claude-opus-4-5-20251101': { name: 'Claude Opus 4.5', capabilities: ANTHROPIC_CAPABILITIES, contextWindow: 200000, maxOutputTokens: 32000, pricing: 'premium', speed: 'slow', quality: 'best' },
  'claude-sonnet-4-5-20250929': { name: 'Claude Sonnet 4.5', capabilities: ANTHROPIC_CAPABILITIES, contextWindow: 200000, maxOutputTokens: 16000, pricing: 'medium', speed: 'medium', quality: 'best' },
  'claude-haiku-4-5-20251001': { name: 'Claude Haiku 4.5', capabilities: ANTHROPIC_CAPABILITIES, contextWindow: 200000, maxOutputTokens: 8192, pricing: 'low', speed: 'fast', quality: 'excellent' },
  'claude-opus-4-1-20250805': { name: 'Claude Opus 4.1', capabilities: ANTHROPIC_CAPABILITIES, contextWindow: 200000, maxOutputTokens: 32000, pricing: 'premium', speed: 'slow', quality: 'best' },
  'claude-opus-4-20250514': { name: 'Claude Opus 4', capabilities: ANTHROPIC_CAPABILITIES, contextWindow: 200000, maxOutputTokens: 32000, pricing: 'premium', speed: 'slow', quality: 'best' },
  'claude-sonnet-4-20250514': { name: 'Claude Sonnet 4', capabilities: ANTHROPIC_CAPABILITIES, contextWindow: 200000, maxOutputTokens: 16000, pricing: 'medium', speed: 'medium', quality: 'excellent' },
  'claude-3-7-sonnet-20250219': { name: 'Claude Sonnet 3.7', capabilities: ANTHROPIC_CAPABILITIES, contextWindow: 200000, maxOutputTokens: 8192, pricing: 'medium', speed: 'medium', quality: 'excellent' },
  'claude-3-5-haiku-20241022': { name: 'Claude Haiku 3.5', capabilities: ['chat', 'code', 'tools', 'streaming', 'json-mode', 'long-context'], contextWindow: 200000, maxOutputTokens: 8192, pricing: 'low', speed: 'fast', quality: 'good' },
  'claude-3-haiku-20240307': { name: 'Claude Haiku 3', capabilities: ['chat', 'code', 'tools', 'streaming'], contextWindow: 200000, maxOutputTokens: 4096, pricing: 'low', speed: 'fast', quality: 'good' },
  // Agent SDK (uses Claude models via local subscription with full agentic capabilities)
  'agent-sdk:claude-opus-4-6': { name: 'Agent SDK: Opus 4.6', capabilities: ANTHROPIC_CAPABILITIES, contextWindow: 200000, maxOutputTokens: 32000, pricing: 'premium', speed: 'slow', quality: 'best' },
  'agent-sdk:claude-sonnet-4-5-20250929': { name: 'Agent SDK: Sonnet 4.5', capabilities: ANTHROPIC_CAPABILITIES, contextWindow: 200000, maxOutputTokens: 16000, pricing: 'medium', speed: 'medium', quality: 'best' },
  'agent-sdk:claude-haiku-4-5-20251001': { name: 'Agent SDK: Haiku 4.5', capabilities: ANTHROPIC_CAPABILITIES, contextWindow: 200000, maxOutputTokens: 8192, pricing: 'low', speed: 'fast', quality: 'excellent' },
};

// ============================================
// Helpers
// ============================================

function log(msg: string): void {
  if (isDebugEnabled()) {
    debugLog(`[ModelRegistry] ${msg}`);
  }
}

function inferModelName(id: string): string {
  // GPT models: "gpt-4o-mini" → "GPT-4o Mini"
  const gptMatch = id.match(/^gpt-(.+)$/);
  if (gptMatch) {
    const rest = gptMatch[1]!
      .split('-')
      .map(part => /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
    return `GPT-${rest}`;
  }

  // o-series models: "o3-mini" → "o3 Mini", "o1" → "o1"
  const oMatch = id.match(/^(o\d+(?:\.\d+)?)(?:-(.+))?$/);
  if (oMatch) {
    if (!oMatch[2]) return oMatch[1]!;
    const rest = oMatch[2]
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
    return `${oMatch[1]} ${rest}`;
  }

  // Generic: split on hyphens, capitalize each word, keep numbers attached
  return id
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function createModelInfo(id: string, provider: ModelInfo['provider']): ModelInfo {
  const metadata = MODEL_METADATA[id] || {};
  const defaultCapabilities = provider === 'openai' ? OPENAI_CAPABILITIES
    : provider === 'google' ? GEMINI_CAPABILITIES
    : provider === 'anthropic' ? ANTHROPIC_CAPABILITIES
    : provider === 'agent-sdk' ? ANTHROPIC_CAPABILITIES
    : ['chat', 'streaming'];

  return {
    id,
    name: metadata.name || inferModelName(id),
    provider,
    capabilities: metadata.capabilities || defaultCapabilities,
    contextWindow: metadata.contextWindow,
    maxOutputTokens: metadata.maxOutputTokens,
    pricing: metadata.pricing || 'medium',
    speed: metadata.speed || 'medium',
    quality: metadata.quality || 'good',
    available: true,
  };
}

// ============================================
// API Fetchers
// ============================================

async function fetchOpenAIModels(apiKey: string): Promise<string[]> {
  log('Fetching OpenAI models...');
  const resp = await fetch('https://api.openai.com/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });

  if (!resp.ok) {
    throw new Error(`OpenAI API error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as { data?: Array<{ id: string }> };
  if (!data.data) {
    throw new Error('Invalid OpenAI API response');
  }

  // Filter to usable chat completion models
  const chatModels = data.data
    .map(m => m.id)
    .filter(id => {
      // Must be a chat-capable model prefix
      if (!/^(gpt-|o[1-9])/.test(id)) return false;

      // Exclude non-chat modalities
      if (id.includes('audio')) return false;
      if (id.includes('realtime')) return false;
      if (id.includes('transcribe')) return false;
      if (id.includes('tts')) return false;
      if (id.includes('whisper')) return false;
      if (id.includes('embedding')) return false;
      if (id.includes('instruct')) return false;
      if (id.includes('davinci')) return false;
      if (id.includes('babbage')) return false;
      if (id.includes('search')) return false;
      if (id.includes('image')) return false;

      // Exclude codex models (use Responses API, not Chat Completions)
      if (id.includes('codex')) return false;

      // Exclude -chat-latest aliases (redundant with canonical name)
      if (id.endsWith('-chat-latest')) return false;

      // Exclude date-stamped variants (e.g., gpt-4o-2024-05-13, o3-2025-04-16)
      if (/\d{4}-\d{2}-\d{2}$/.test(id)) return false;

      // Exclude old-format date stamps (e.g., gpt-3.5-turbo-0125, gpt-4-0613)
      if (/-\d{4}$/.test(id)) return false;

      // Exclude -preview variants (canonical or -turbo versions exist)
      if (id.endsWith('-preview')) return false;

      // Exclude deprecated -16k variants (context is now default)
      if (id.includes('-16k')) return false;

      return true;
    })
    .sort();

  log(`Found ${chatModels.length} OpenAI chat models`);
  return chatModels;
}

async function fetchGeminiModels(apiKey: string): Promise<string[]> {
  log('Fetching Gemini models...');
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);

  if (!resp.ok) {
    throw new Error(`Gemini API error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as { models?: Array<{ name: string }> };
  if (!data.models) {
    throw new Error('Invalid Gemini API response');
  }

  // Filter to Gemini chat models
  const chatModels = data.models
    .map(m => m.name.replace('models/', ''))
    .filter(id =>
      id.startsWith('gemini-') &&
      !id.includes('embedding') &&
      !id.includes('aqa') &&
      !id.includes('imagen') &&
      !id.includes('veo')
    )
    .sort();

  log(`Found ${chatModels.length} Gemini chat models`);
  return chatModels;
}

/**
 * Anthropic model info from API response.
 */
interface AnthropicModel {
  id: string;
  created_at: string;
  display_name: string;
  type: 'model';
}

async function fetchAnthropicModels(apiKey: string): Promise<AnthropicModel[]> {
  log('Fetching Anthropic models...');
  const resp = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!resp.ok) {
    throw new Error(`Anthropic API error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as { data?: AnthropicModel[] };
  if (!data.data) {
    return [];
  }

  // Filter to claude models only (exclude any test/internal models)
  const claudeModels = data.data.filter(m => m.id.startsWith('claude-'));

  log(`Found ${claudeModels.length} Anthropic models`);
  return claudeModels;
}

/**
 * Create ModelInfo from Anthropic model data.
 */
function createAnthropicModelInfo(model: AnthropicModel): ModelInfo {
  const metadata = MODEL_METADATA[model.id];

  return {
    id: model.id,
    name: model.display_name,
    provider: 'anthropic',
    capabilities: metadata?.capabilities || ANTHROPIC_CAPABILITIES,
    contextWindow: metadata?.contextWindow || 200000,
    maxOutputTokens: metadata?.maxOutputTokens || 8192,
    pricing: metadata?.pricing || 'medium',
    speed: metadata?.speed || 'medium',
    quality: metadata?.quality || 'excellent',
    available: true,
  };
}

/**
 * Ollama model info from API response.
 */
interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
  };
}

async function fetchOllamaModels(baseUrl = 'http://localhost:11434'): Promise<OllamaModel[]> {
  log('Fetching Ollama models...');
  const resp = await fetch(`${baseUrl}/api/tags`);

  if (!resp.ok) {
    throw new Error(`Ollama API error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as { models?: OllamaModel[] };
  if (!data.models) {
    return [];
  }

  log(`Found ${data.models.length} Ollama models`);
  return data.models;
}

/**
 * Create ModelInfo from Ollama model data.
 */
function createOllamaModelInfo(model: OllamaModel): ModelInfo {
  const sizeGB = model.size / (1024 * 1024 * 1024);
  const sizeStr = sizeGB >= 1 ? `${sizeGB.toFixed(1)}GB` : `${(model.size / (1024 * 1024)).toFixed(0)}MB`;

  // Infer quality/speed from size
  let quality: ModelInfo['quality'] = 'good';
  let speed: ModelInfo['speed'] = 'medium';
  if (sizeGB > 20) {
    quality = 'excellent';
    speed = 'slow';
  } else if (sizeGB < 5) {
    quality = 'basic';
    speed = 'fast';
  }

  return {
    id: model.name,
    name: `${model.name} (${sizeStr})`,
    provider: 'ollama',
    capabilities: ['chat', 'code', 'streaming'],
    contextWindow: 4096, // Default, actual varies by model
    maxOutputTokens: 4096,
    pricing: 'free',
    speed,
    quality,
    available: true,
  };
}

// ============================================
// Main Functions
// ============================================

/**
 * Refresh models from provider APIs and save to ~/.ultra/models.json
 */
export async function refreshModels(
  onProgress?: (message: string) => void
): Promise<RefreshResult> {
  const result: RefreshResult = {
    success: false,
    openai: { found: 0 },
    gemini: { found: 0 },
    anthropic: { found: 0 },
    ollama: { found: 0 },
    total: 0,
    path: MODELS_FILE,
  };

  const report = (msg: string) => {
    log(msg);
    onProgress?.(msg);
  };

  try {
    // Ensure ~/.ultra directory exists
    await mkdir(ULTRA_DIR, { recursive: true });

    // Initialize secret service
    await localSecretService.init();

    const models: ModelInfo[] = [];

    // Fetch OpenAI models
    report('Fetching OpenAI models...');
    const openaiKey = await localSecretService.get('OPENAI_API_KEY');
    if (openaiKey) {
      try {
        const openaiModels = await fetchOpenAIModels(openaiKey);
        for (const id of openaiModels) {
          models.push(createModelInfo(id, 'openai'));
        }
        result.openai.found = openaiModels.length;
        report(`Found ${openaiModels.length} OpenAI models`);
      } catch (error) {
        result.openai.error = error instanceof Error ? error.message : 'Unknown error';
        report(`OpenAI error: ${result.openai.error}`);
      }
    } else {
      result.openai.error = 'No API key configured';
      report('OpenAI: No API key configured');
    }

    // Fetch Gemini models
    report('Fetching Gemini models...');
    const geminiKey = await localSecretService.get('GEMINI_API_KEY')
      || await localSecretService.get('GOOGLE_API_KEY');
    if (geminiKey) {
      try {
        const geminiModels = await fetchGeminiModels(geminiKey);
        for (const id of geminiModels) {
          models.push(createModelInfo(id, 'google'));
        }
        result.gemini.found = geminiModels.length;
        report(`Found ${geminiModels.length} Gemini models`);
      } catch (error) {
        result.gemini.error = error instanceof Error ? error.message : 'Unknown error';
        report(`Gemini error: ${result.gemini.error}`);
      }
    } else {
      result.gemini.error = 'No API key configured';
      report('Gemini: No API key configured');
    }

    // Fetch Anthropic models
    report('Fetching Anthropic models...');
    const anthropicKey = await localSecretService.get('ANTHROPIC_API_KEY');
    if (anthropicKey) {
      try {
        const anthropicModels = await fetchAnthropicModels(anthropicKey);
        for (const model of anthropicModels) {
          models.push(createAnthropicModelInfo(model));
        }
        result.anthropic.found = anthropicModels.length;
        report(`Found ${anthropicModels.length} Anthropic models`);
      } catch (error) {
        result.anthropic.error = error instanceof Error ? error.message : 'Unknown error';
        report(`Anthropic error: ${result.anthropic.error}`);
      }
    } else {
      result.anthropic.error = 'No API key configured';
      report('Anthropic: No API key configured');
    }

    // Fetch Ollama models (local, no API key needed)
    report('Fetching Ollama models...');
    let ollamaDefaultModel = 'llama3.2'; // fallback default
    try {
      const ollamaModels = await fetchOllamaModels();
      for (const model of ollamaModels) {
        models.push(createOllamaModelInfo(model));
      }
      result.ollama.found = ollamaModels.length;
      report(`Found ${ollamaModels.length} Ollama models`);
      // Use first available model as default
      const firstModel = ollamaModels[0];
      if (firstModel) {
        ollamaDefaultModel = firstModel.name;
      }
    } catch (error) {
      result.ollama.error = error instanceof Error ? error.message : 'Unknown error';
      report(`Ollama error: ${result.ollama.error}`);
    }

    // Build the config
    const config: ModelsConfig = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      defaults: {
        fast: 'claude-haiku-4-5-20251001',
        smart: 'claude-opus-4-5-20251101',
        code: 'claude-sonnet-4-5-20250929',
        balanced: 'claude-sonnet-4-5-20250929',
        cheap: 'gemini-2.0-flash-lite',
        vision: 'gpt-4o',
      },
      providerDefaults: {
        anthropic: 'claude-opus-4-5-20251101',
        openai: 'gpt-4o',
        google: 'gemini-2.0-flash',
        ollama: ollamaDefaultModel,
        custom: '',
      },
      models,
    };

    // Write to file
    report(`Saving ${models.length} models to ${MODELS_FILE}...`);
    await writeFile(MODELS_FILE, JSON.stringify(config, null, 2));

    result.success = true;
    result.total = models.length;
    report(`Done! Saved ${models.length} models.`);

    return result;
  } catch (error) {
    log(`Error refreshing models: ${error}`);
    throw error;
  }
}

/**
 * Load models from ~/.ultra/models.json.
 * If the user's file doesn't exist, copies the bundled config first.
 * Dynamically fetches Ollama models and merges them with the config.
 */
export async function loadModels(): Promise<ModelsConfig> {
  let config: ModelsConfig;

  // Ensure ~/.ultra directory exists
  await mkdir(ULTRA_DIR, { recursive: true });

  // Check if user's models.json exists
  let userModelsExist = false;
  try {
    await access(MODELS_FILE);
    userModelsExist = true;
  } catch {
    // File doesn't exist
  }

  // If user's models.json doesn't exist, copy from bundled config
  if (!userModelsExist) {
    try {
      await copyFile(BUNDLED_MODELS_FILE, MODELS_FILE);
      log(`Copied bundled models to ${MODELS_FILE}`);
    } catch (err) {
      log(`Failed to copy bundled models: ${err}`);
    }
  }

  // Now load from user's models.json (which may have just been created)
  try {
    const content = await readFile(MODELS_FILE, 'utf-8');
    log(`Loaded models from ${MODELS_FILE}`);
    config = JSON.parse(content);
  } catch {
    // Fallback to minimal config if everything fails
    log('Failed to load models, using minimal fallback');
    config = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      defaults: {
        fast: 'claude-3-5-haiku-20241022',
        smart: 'claude-opus-4-5-20251101',
        code: 'claude-sonnet-4-20250514',
        balanced: 'claude-sonnet-4-20250514',
        cheap: 'gemini-2.0-flash-lite',
        vision: 'gpt-4o',
      },
      providerDefaults: {
        anthropic: 'claude-opus-4-5-20251101',
        openai: 'gpt-4o',
        google: 'gemini-2.0-flash',
        ollama: 'llama3.2',
        custom: '',
      },
      models: [],
    };
  }

  // Dynamically fetch and merge Ollama models
  try {
    const ollamaModels = await fetchOllamaModels();
    if (ollamaModels.length > 0) {
      // Remove existing ollama models from config
      config.models = config.models.filter(m => m.provider !== 'ollama');

      // Add fresh ollama models
      for (const model of ollamaModels) {
        config.models.push(createOllamaModelInfo(model));
      }

      // Update ollama default to first available model
      const firstModel = ollamaModels[0];
      if (firstModel) {
        config.providerDefaults.ollama = firstModel.name;
      }

      log(`Merged ${ollamaModels.length} Ollama models`);
    }
  } catch (error) {
    // Ollama not available, keep existing ollama models in config
    log(`Could not fetch Ollama models: ${error}`);
  }

  // Add Agent SDK models (uses local subscription via claude-agent-sdk)
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    // SDK is available — add agent-sdk models if not already present
    const agentSdkModels = [
      { id: 'agent-sdk:claude-opus-4-6', name: 'Agent SDK: Opus 4.6' },
      { id: 'agent-sdk:claude-sonnet-4-5-20250929', name: 'Agent SDK: Sonnet 4.5' },
      { id: 'agent-sdk:claude-haiku-4-5-20251001', name: 'Agent SDK: Haiku 4.5' },
    ];

    // Remove existing agent-sdk models to refresh
    config.models = config.models.filter(m => m.provider !== 'agent-sdk');

    for (const model of agentSdkModels) {
      config.models.push(createModelInfo(model.id, 'agent-sdk'));
    }

    if (!config.providerDefaults['agent-sdk']) {
      config.providerDefaults['agent-sdk'] = 'agent-sdk:claude-sonnet-4-5-20250929';
    }

    log(`Added ${agentSdkModels.length} Agent SDK models`);
  } catch {
    // Agent SDK not installed, skip
    log('Agent SDK not available, skipping agent-sdk models');
  }

  return config;
}

/**
 * Get a specific model by ID.
 */
export async function getModel(id: string): Promise<ModelInfo | undefined> {
  const config = await loadModels();
  return config.models.find(m => m.id === id);
}

/**
 * Get models for a specific provider.
 */
export async function getModelsForProvider(
  provider: ModelInfo['provider']
): Promise<ModelInfo[]> {
  const config = await loadModels();
  return config.models.filter(m => m.provider === provider);
}

/**
 * Get the path to the user's models.json file.
 */
export function getModelsFilePath(): string {
  return MODELS_FILE;
}
