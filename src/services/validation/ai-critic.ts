/**
 * AI Critic Validator
 *
 * Uses LLMs to review code changes and provide feedback.
 * Integrates hierarchical context into prompts and parses structured responses.
 */

import type {
  ValidationResult,
  ValidationContext,
  ValidatorDefinition,
  HierarchicalContext,
  ValidationDetails,
} from './types.ts';
import type { AIProviderType, AIResponse } from '../ai/types.ts';
import { createProvider, createHTTPProvider, type AIProvider, type ChatCompletionRequest } from '../ai/providers/index.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

/**
 * AI critic response format.
 * This is the structured schema that AI critics must return.
 */
export interface AICriticResponse {
  /** Whether the changes are approved (explicit boolean for clarity) */
  approved: boolean;
  /** Overall status */
  status: 'approved' | 'rejected' | 'needs-revision';
  /** Severity of issues */
  severity: 'error' | 'warning' | 'info' | 'suggestion';
  /** Summary message */
  message: string;
  /** Detailed issues */
  details?: Array<{
    file?: string;
    line?: number;
    column?: number;
    issue: string;
    suggestion?: string;
    /** Whether this specific issue blocks approval */
    blocking?: boolean;
  }>;
  /** Reasoning for the decision */
  reasoning?: string;
  /** Confidence score (0-1) for the assessment */
  confidence?: number;
}

/**
 * AI critic configuration.
 */
export interface AICriticConfig {
  /** AI provider type */
  provider: AIProviderType;
  /** Model to use */
  model?: string;
  /** API key (optional, uses environment if not provided) */
  apiKey?: string;
  /** Base URL for custom endpoints */
  baseUrl?: string;
  /** System prompt for the critic */
  systemPrompt: string;
  /** Maximum tokens for response */
  maxTokens?: number;
  /** Temperature for generation */
  temperature?: number;
}

/**
 * Run an AI critic validator.
 */
