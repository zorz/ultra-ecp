/**
 * Evaluative Role Hierarchy
 *
 * Roles that review, critique, and evaluate work.
 *
 * Inheritance:
 *   EvaluativeRole (abstract)
 *   └── ReviewerRole
 *       ├── CodeReviewerRole
 *       ├── SecurityReviewerRole
 *       └── QualityReviewerRole
 */

import type {
  RoleMetadata,
  RoleConfig,
  ExecutionContext,
  ExecutionResult,
} from './base.ts';
import { BaseRole, roleRegistry } from './base.ts';
import type { AgentCapabilities } from '../capabilities/index.ts';
import { createCapabilities } from '../capabilities/index.ts';
import type { AgentPersistentState } from '../state/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Severity of an issue found during evaluation.
 */
export type IssueSeverity = 'critical' | 'major' | 'minor' | 'suggestion';

/**
 * An issue found during evaluation.
 */
export interface EvaluationIssue {
  /** Issue severity */
  severity: IssueSeverity;
  /** Category/type of issue */
  category: string;
  /** Issue description */
  description: string;
  /** Where the issue was found (file, line, etc.) */
  location?: string;
  /** Suggested fix */
  suggestion?: string;
  /** Confidence score (0-1) */
  confidence?: number;
}

/**
 * Result of an evaluation.
 */
export interface EvaluationResult {
  /** Overall pass/fail */
  passed: boolean;
  /** Overall score (0-100) */
  score: number;
  /** Issues found */
  issues: EvaluationIssue[];
  /** Summary of evaluation */
  summary: string;
  /** Detailed feedback */
  feedback?: string;
  /** Recommendations for improvement */
  recommendations?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluative Role (Abstract)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base for all evaluative roles.
 * Provides common evaluation infrastructure.
 */
export abstract class EvaluativeRole extends BaseRole {
  /** Minimum score to pass (can be overridden) */
  protected passingScore = 70;

