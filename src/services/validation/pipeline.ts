/**
 * Validation Pipeline
 *
 * Orchestrates validation middleware execution.
 * Supports static validators, AI critics, and consensus mechanisms.
 */

import type {
  ValidationTrigger,
  ValidationContext,
  ValidationResult,
  ValidationSummary,
  ValidatorDefinition,
  ValidatorBehavior,
  ValidationPipelineConfig,
  ConsensusResult,
  OverallValidationStatus,
} from './types.ts';
import { ValidationCache } from './cache.ts';
import { ContextResolver } from './context-resolver.ts';
import { TimeoutError } from './errors.ts';
import { runStaticValidator as executeStaticValidator } from './static-validator.ts';
import { runAICritic as executeAICritic } from './ai-critic.ts';
import {
  HumanInteractionHandler,
  createApprovalRequest,
  type DecisionResponse,
} from './human-interaction.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

/**
 * Validation pipeline for orchestrating validators.
 */
export class ValidationPipeline {
  private config: ValidationPipelineConfig;
  private validators: Map<string, ValidatorDefinition> = new Map();
  private cache: ValidationCache;
  private contextResolver: ContextResolver;
  private humanHandler: HumanInteractionHandler | null = null;

  constructor(config: Partial<ValidationPipelineConfig> = {}) {
    this.config = {
      executionModel: config.executionModel ?? 'turn-based',
      defaultTimeout: config.defaultTimeout ?? 30000,
      cacheEnabled: config.cacheEnabled ?? true,
      cacheMaxAge: config.cacheMaxAge ?? 5 * 60 * 1000,
      consensus: config.consensus ?? {
        strategy: 'majority',
        minimumResponses: 1,
        timeoutMs: 60000,
        escalateToHuman: true,
      },
      contextDir: config.contextDir ?? 'validation',
    };

    this.cache = new ValidationCache({
      maxAge: this.config.cacheMaxAge,
    });

    this.contextResolver = new ContextResolver({
      contextDir: this.config.contextDir,
      cacheEnabled: this.config.cacheEnabled,
    });
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[ValidationPipeline] ${msg}`);
    }
  }

  /**
   * Get pipeline configuration.
   */
  getConfig(): ValidationPipelineConfig {
    return { ...this.config };
  }

  /**
   * Update pipeline configuration.
   */
  setConfig(config: Partial<ValidationPipelineConfig>): void {
    this.config = { ...this.config, ...config };

    // Update cache if settings changed
    if (config.cacheMaxAge !== undefined) {
      this.cache = new ValidationCache({ maxAge: config.cacheMaxAge });
    }

    // Update context resolver if context dir changed
    if (config.contextDir !== undefined) {
      this.contextResolver = new ContextResolver({
        contextDir: config.contextDir,
        cacheEnabled: this.config.cacheEnabled,
      });
    }
  }

  /**
   * Register a validator.
   */
  registerValidator(validator: ValidatorDefinition): void {
    // Ensure behavior has defaults
    validator.behavior = {
      ...this.getDefaultBehavior(),
      ...validator.behavior,
    };

    this.validators.set(validator.id, validator);
    this.log(`Registered validator: ${validator.name} (${validator.id})`);
  }

  /**
   * Unregister a validator.
   */
  unregisterValidator(validatorId: string): boolean {
    const existed = this.validators.delete(validatorId);
    if (existed) {
      this.log(`Unregistered validator: ${validatorId}`);
    }
    return existed;
  }

  /**
   * Get a validator by ID.
   */
  getValidator(validatorId: string): ValidatorDefinition | undefined {
    return this.validators.get(validatorId);
  }

  /**
   * Get all registered validators.
   */
  getValidators(): ValidatorDefinition[] {
    return Array.from(this.validators.values());
  }

  /**
   * Set validator enabled state.
   */
  setValidatorEnabled(validatorId: string, enabled: boolean): boolean {
    const validator = this.validators.get(validatorId);
    if (!validator) return false;
    validator.enabled = enabled;
    this.log(`Set validator ${validatorId} enabled: ${enabled}`);
    return true;
  }

  /**
   * Run validation for a trigger.
   */
  async validate(
    trigger: ValidationTrigger,
    context: ValidationContext
  ): Promise<ValidationSummary> {
    this.log(`Running validation for trigger: ${trigger}`);

    // Get applicable validators
    const applicable = this.getApplicableValidators(trigger, context);
    this.log(`Found ${applicable.length} applicable validators`);

    if (applicable.length === 0) {
      return this.createEmptySummary();
    }

    // Resolve hierarchical context for files
    await this.resolveHierarchicalContext(context);

    // Execute validators
    const results = await this.executeValidators(applicable, context);

    // Aggregate results
    return this.aggregateResults(results, applicable);
  }

  /**
   * Validate files before writing.
   */
  async validatePreWrite(
    files: Array<{ path: string; content: string; diff?: string }>,
    sessionId: string
  ): Promise<ValidationSummary> {
    const context: ValidationContext = {
      trigger: 'pre-write',
      timestamp: Date.now(),
      files: files.map((f) => ({
        path: f.path,
        content: f.content,
        diff: f.diff,
      })),
      sessionId,
    };

    return this.validate('pre-write', context);
  }

  /**
   * Validate before commit.
   */
  async validatePreCommit(
    gitDiff: string,
    changedFiles: string[],
    sessionId: string
  ): Promise<ValidationSummary> {
    // Load file contents
    const files = await Promise.all(
      changedFiles.map(async (path) => {
        try {
          const content = await Bun.file(path).text();
          return { path, content };
        } catch {
          return { path, content: '' };
        }
      })
    );

    const context: ValidationContext = {
      trigger: 'pre-commit',
      timestamp: Date.now(),
      files,
      gitDiff,
      sessionId,
    };

    return this.validate('pre-commit', context);
  }

  /**
   * Get validators applicable to a trigger and context.
   */
  private getApplicableValidators(
    trigger: ValidationTrigger,
    context: ValidationContext
  ): ValidatorDefinition[] {
    return Array.from(this.validators.values())
      .filter((v) => {
        // Must be enabled
        if (!v.enabled) return false;

        // Must support this trigger
        if (!v.triggers.includes(trigger)) return false;

        // Must match file patterns (if specified)
        if (v.filePatterns && v.filePatterns.length > 0) {
          const hasMatchingFile = context.files.some((file) =>
            this.matchesFilePatterns(file.path, v.filePatterns!)
          );
          if (!hasMatchingFile) return false;
        }

        return true;
      })
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Check if a file path matches any of the patterns.
   */
  private matchesFilePatterns(filePath: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (this.matchGlob(filePath, pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Simple glob matching.
   */
  private matchGlob(path: string, pattern: string): boolean {
    // Handle **/*.ext pattern specially - it should match files at any level
    if (pattern.startsWith('**/')) {
      // Pattern like **/*.ts should match both "test.ts" and "src/test.ts"
      const suffix = pattern.slice(3); // Remove **/
      // Try matching with the suffix directly (root level)
      if (this.matchGlob(path, suffix)) {
        return true;
      }
      // Also try with a path separator
      const regexSuffix = suffix
        .replace(/\./g, '\\.')
        .replace(/\*/g, '[^/]*');
      const regex = new RegExp(`(^|/)${regexSuffix}$`);
      return regex.test(path);
    }

    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(path);
  }

  /**
   * Resolve hierarchical context for all files.
   */
  private async resolveHierarchicalContext(context: ValidationContext): Promise<void> {
    for (const file of context.files) {
      try {
        file.hierarchicalContext = await this.contextResolver.resolveContext(file.path);
      } catch (error) {
        this.log(`Failed to resolve context for ${file.path}: ${error}`);
      }
    }
  }

  /**
   * Execute validators based on execution model.
   */
  private async executeValidators(
    validators: ValidatorDefinition[],
    context: ValidationContext
  ): Promise<ValidationResult[]> {
    if (this.config.executionModel === 'parallel') {
      return this.executeParallel(validators, context);
    } else {
      return this.executeTurnBased(validators, context);
    }
  }

  /**
   * Execute validators sequentially (turn-based).
   */
  private async executeTurnBased(
    validators: ValidatorDefinition[],
    context: ValidationContext
  ): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];

    for (const validator of validators) {
      // Check cache first
      if (this.config.cacheEnabled && validator.behavior.cacheable) {
        const cached = this.cache.get(validator.id, context);
        if (cached) {
          results.push({ ...cached, cached: true });
          continue;
        }
      }

      // Execute with timeout
      const result = await this.runValidatorWithTimeout(validator, context);
      results.push(result);

      // Cache if successful
      if (
        this.config.cacheEnabled &&
        validator.behavior.cacheable &&
        result.status !== 'timeout' &&
        result.status !== 'skipped'
      ) {
        this.cache.set(validator.id, context, result);
      }

      // Stop on blocking failure or required validator issue
      if (this.shouldStopExecution(validator, result)) {
        this.log(`Stopping execution due to ${validator.id}`);
        break;
      }
    }

    return results;
  }

  /**
   * Execute validators in parallel.
   */
  private async executeParallel(
    validators: ValidatorDefinition[],
    context: ValidationContext
  ): Promise<ValidationResult[]> {
    const promises = validators.map(async (validator) => {
      // Check cache first
      if (this.config.cacheEnabled && validator.behavior.cacheable) {
        const cached = this.cache.get(validator.id, context);
        if (cached) {
          return { ...cached, cached: true };
        }
      }

      const result = await this.runValidatorWithTimeout(validator, context);

      // Cache if successful
      if (
        this.config.cacheEnabled &&
        validator.behavior.cacheable &&
        result.status !== 'timeout' &&
        result.status !== 'skipped'
      ) {
        this.cache.set(validator.id, context, result);
      }

      return result;
    });

    return Promise.all(promises);
  }

  /**
   * Check if execution should stop.
   */
  private shouldStopExecution(
    validator: ValidatorDefinition,
    result: ValidationResult
  ): boolean {
    // Required validators stop on any issue
    if (validator.behavior.required) {
      return result.status !== 'approved';
    }

    // Otherwise, only stop on blocking failures
    return result.status === 'rejected' && validator.behavior.blockOnFailure;
  }

  /**
   * Run a validator with timeout handling.
   */
  private async runValidatorWithTimeout(
    validator: ValidatorDefinition,
    context: ValidationContext
  ): Promise<ValidationResult> {
    const startTime = Date.now();
    const timeoutMs = validator.behavior.timeoutMs ?? this.config.defaultTimeout;

    try {
      const result = await Promise.race([
        this.runValidator(validator, context),
        this.createTimeout(timeoutMs),
      ]);

      return {
        ...result,
        durationMs: Date.now() - startTime,
        cached: false,
      };
    } catch (error) {
      if (error instanceof TimeoutError) {
        return this.handleTimeout(validator, startTime);
      }

      return {
        status: 'rejected',
        validator: validator.id,
        severity: 'error',
        message: `Validator error: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: Date.now() - startTime,
        cached: false,
      };
    }
  }

  /**
   * Run a validator.
   */
  private async runValidator(
    validator: ValidatorDefinition,
    context: ValidationContext
  ): Promise<ValidationResult> {
    this.log(`Running validator: ${validator.name}`);

    switch (validator.type) {
      case 'static':
        return this.runStaticValidator(validator, context);

      case 'ai-critic':
        return this.runAICriticValidator(validator, context);

      case 'custom':
        if (validator.validate) {
          return validator.validate(context);
        }
        return {
          status: 'skipped',
          validator: validator.id,
          severity: 'warning',
          message: 'Custom validator has no validate function',
          durationMs: 0,
          cached: false,
        };

      case 'composite':
        return this.runCompositeValidator(validator, context);

      default:
        return {
          status: 'skipped',
          validator: validator.id,
          severity: 'warning',
          message: `Unknown validator type: ${validator.type}`,
          durationMs: 0,
          cached: false,
        };
    }
  }

  /**
   * Run a static validator (shell command).
   * Delegates to the static-validator module for proper output parsing.
   */
  private async runStaticValidator(
    validator: ValidatorDefinition,
    context: ValidationContext
  ): Promise<ValidationResult> {
    return executeStaticValidator(validator, context);
  }

  /**
   * Run an AI critic validator.
   * Delegates to the ai-critic module for proper prompt building and response parsing.
   */
  private async runAICriticValidator(
    validator: ValidatorDefinition,
    context: ValidationContext
  ): Promise<ValidationResult> {
    return executeAICritic(validator, context);
  }

  /**
   * Run a composite validator (combines children).
   */
  private async runCompositeValidator(
    validator: ValidatorDefinition,
    context: ValidationContext
  ): Promise<ValidationResult> {
    if (!validator.children || validator.children.length === 0) {
      return {
        status: 'skipped',
        validator: validator.id,
        severity: 'warning',
        message: 'Composite validator has no children',
        durationMs: 0,
        cached: false,
      };
    }

    const startTime = Date.now();
    const childValidators = validator.children
      .map((id) => this.validators.get(id))
      .filter((v): v is ValidatorDefinition => v !== undefined);

    const results = await this.executeValidators(childValidators, context);

    // Aggregate child results
    const hasRejection = results.some((r) => r.status === 'rejected');
    const hasNeedsRevision = results.some((r) => r.status === 'needs-revision');
    const allApproved = results.every(
      (r) => r.status === 'approved' || r.status === 'skipped'
    );

    let status: ValidationResult['status'];
    if (allApproved) {
      status = 'approved';
    } else if (hasRejection) {
      status = 'rejected';
    } else if (hasNeedsRevision) {
      status = 'needs-revision';
    } else {
      status = 'skipped';
    }

    return {
      status,
      validator: validator.id,
      severity: hasRejection ? 'error' : hasNeedsRevision ? 'warning' : 'info',
      message: `Composite: ${results.length} child validators, ${results.filter((r) => r.status === 'approved').length} approved`,
      durationMs: Date.now() - startTime,
      cached: false,
      metadata: { childResults: results },
    };
  }

  /**
   * Create a timeout promise.
   */
  private createTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new TimeoutError(`Validator timed out after ${ms}ms`));
      }, ms);
    });
  }

  /**
   * Handle validator timeout.
   */
  private handleTimeout(
    validator: ValidatorDefinition,
    startTime: number
  ): ValidationResult {
    const onTimeout = validator.behavior.onTimeout;
    const durationMs = Date.now() - startTime;

    this.log(`Validator ${validator.id} timed out`);

    return {
      validator: validator.id,
      status: onTimeout === 'skip' ? 'skipped' : 'timeout',
      severity: onTimeout === 'error' ? 'error' : 'warning',
      message: `Validator timed out after ${validator.behavior.timeoutMs}ms`,
      durationMs,
      cached: false,
    };
  }

  /**
   * Aggregate results into a summary.
   */
  private aggregateResults(
    results: ValidationResult[],
    validators: ValidatorDefinition[]
  ): ValidationSummary {
    const errors = results.filter((r) => r.severity === 'error');
    const warnings = results.filter((r) => r.severity === 'warning');

    // Check for blocking validators
    const blockedBy: string[] = [];
    for (const result of results) {
      const validator = validators.find((v) => v.id === result.validator);
      if (!validator) continue;

      if (
        (validator.behavior.required && result.status !== 'approved') ||
        (validator.behavior.blockOnFailure && result.status === 'rejected')
      ) {
        blockedBy.push(validator.id);
      }
    }

    // Evaluate consensus
    const consensusResult = this.evaluateConsensus(results, validators);

    // Determine overall status
    let overallStatus: OverallValidationStatus;
    if (blockedBy.length > 0) {
      overallStatus = 'blocked';
    } else if (results.every((r) => r.status === 'approved' || r.status === 'skipped')) {
      overallStatus = 'approved';
    } else if (results.some((r) => r.status === 'rejected')) {
      overallStatus = 'rejected';
    } else if (results.some((r) => r.status === 'needs-revision')) {
      overallStatus = 'needs-revision';
    } else {
      overallStatus = 'approved';
    }

    // Determine if human decision is needed
    const requiresHumanDecision =
      (blockedBy.length > 0 && this.config.consensus.escalateToHuman) ||
      (!consensusResult.reached && this.config.consensus.escalateToHuman);

    return {
      overallStatus,
      results,
      requiresHumanDecision,
      consensusReached: consensusResult.reached,
      blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
      warnings,
      errors,
    };
  }

  /**
   * Evaluate consensus among validators.
   */
  private evaluateConsensus(
    results: ValidationResult[],
    validators: ValidatorDefinition[]
  ): ConsensusResult {
    const validResults = results.filter(
      (r) => r.status !== 'skipped' && r.status !== 'timeout'
    );

    if (validResults.length < this.config.consensus.minimumResponses) {
      return { reached: false, reason: 'insufficient-responses' };
    }

    const strategy = this.config.consensus.strategy;

    switch (strategy) {
      case 'unanimous':
        return {
          reached: validResults.every((r) => r.status === 'approved'),
          approved: validResults.every((r) => r.status === 'approved'),
        };

      case 'majority': {
        const approvals = validResults.filter((r) => r.status === 'approved').length;
        return {
          reached: true,
          approved: approvals > validResults.length / 2,
        };
      }

      case 'any-approve':
        return {
          reached: true,
          approved: validResults.some((r) => r.status === 'approved'),
        };

      case 'no-rejections':
        return {
          reached: true,
          approved: !validResults.some((r) => r.status === 'rejected'),
        };

      case 'weighted': {
        const weights = new Map<string, number>();
        for (const v of validators) {
          weights.set(v.id, v.behavior.weight ?? 1);
        }

        const weightedApprovals = validResults
          .filter((r) => r.status === 'approved')
          .reduce((sum, r) => sum + (weights.get(r.validator) ?? 1), 0);

        const totalWeight = validResults.reduce(
          (sum, r) => sum + (weights.get(r.validator) ?? 1),
          0
        );

        return {
          reached: true,
          approved: weightedApprovals > totalWeight / 2,
        };
      }

      default:
        return { reached: false, reason: 'unknown-strategy' };
    }
  }

  /**
   * Create an empty validation summary.
   */
  private createEmptySummary(): ValidationSummary {
    return {
      overallStatus: 'approved',
      results: [],
      requiresHumanDecision: false,
      consensusReached: true,
      warnings: [],
      errors: [],
    };
  }

  /**
   * Get default validator behavior.
   */
  private getDefaultBehavior(): ValidatorBehavior {
    return {
      onFailure: 'warning',
      blockOnFailure: false,
      required: false,
      timeoutMs: this.config.defaultTimeout,
      onTimeout: 'warning',
      cacheable: true,
    };
  }

  /**
   * Clear the validation cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Invalidate cache for a specific file.
   */
  invalidateCacheForFile(filePath: string): void {
    this.cache.invalidateByFile(filePath);
  }

  /**
   * Get the context resolver.
   */
  getContextResolver(): ContextResolver {
    return this.contextResolver;
  }

  /**
   * Set the human interaction handler.
   */
  setHumanHandler(handler: HumanInteractionHandler): void {
    this.humanHandler = handler;
    this.log('Human interaction handler set');
  }

  /**
   * Get the human interaction handler.
   */
  getHumanHandler(): HumanInteractionHandler | null {
    return this.humanHandler;
  }

  /**
   * Validate and wait for human approval if needed.
   * Returns the final summary after any human decisions.
   */
  async validateWithHumanApproval(
    trigger: ValidationTrigger,
    context: ValidationContext
  ): Promise<{ summary: ValidationSummary; decision?: DecisionResponse }> {
    const summary = await this.validate(trigger, context);

    // If no human decision needed or no handler, return as-is
    if (!summary.requiresHumanDecision || !this.humanHandler) {
      return { summary };
    }

    // Request human decision
    this.log('Requesting human decision');
    const decision = await createApprovalRequest(this.humanHandler, summary);

    // Update summary based on decision
    if (decision.decision === 'approve') {
      summary.overallStatus = 'approved';
      summary.requiresHumanDecision = false;
    } else if (decision.decision === 'reject') {
      summary.overallStatus = 'rejected';
      summary.requiresHumanDecision = false;
    }
    // 'defer' keeps the summary as-is

    return { summary, decision };
  }

  /**
   * Check if human approval is pending for a validation.
   */
  hasPendingHumanDecision(): boolean {
    return (this.humanHandler?.getPendingRequests().length ?? 0) > 0;
  }
}

/**
 * Create a new validation pipeline instance.
 */
export function createValidationPipeline(
  config?: Partial<ValidationPipelineConfig>
): ValidationPipeline {
  return new ValidationPipeline(config);
}