export async function runAICritic(
  validator: ValidatorDefinition,
  context: ValidationContext
): Promise<ValidationResult> {
  const startTime = Date.now();

  // Validate configuration
  if (!validator.provider || !validator.systemPrompt) {
    return {
      status: 'skipped',
      validator: validator.id,
      severity: 'warning',
      message: 'AI critic requires provider and systemPrompt configuration',
      durationMs: 0,
      cached: false,
    };
  }

  try {
    // Create AI provider - prefer HTTP API for critics (more reliable than CLI)
    const providerConfig = {
      type: validator.provider,
      name: validator.name,
      model: validator.model,
      apiKey: validator.apiKey,
      baseUrl: validator.baseUrl,
    };

    // Try HTTP provider first (for OpenAI, Gemini)
    let provider = createHTTPProvider(providerConfig);

    // Fall back to CLI provider if HTTP not available
    if (!provider) {
      provider = createProvider(providerConfig);
    }

    if (!provider) {
      return {
        status: 'skipped',
        validator: validator.id,
        severity: 'warning',
        message: `AI provider '${validator.provider}' is not registered`,
        durationMs: 0,
        cached: false,
      };
    }

    // Check if provider is available
    if (!(await provider.isAvailable())) {
      return {
        status: 'skipped',
        validator: validator.id,
        severity: 'warning',
        message: `AI provider '${validator.provider}' is not available`,
        durationMs: 0,
        cached: false,
      };
    }

    // Build the prompt with context
    const prompt = buildCriticPrompt(validator, context);

    log(`Running AI critic: ${validator.id}`);
    log(`Prompt length: ${prompt.length} characters`);

    // Make the AI request
    const response = await makeAIRequest(provider, validator, prompt);

    // Parse the response
    const criticResponse = parseAIResponse(response);
    const durationMs = Date.now() - startTime;

    // Convert to validation result
    return convertToValidationResult(validator, criticResponse, durationMs);
  } catch (error) {
    return {
      status: 'rejected',
      validator: validator.id,
      severity: 'error',
      message: `AI critic error: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startTime,
      cached: false,
    };
  }
}

/**
 * Build the prompt for the AI critic.
 */
export function buildCriticPrompt(validator: ValidatorDefinition, context: ValidationContext): string {
  const sections: string[] = [];

  // Add system prompt
  sections.push(validator.systemPrompt!);
  sections.push('');

  // Add hierarchical context if available
  const hierarchicalContext = getMergedHierarchicalContext(context);
  if (hierarchicalContext) {
    sections.push('## Project Patterns to Enforce\n');
    if (hierarchicalContext.patterns.length > 0) {
      sections.push(
        hierarchicalContext.patterns.map((p) => `- ${p.description}`).join('\n')
      );
      sections.push('');
    }

    if (hierarchicalContext.antiPatterns.length > 0) {
      sections.push('## Anti-Patterns to Flag\n');
      sections.push(
        hierarchicalContext.antiPatterns
          .map((ap) => `- DO NOT USE: ${ap.pattern}\n  Instead: ${ap.alternative}`)
          .join('\n\n')
      );
      sections.push('');
    }

    if (hierarchicalContext.conventions.length > 0) {
      sections.push('## Conventions\n');
      sections.push(
        hierarchicalContext.conventions.map((c) => `- ${c.description}`).join('\n')
      );
      sections.push('');
    }

    if (hierarchicalContext.architectureNotes) {
      sections.push('## Architecture Context\n');
      sections.push(hierarchicalContext.architectureNotes);
      sections.push('');
    }
  }

  // Add the changes to review
  sections.push('---\n');
  sections.push('## Changes to Review\n');

  for (const file of context.files) {
    sections.push(`### File: ${file.path}\n`);

    if (file.diff) {
      sections.push('#### Changes (diff):\n```diff');
      sections.push(file.diff);
      sections.push('```\n');
    }

    if (validator.contextConfig?.includeFullFile && file.content) {
      const extension = file.path.split('.').pop() || '';
      sections.push(`#### Full File:\n\`\`\`${extension}`);
      // Truncate large files
      const maxLength = 10000;
      if (file.content.length > maxLength) {
        sections.push(file.content.substring(0, maxLength));
        sections.push(`\n... (truncated, ${file.content.length - maxLength} more characters)`);
      } else {
        sections.push(file.content);
      }
      sections.push('```\n');
    }
  }

  // Add git diff if available
  if (context.gitDiff && validator.contextConfig?.includeGitDiff) {
    sections.push('### Git Diff:\n```diff');
    sections.push(context.gitDiff);
    sections.push('```\n');
  }

  // Add response format instructions
  sections.push('---\n');
  sections.push('## Response Format\n');
  sections.push('You MUST respond with a valid JSON object in this exact format:');
  sections.push('```json');
  sections.push(JSON.stringify(
    {
      approved: true,
      status: 'approved | rejected | needs-revision',
      severity: 'error | warning | info | suggestion',
      message: 'Brief summary of your review',
      confidence: 0.95,
      details: [
        {
          file: 'path/to/file.ts',
          line: 123,
          issue: 'Description of the issue',
          suggestion: 'How to fix it',
          blocking: false,
        },
      ],
      reasoning: 'Your overall reasoning for the decision',
    },
    null,
    2
  ));
  sections.push('```');
  sections.push('\nIMPORTANT:');
  sections.push('- "approved" MUST be a boolean (true/false) indicating your final verdict');
  sections.push('- "status" describes the overall state: "approved" if changes are good, "rejected" if they should not be merged, "needs-revision" if minor fixes needed');
  sections.push('- "confidence" is your confidence in this assessment (0.0 to 1.0)');
  sections.push('- "blocking" in details indicates if that specific issue must be fixed before approval');

  return sections.join('\n');
}

/**
 * Make an AI request.
 */
async function makeAIRequest(
  provider: AIProvider,
  validator: ValidatorDefinition,
  prompt: string
): Promise<AIResponse> {
  const request: ChatCompletionRequest = {
    messages: [
      {
        id: 'user-msg',
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        timestamp: Date.now(),
      },
    ],
    systemPrompt: 'You are a code review expert. Analyze code changes and provide structured feedback in JSON format.',
    maxTokens: validator.maxTokens ?? 4096,
    temperature: validator.temperature ?? 0.3,
  };

  return provider.chat(request);
}

/**
 * Parse the AI response into structured format.
 */
function parseAIResponse(response: AIResponse): AICriticResponse {
  const text = getResponseText(response);

  // Try to extract JSON from the response
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1]! : text;

  try {
    // Try to parse as JSON
    const parsed = JSON.parse(jsonStr.trim());
    return normalizeAIResponse(parsed);
  } catch {
    // If JSON parsing fails, try to extract status from text
    return parseTextResponse(text);
  }
}

/**
 * Get text from AI response.
 */
