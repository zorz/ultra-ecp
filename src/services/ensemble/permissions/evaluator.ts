/**
 * Permission Evaluator
 *
 * Evaluates permissions for tool operations with:
 * - Command pattern matching
 * - Risk level assessment
 * - Rule-based decisions
 */

import { debugLog, isDebugEnabled } from '../../../debug.ts';
import {
  getPermissionService,
  type PermissionCheckOptions,
} from '../../ai/permissions.ts';
import type {
  PermissionRule,
  PermissionEvaluation,
  RiskLevel,
  PermissionRequest,
  PermissionResponse,
} from './types.ts';
import {
  TOOL_RISK_LEVELS,
  DANGEROUS_COMMAND_PATTERNS,
  HIGH_RISK_COMMAND_PATTERNS,
} from './types.ts';

// ============================================
// Permission Evaluator
// ============================================

export class PermissionEvaluator {
  /** Custom rules added at runtime */
  private customRules: Map<string, PermissionRule> = new Map();

  /** Session ID for scoping */
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[PermissionEvaluator] ${msg}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Risk Assessment
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Assess the risk level of a bash command.
   * Parses compound commands and returns the highest risk level found.
   */
  assessBashRisk(command: string): RiskLevel {
    const trimmedCommand = command.trim();

    // Parse compound commands (&&, ||, ;, |) and check each part
    const commandParts = this.parseCompoundCommand(trimmedCommand);
    let highestRisk: RiskLevel = 'low';

    for (const part of commandParts) {
      const partRisk = this.assessSingleCommand(part);
      highestRisk = this.maxRiskLevel(highestRisk, partRisk);

      // Short-circuit if we hit dangerous
      if (highestRisk === 'dangerous') {
        this.log(`Command "${trimmedCommand}" contains dangerous subcommand: "${part}"`);
        return 'dangerous';
      }
    }

    if (highestRisk !== 'low' && highestRisk !== 'medium') {
      this.log(`Command "${trimmedCommand}" assessed as ${highestRisk}`);
    }

    return highestRisk;
  }

  /**
   * Parse a compound command into individual commands.
   * Handles &&, ||, ;, and | operators.
   */
  private parseCompoundCommand(command: string): string[] {
    // Split on command separators while preserving quoted strings
    // This is a simplified parser - a full shell parser would be more complex
    const parts: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let i = 0;

    while (i < command.length) {
      const char = command[i];
      const nextChar = command[i + 1];

      // Handle quotes
      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        current += char;
        i++;
        continue;
      }
      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        current += char;
        i++;
        continue;
      }

      // Skip operators inside quotes
      if (inSingleQuote || inDoubleQuote) {
        current += char;
        i++;
        continue;
      }

      // Check for command separators
      if ((char === '&' && nextChar === '&') || (char === '|' && nextChar === '|')) {
        // && or ||
        if (current.trim()) {
          parts.push(current.trim());
        }
        current = '';
        i += 2;
        continue;
      }
      if (char === ';' || char === '|') {
        // ; or single |
        if (current.trim()) {
          parts.push(current.trim());
        }
        current = '';
        i++;
        continue;
      }