  /** Issue severity weights for scoring */
  protected severityWeights: Record<IssueSeverity, number> = {
    critical: 30,
    major: 15,
    minor: 5,
    suggestion: 1,
  };

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'evaluative',
      displayName: 'Evaluative Agent',
      description: 'Base evaluative role for review and critique',
      category: 'evaluative',
      version: '1.0.0',
    };
  }

  override getDefaultCapabilities(): AgentCapabilities {
    return createCapabilities({
      communication: {
        canDirectMessage: true,
        canBroadcast: false,
        canReadSharedMemory: true,
        canWriteSharedMemory: true,
        canSpawnAgents: false,
        canModifyWorkflows: false,
      },
    });
  }

  override getSystemPrompt(): string {
    return `You are an evaluative agent responsible for reviewing and assessing work.

Your responsibilities:
- Carefully analyze the content provided
- Identify issues, problems, or areas for improvement
- Provide constructive feedback
- Score the work objectively
- Suggest specific improvements

Be thorough but fair. Focus on actionable feedback.`;
  }

  /** Calculate score from issues (can be overridden) */
  protected calculateScore(issues: EvaluationIssue[]): number {
    let penalty = 0;
    for (const issue of issues) {
      penalty += this.severityWeights[issue.severity];
    }
    return Math.max(0, 100 - penalty);
  }

  /** Create evaluation result from issues */
  protected createEvaluationResult(
    issues: EvaluationIssue[],
    summary: string,
    feedback?: string
  ): EvaluationResult {
    const score = this.calculateScore(issues);
    return {
      passed: score >= this.passingScore,
      score,
      issues,
      summary,
      feedback,
      recommendations: issues
        .filter((i) => i.suggestion)
        .map((i) => i.suggestion!),
    };
  }

  /** Abstract method for performing the actual evaluation */
  abstract evaluate(context: ExecutionContext): Promise<EvaluationResult>;

  override async execute(context: ExecutionContext): Promise<ExecutionResult> {
    try {
      this.setStatus('executing', 'Evaluating...');

      const evaluation = await this.evaluate(context);

      // Store evaluation decision in memory
      this.addMemory({
        type: 'decision',
        content: `Evaluation: ${evaluation.passed ? 'PASSED' : 'FAILED'} (score: ${evaluation.score})`,
        metadata: {
          score: evaluation.score,
          issueCount: evaluation.issues.length,
        },
      });

      return {
        success: true,
        output: evaluation,
        outputs: {
          evaluation,
          passed: evaluation.passed,
          score: evaluation.score,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reviewer Role (Concrete, Extensible)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * General reviewer role. Can be used directly or extended.
 */
export class ReviewerRole extends EvaluativeRole {
  /** What type of content this reviewer handles */
  protected contentType = 'general';

  /** Review criteria */
  protected criteria: string[] = [
    'correctness',
    'clarity',
    'completeness',
    'consistency',
  ];

  constructor(
    agentId: string,
    config?: RoleConfig,
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'reviewer',
      displayName: 'Reviewer',
      description: 'General purpose reviewer for content evaluation',
      category: 'evaluative',
      parentRole: 'evaluative',
      version: '1.0.0',
      tags: ['review', 'feedback'],
    };
  }

  override getSystemPrompt(): string {
    const criteriaList = this.criteria.map((c) => `- ${c}`).join('\n');
    return `You are a reviewer agent responsible for evaluating ${this.contentType} content.

Evaluate content against these criteria:
${criteriaList}

For each issue found:
1. Identify the severity (critical, major, minor, suggestion)
2. Categorize the issue
3. Describe the problem clearly
4. Suggest how to fix it

Provide a summary and overall assessment at the end.`;
  }

  override async evaluate(context: ExecutionContext): Promise<EvaluationResult> {
    // Base implementation - subclasses should override with actual LLM calls
    const content = context.input['content'] as string | undefined;

    if (!content) {
      return this.createEvaluationResult(
        [
          {
            severity: 'critical',
            category: 'input',
            description: 'No content provided for review',
          },
        ],
        'Review failed: no content provided'
      );
    }

    // Placeholder - actual implementation would call LLM
    return this.createEvaluationResult(
      [],
      `Reviewed ${this.contentType} content`,
      'Content reviewed successfully'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Code Reviewer Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Specialized reviewer for code.
 */
export class CodeReviewerRole extends ReviewerRole {
  protected override contentType = 'code';

  protected override criteria = [
    'correctness',
    'readability',
    'maintainability',
    'performance',
    'error handling',
    'testing',
  ];

  /** Programming languages this reviewer specializes in */
  protected languages: string[] = [];

  constructor(
    agentId: string,
    config?: RoleConfig & { languages?: string[] },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.languages) {
      this.languages = config.languages;
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'code-reviewer',
      displayName: 'Code Reviewer',
      description: 'Reviews code for quality, correctness, and best practices',
      category: 'evaluative',
      parentRole: 'reviewer',
      version: '1.0.0',
      tags: ['review', 'code', 'quality'],
    };
  }

  override getDefaultCapabilities(): AgentCapabilities {
    const base = super.getDefaultCapabilities();
    return {
      ...base,
      tools: [
        ...base.tools,
        {
          id: 'read_file',
          name: 'Read File',
          description: 'Read source code files',
        },
        {
          id: 'search_code',
          name: 'Search Code',
          description: 'Search for patterns in code',
        },
      ],
    };
  }

  override getSystemPrompt(): string {
    const langInfo =
      this.languages.length > 0
        ? `You specialize in: ${this.languages.join(', ')}.`
        : '';

    return `You are a code review agent. ${langInfo}

Review code for:
- Bugs and logical errors
- Security vulnerabilities
- Performance issues
- Code style and readability
- Best practices violations
- Missing error handling
- Test coverage gaps

Be specific about locations (file, line) when reporting issues.
Provide code examples in suggestions when helpful.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Security Reviewer Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Specialized reviewer for security concerns.
 */
export class SecurityReviewerRole extends ReviewerRole {
  protected override contentType = 'code/configuration';

  protected override criteria = [
    'input validation',
    'authentication',
    'authorization',
    'data protection',
    'injection prevention',
    'secure communication',
    'dependency security',
  ];

  /** OWASP categories to check */
  protected owaspCategories = [
    'A01:2021-Broken Access Control',
    'A02:2021-Cryptographic Failures',
    'A03:2021-Injection',
    'A04:2021-Insecure Design',
    'A05:2021-Security Misconfiguration',
    'A06:2021-Vulnerable Components',
    'A07:2021-Auth Failures',
    'A08:2021-Software Integrity Failures',
    'A09:2021-Logging Failures',
    'A10:2021-SSRF',
  ];

  constructor(
    agentId: string,
    config?: RoleConfig,
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    // Security reviews have stricter passing criteria
    this.passingScore = 85;
    // Security issues are weighted more heavily
    this.severityWeights = {
      critical: 50,
      major: 25,
      minor: 10,
      suggestion: 2,
    };
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'security-reviewer',
      displayName: 'Security Reviewer',
      description:
        'Reviews code and configuration for security vulnerabilities',
      category: 'evaluative',
      parentRole: 'reviewer',
      version: '1.0.0',
      tags: ['review', 'security', 'owasp', 'vulnerability'],
    };
  }

  override getDefaultCapabilities(): AgentCapabilities {
    const base = super.getDefaultCapabilities();
    return {
      ...base,
      tools: [
        ...base.tools,
        {
          id: 'read_file',
          name: 'Read File',
          description: 'Read source code and config files',
        },
        {
          id: 'search_code',
          name: 'Search Code',
          description: 'Search for security patterns',
        },
        {
          id: 'check_dependencies',
          name: 'Check Dependencies',
          description: 'Check for known vulnerable dependencies',
        },
      ],
    };
  }

  override getSystemPrompt(): string {
    const owaspList = this.owaspCategories.map((c) => `- ${c}`).join('\n');

    return `You are a security review agent specializing in identifying vulnerabilities.

Check for OWASP Top 10 2021 issues:
${owaspList}

Also check for:
- Hardcoded credentials or secrets
- Insecure data storage
- Missing input validation
- SQL/NoSQL/Command injection
- XSS vulnerabilities
- CSRF vulnerabilities
- Insecure deserialization
- Sensitive data exposure
- Insufficient logging

Rate severity as:
- CRITICAL: Exploitable vulnerability with high impact
- MAJOR: Security weakness that should be fixed
- MINOR: Potential issue or defense-in-depth improvement
- SUGGESTION: Best practice recommendation

Always provide specific remediation steps.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Quality Reviewer Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Specialized reviewer for quality assurance.
 */
export class QualityReviewerRole extends ReviewerRole {
  protected override contentType = 'output/deliverable';

  protected override criteria = [
    'completeness',
    'accuracy',
    'consistency',
    'formatting',
    'requirements alignment',
  ];

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'quality-reviewer',
      displayName: 'Quality Reviewer',
      description: 'Reviews outputs for quality and requirements alignment',
      category: 'evaluative',
      parentRole: 'reviewer',
      version: '1.0.0',
      tags: ['review', 'qa', 'quality'],
    };
  }

  override getSystemPrompt(): string {
    return `You are a quality assurance agent.

Verify that outputs:
- Meet all specified requirements
- Are complete and not missing parts
- Are accurate and factually correct
- Are consistent in style and formatting
- Follow any provided templates or guidelines

Check for:
- Missing sections or components
- Inconsistencies between parts
- Deviations from requirements
- Formatting or structural issues
- Unclear or ambiguous content

Provide specific feedback on what needs to be fixed or improved.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Register Role Types
// ─────────────────────────────────────────────────────────────────────────────

// Note: Registration happens when this module is imported
const registerEvaluativeRoles = () => {
  roleRegistry.register(
    new ReviewerRole('_template_').getMetadata(),
    (id, config, state) => new ReviewerRole(id, config, state)
  );

  roleRegistry.register(
    new CodeReviewerRole('_template_').getMetadata(),
    (id, config, state) => new CodeReviewerRole(id, config, state)
  );

  roleRegistry.register(
    new SecurityReviewerRole('_template_').getMetadata(),
    (id, config, state) => new SecurityReviewerRole(id, config, state)
  );

  roleRegistry.register(
    new QualityReviewerRole('_template_').getMetadata(),
    (id, config, state) => new QualityReviewerRole(id, config, state)
  );
};

// Auto-register on module load
registerEvaluativeRoles();

export { registerEvaluativeRoles };