function getResponseText(response: AIResponse): string {
  const textContent = response.message.content.find((c) => c.type === 'text');
  if (textContent && textContent.type === 'text') {
    return textContent.text;
  }
  return '';
}

/**
 * Normalize an AI response to ensure valid structure.
 */
function normalizeAIResponse(parsed: Record<string, unknown>): AICriticResponse {
  const validStatuses = ['approved', 'rejected', 'needs-revision'];
  const validSeverities = ['error', 'warning', 'info', 'suggestion'];

  let status = String(parsed.status ?? 'needs-revision');
  if (!validStatuses.includes(status)) {
    status = 'needs-revision';
  }

  let severity = String(parsed.severity ?? 'warning');
  if (!validSeverities.includes(severity)) {
    severity = 'warning';
  }

  // Derive approved from explicit field or status
  const approved = typeof parsed.approved === 'boolean'
    ? parsed.approved
    : status === 'approved';

  // Parse confidence (0-1 range)
  let confidence: number | undefined;
  if (typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1) {
    confidence = parsed.confidence;
  }

  return {
    approved,
    status: status as AICriticResponse['status'],
    severity: severity as AICriticResponse['severity'],
    message: String(parsed.message ?? 'Review completed'),
    confidence,
    details: Array.isArray(parsed.details)
      ? parsed.details.map((d: Record<string, unknown>) => ({
          file: d.file ? String(d.file) : undefined,
          line: typeof d.line === 'number' ? d.line : undefined,
          column: typeof d.column === 'number' ? d.column : undefined,
          issue: String(d.issue ?? d.message ?? ''),
          suggestion: d.suggestion ? String(d.suggestion) : undefined,
          blocking: typeof d.blocking === 'boolean' ? d.blocking : undefined,
        }))
      : undefined,
    reasoning: parsed.reasoning ? String(parsed.reasoning) : undefined,
  };
}

/**
 * Parse a text response when JSON parsing fails.
 */
function parseTextResponse(text: string): AICriticResponse {
  const lower = text.toLowerCase();

  // Try to detect status from keywords
  let status: AICriticResponse['status'] = 'needs-revision';
  let severity: AICriticResponse['severity'] = 'warning';
  let approved = false;

  if (lower.includes('approve') && !lower.includes('not approve')) {
    status = 'approved';
    severity = 'info';
    approved = true;
  } else if (lower.includes('reject') || lower.includes('error') || lower.includes('critical')) {
    status = 'rejected';
    severity = 'error';
    approved = false;
  }

  return {
    approved,
    status,
    severity,
    message: text.substring(0, 200) + (text.length > 200 ? '...' : ''),
    reasoning: text,
  };
}

/**
 * Convert AI critic response to validation result.
 */
function convertToValidationResult(
  validator: ValidatorDefinition,
  response: AICriticResponse,
  durationMs: number
): ValidationResult {
  const details: ValidationDetails | undefined = response.details?.[0]
    ? {
        file: response.details[0].file,
        line: response.details[0].line,
        column: response.details[0].column,
        suggestedFix: response.details[0].suggestion,
        reasoning: response.reasoning,
      }
    : response.reasoning
      ? { reasoning: response.reasoning }
      : undefined;

  return {
    status: response.status,
    validator: validator.id,
    severity: response.severity,
    message: response.message,
    durationMs,
    cached: false,
    details,
    metadata: {
      allIssues: response.details,
      issueCount: response.details?.length ?? 0,
    },
  };
}

/**
 * Get merged hierarchical context from all files.
 */
function getMergedHierarchicalContext(context: ValidationContext): HierarchicalContext | null {
  const merged: HierarchicalContext = {
    patterns: [],
    antiPatterns: [],
    conventions: [],
    architectureNotes: '',
    overrides: [],
  };

  let hasContext = false;

  for (const file of context.files) {
    if (file.hierarchicalContext) {
      hasContext = true;
      merged.patterns.push(...file.hierarchicalContext.patterns);
      merged.antiPatterns.push(...file.hierarchicalContext.antiPatterns);
      merged.conventions.push(...file.hierarchicalContext.conventions);

      if (file.hierarchicalContext.architectureNotes) {
        if (merged.architectureNotes) {
          merged.architectureNotes += '\n\n' + file.hierarchicalContext.architectureNotes;
        } else {
          merged.architectureNotes = file.hierarchicalContext.architectureNotes;
        }
      }
    }
  }

  if (!hasContext) {
    return null;
  }

  // Deduplicate by ID
  merged.patterns = deduplicateById(merged.patterns);
  merged.antiPatterns = deduplicateById(merged.antiPatterns);
  merged.conventions = deduplicateById(merged.conventions);

  return merged;
}