      current += char;
      i++;
    }

    // Add the last part
    if (current.trim()) {
      parts.push(current.trim());
    }

    return parts.length > 0 ? parts : [command];
  }

  /**
   * Assess risk of a single command (not compound).
   */
  private assessSingleCommand(command: string): RiskLevel {
    const trimmed = command.trim();

    // Check dangerous patterns
    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(trimmed)) {
        return 'dangerous';
      }
    }

    // Check high-risk patterns
    for (const pattern of HIGH_RISK_COMMAND_PATTERNS) {
      if (pattern.test(trimmed)) {
        return 'high';
      }
    }

    // Check for specific command prefixes
    const commandPrefix = trimmed.split(/\s+/)[0] ?? '';
    const prefixRisk = TOOL_RISK_LEVELS[`Bash:${commandPrefix}`];
    if (prefixRisk) {
      return prefixRisk;
    }

    // Default bash risk
    return TOOL_RISK_LEVELS['Bash'] ?? 'medium';
  }

  /**
   * Compare risk levels and return the higher one.
   */
  private maxRiskLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
    const order: RiskLevel[] = ['safe', 'low', 'medium', 'high', 'dangerous'];
    const aIndex = order.indexOf(a);
    const bIndex = order.indexOf(b);
    return aIndex >= bIndex ? a : b;
  }

  /**
   * Assess the risk level of a file operation.
   */
  assessFileRisk(tool: string, path: string): RiskLevel {
    // Check for system paths
    if (path.startsWith('/etc/') || path.startsWith('/usr/') || path.startsWith('/bin/')) {
      return 'dangerous';
    }

    // Check for dotfiles/config
    const filename = path.split('/').pop() ?? '';
    if (filename.startsWith('.') && (tool === 'Write' || tool === 'Edit')) {
      return 'high';
    }

    // Default to tool's risk level
    return TOOL_RISK_LEVELS[tool] ?? 'low';
  }

  /**
   * Get the overall risk level for an operation.
   */
  getRiskLevel(tool: string, input?: string): RiskLevel {
    if (tool === 'Bash' && input) {
      return this.assessBashRisk(input);
    }

    if ((tool === 'Write' || tool === 'Edit' || tool === 'Read') && input) {
      return this.assessFileRisk(tool, input);
    }

    return TOOL_RISK_LEVELS[tool] ?? 'medium';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rule Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Add a custom permission rule.
   */
  addRule(rule: PermissionRule): void {
    this.customRules.set(rule.id, rule);
    this.log(`Added rule: ${rule.id} for ${rule.tool}`);
  }

  /**
   * Remove a custom rule.
   */
  removeRule(ruleId: string): boolean {
    const removed = this.customRules.delete(ruleId);
    if (removed) {
      this.log(`Removed rule: ${ruleId}`);
    }
    return removed;
  }

  /**
   * Get all custom rules.
   */
  getRules(): PermissionRule[] {
    return Array.from(this.customRules.values());
  }

  /**
   * Find a matching rule for the given tool and input.
   */
  findMatchingRule(tool: string, input?: string): PermissionRule | undefined {
    for (const rule of this.customRules.values()) {
      if (rule.tool !== tool) continue;

      // Check expiration
      if (rule.expiresAt && rule.expiresAt < Date.now()) {
        this.customRules.delete(rule.id);
        continue;
      }

      // If no pattern, match all for this tool
      if (!rule.pattern) {
        return rule;
      }

      // Pattern matching
      if (input && this.matchPattern(rule.pattern, input)) {
        return rule;
      }
    }

    return undefined;
  }

  /**
   * Match a pattern against input.
   * Supports glob-style patterns and regex.
   */
  private matchPattern(pattern: string, input: string): boolean {
    // If pattern starts with /, treat as regex
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      try {
        const regex = new RegExp(pattern.slice(1, -1));
        return regex.test(input);
      } catch {
        return false;
      }
    }

    // Otherwise treat as glob pattern
    const regexPattern = pattern
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(input);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Permission Evaluation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Evaluate whether an operation is permitted.
   */
  evaluate(tool: string, input?: string, targetPath?: string): PermissionEvaluation {
    const riskLevel = this.getRiskLevel(tool, input);

    // Safe operations are always allowed
    if (riskLevel === 'safe') {
      return {
        allowed: true,
        riskLevel,
        reason: 'Safe operation (read-only)',
        requiresConfirmation: false,
        requiresDoubleConfirmation: false,
      };
    }

    // Check custom rules first
    const matchingRule = this.findMatchingRule(tool, input);
    if (matchingRule) {
      if (matchingRule.action === 'allow') {
        return {
          allowed: true,
          riskLevel: matchingRule.riskLevel ?? riskLevel,
          matchingRule,
          reason: `Allowed by rule: ${matchingRule.description ?? matchingRule.id}`,
          requiresConfirmation: false,
          requiresDoubleConfirmation: false,
        };
      } else {
        return {
          allowed: false,
          riskLevel,
          matchingRule,
          reason: `Denied by rule: ${matchingRule.description ?? matchingRule.id}`,
          requiresConfirmation: false,
          requiresDoubleConfirmation: false,
        };
      }
    }

    // Check the base permission service
    const permissionService = getPermissionService();
    const checkResult = permissionService.checkPermission({
      toolName: tool,
      sessionId: this.sessionId,
      targetPath,
      input: input ? { command: input } : undefined,
    });

    if (checkResult.allowed) {
      return {
        allowed: true,
        riskLevel,
        reason: `Allowed by ${checkResult.approval?.scope ?? 'existing'} approval`,
        requiresConfirmation: false,
        requiresDoubleConfirmation: false,
      };
    }

    // Not allowed - needs user confirmation
    return {
      allowed: false,
      riskLevel,
      reason: 'No existing approval',
      requiresConfirmation: true,
      requiresDoubleConfirmation: riskLevel === 'dangerous',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Permission Request Creation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a permission request for user approval.
   */
  createRequest(
    tool: string,
    description: string,
    input: string,
    targetPath?: string
  ): PermissionRequest {
    const riskLevel = this.getRiskLevel(tool, input);

    const scopeOptions: PermissionRequest['scopeOptions'] = [
      {
        scope: 'once',
        label: 'Allow once',
        description: 'Allow this specific operation only',
      },
      {
        scope: 'session',
        label: 'Allow for session',
        description: `Allow all ${tool} operations for this session`,
      },
    ];

    // Add folder scope if there's a target path
    if (targetPath) {
      const folder = targetPath.substring(0, targetPath.lastIndexOf('/')) || '/';
      scopeOptions.push({
        scope: 'folder',
        label: `Allow in folder`,
        description: `Allow ${tool} operations in ${folder}`,
      });
    }

    // Add global scope for non-dangerous operations
    if (riskLevel !== 'dangerous' && riskLevel !== 'high') {
      scopeOptions.push({
        scope: 'global',
        label: 'Always allow',
        description: `Always allow ${tool} operations`,
      });
    }

    return {
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      tool,
      description,
      input,
      riskLevel,
      scopeOptions,
      doubleConfirm: riskLevel === 'dangerous',
      timestamp: Date.now(),
    };
  }

  /**
   * Apply a permission response, potentially creating a rule.
   */
  applyResponse(request: PermissionRequest, response: PermissionResponse): void {
    if (!response.granted) {
      this.log(`Permission denied for ${request.tool}: ${request.input}`);
      return;
    }

    const permissionService = getPermissionService();
    const scope = response.scope ?? 'once';

    // Create the appropriate approval
    switch (scope) {
      case 'session':
        permissionService.addSessionApproval(
          this.sessionId,
          request.tool,
          request.description
        );
        break;

      case 'folder':
        if (response.folderPath) {
          permissionService.addFolderApproval(
            response.folderPath,
            request.tool,
            request.description
          );
        }
        break;

      case 'global':
        permissionService.addGlobalApproval(request.tool, request.description);
        break;

      case 'once':
        // No persistent approval, but add a temporary rule if pattern provided
        if (response.pattern) {
          this.addRule({
            id: crypto.randomUUID(),
            tool: request.tool,
            pattern: response.pattern,
            action: 'allow',
            scope: 'session',
            description: `One-time pattern approval: ${response.pattern}`,
            createdAt: Date.now(),
          });
        }
        break;
    }

    this.log(`Applied permission: ${scope} for ${request.tool}`);
  }
}

// ============================================
// Factory
// ============================================

/**
 * Create a permission evaluator for a session.
 */
export function createPermissionEvaluator(sessionId: string): PermissionEvaluator {
  return new PermissionEvaluator(sessionId);
}