/**
 * Deduplicate items by ID.
 */
function deduplicateById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

/**
 * Create a code review critic validator.
 */
export function createCodeReviewCritic(
  options: Partial<Omit<ValidatorDefinition, 'provider'>> & { provider: AIProviderType }
): ValidatorDefinition {
  const { provider, ...rest } = options;
  return {
    id: 'code-review-critic',
    name: 'Code Review',
    type: 'ai-critic',
    enabled: true,
    priority: 50,
    provider,
    model: rest.model,
    systemPrompt: rest.systemPrompt ?? `You are a senior code reviewer. Analyze the proposed changes and provide feedback on:
- Code quality and maintainability
- Potential bugs or edge cases
- Performance implications
- Adherence to project patterns and conventions

Be constructive and specific. If changes are acceptable, approve them.
If issues exist, explain clearly and suggest improvements.`,
    triggers: ['pre-write'],
    contextConfig: {
      includeFullFile: true,
      includeDiff: true,
      includeGitDiff: true,
      includeRelatedFiles: false,
      relatedFileDepth: 0,
      ...rest.contextConfig,
    },
    behavior: {
      onFailure: 'warning',
      blockOnFailure: false,
      required: false,
      timeoutMs: 60000,
      onTimeout: 'warning',
      cacheable: true,
      ...rest.behavior,
    },
    ...rest,
  };
}

/**
 * Create a security critic validator.
 */
export function createSecurityCritic(
  options: Partial<Omit<ValidatorDefinition, 'provider'>> & { provider: AIProviderType }
): ValidatorDefinition {
  const { provider, ...rest } = options;
  return {
    id: 'security-critic',
    name: 'Security Review',
    type: 'ai-critic',
    enabled: true,
    priority: 30,
    provider,
    model: rest.model,
    systemPrompt: rest.systemPrompt ?? `You are a security expert. Review the proposed changes for:
- Injection vulnerabilities (SQL, command, XSS)
- Authentication/authorization issues
- Sensitive data exposure
- Cryptographic weaknesses
- OWASP Top 10 vulnerabilities

Flag any security concerns with severity ratings. Be thorough but avoid false positives.`,
    triggers: ['pre-write', 'pre-commit'],
    contextConfig: {
      includeFullFile: true,
      includeDiff: true,
      includeGitDiff: true,
      includeRelatedFiles: true,
      relatedFileDepth: 1,
      ...rest.contextConfig,
    },
    behavior: {
      onFailure: 'error',
      blockOnFailure: true,
      required: true,
      timeoutMs: 90000,
      onTimeout: 'error',
      cacheable: true,
      ...rest.behavior,
    },
    ...rest,
  };
}

/**
 * Create an architecture critic validator.
 */
export function createArchitectureCritic(
  options: Partial<Omit<ValidatorDefinition, 'provider'>> & { provider: AIProviderType }
): ValidatorDefinition {
  const { provider, ...rest } = options;
  return {
    id: 'architecture-critic',
    name: 'Architecture Review',
    type: 'ai-critic',
    enabled: true,
    priority: 70,
    provider,
    model: rest.model,
    systemPrompt: rest.systemPrompt ?? `You are a software architect. Evaluate the changes from an architectural perspective:
- Modularity and separation of concerns
- Coupling between components
- Consistency with existing architecture
- Scalability implications
- Design patterns usage

Focus on significant architectural issues, not minor code style concerns.`,
    triggers: ['pre-commit'],
    contextConfig: {
      includeFullFile: true,
      includeDiff: true,
      includeGitDiff: true,
      includeRelatedFiles: true,
      relatedFileDepth: 2,
      ...rest.contextConfig,
    },
    behavior: {
      onFailure: 'warning',
      blockOnFailure: false,
      required: false,
      timeoutMs: 120000,
      onTimeout: 'warning',
      cacheable: true,
      weight: 2, // Higher weight in consensus
      ...rest.behavior,
    },
    ...rest,
  };
}

function log(msg: string): void {
  if (isDebugEnabled()) {
    debugLog(`[AICritic] ${msg}`);
  }
}
