/**
 * Creative Role Hierarchy
 *
 * Roles that generate, produce, and create content.
 *
 * Inheritance:
 *   CreativeRole (abstract)
 *   ├── WriterRole (prose, documentation)
 *   ├── CoderRole (generates code)
 *   └── DesignerRole (design decisions)
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
// Creative Output Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type of creative artifact produced.
 */
export type ArtifactType =
  | 'text'
  | 'code'
  | 'design'
  | 'plan'
  | 'specification'
  | 'documentation';

/**
 * A creative artifact produced by the agent.
 */
export interface CreativeArtifact {
  /** Artifact type */
  type: ArtifactType;
  /** Human-readable title */
  title: string;
  /** The actual content */
  content: string;
  /** Format (markdown, typescript, json, etc.) */
  format?: string;
  /** File path if applicable */
  filePath?: string;
  /** Version/revision number */
  version?: number;
  /** Confidence in the artifact (0-1) */
  confidence?: number;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of a creative task.
 */
export interface CreativeResult {
  /** Primary artifact */
  artifact: CreativeArtifact;
  /** Additional artifacts */
  additionalArtifacts?: CreativeArtifact[];
  /** Explanation of approach/decisions */
  reasoning?: string;
  /** Alternative approaches considered */
  alternatives?: string[];
  /** Areas needing review */
  reviewNeeded?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Creative Role (Abstract)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base for all creative roles.
 * Provides common creation infrastructure.
 */
export abstract class CreativeRole extends BaseRole {
  /** What types of artifacts this role produces */
  protected abstract artifactTypes: ArtifactType[];

  /** Maximum output length (can be overridden) */
  protected maxOutputLength = 10000;

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'creative',
      displayName: 'Creative Agent',
      description: 'Base creative role for content generation',
      category: 'creative',
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
      resources: {
        maxTokensPerTurn: 8192, // Creative roles need more tokens
        maxTotalTokens: 64000,
        maxExecutionTime: 300000, // 5 minutes for complex generation
        maxConcurrentTools: 5,
      },
    });
  }

  override getSystemPrompt(): string {
    return `You are a creative agent responsible for generating high-quality content.

Your responsibilities:
- Understand requirements and constraints clearly
- Generate creative, original content
- Explain your approach and reasoning
- Identify areas that may need review
- Consider alternative approaches

Focus on quality over speed. Be thoughtful and thorough.`;
  }

  /** Validate the artifact before returning */
  protected validateArtifact(artifact: CreativeArtifact): string[] {
    const issues: string[] = [];

    if (!artifact.content || artifact.content.length === 0) {
      issues.push('Artifact content is empty');
    }

    if (artifact.content.length > this.maxOutputLength) {
      issues.push(
        `Artifact exceeds max length (${artifact.content.length} > ${this.maxOutputLength})`
      );
    }

    if (!this.artifactTypes.includes(artifact.type)) {
      issues.push(
        `Artifact type '${artifact.type}' not supported by this role`
      );
    }

    return issues;
  }

  /** Create a creative artifact helper */
  protected createArtifact(
    type: ArtifactType,
    title: string,
    content: string,
    options?: Partial<Omit<CreativeArtifact, 'type' | 'title' | 'content'>>
  ): CreativeArtifact {
    return {
      type,
      title,
      content,
      version: 1,
      ...options,
    };
  }

  /** Abstract method for performing the creation */
  abstract create(context: ExecutionContext): Promise<CreativeResult>;

  override async execute(context: ExecutionContext): Promise<ExecutionResult> {
    try {
      this.setStatus('executing', 'Creating...');

      const result = await this.create(context);

      // Validate the artifact
      const issues = this.validateArtifact(result.artifact);
      if (issues.length > 0) {
        return {
          success: false,
          error: `Artifact validation failed: ${issues.join('; ')}`,
        };
      }

      // Store creation decision in memory
      this.addMemory({
        type: 'decision',
        content: `Created ${result.artifact.type}: ${result.artifact.title}`,
        metadata: {
          artifactType: result.artifact.type,
          contentLength: result.artifact.content.length,
        },
      });

      return {
        success: true,
        output: result,
        outputs: {
          artifact: result.artifact,
          additionalArtifacts: result.additionalArtifacts,
          reasoning: result.reasoning,
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
// Writer Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role for writing prose, documentation, and textual content.
 */
export class WriterRole extends CreativeRole {
  protected override artifactTypes: ArtifactType[] = [
    'text',
    'documentation',
    'specification',
  ];

  /** Writing style */
  protected style: 'technical' | 'casual' | 'formal' = 'technical';

  constructor(
    agentId: string,
    config?: RoleConfig & { style?: 'technical' | 'casual' | 'formal' },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.style) {
      this.style = config.style;
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'writer',
      displayName: 'Writer',
      description: 'Writes prose, documentation, and textual content',
      category: 'creative',
      parentRole: 'creative',
      version: '1.0.0',
      tags: ['writing', 'documentation', 'content'],
    };
  }

  override getSystemPrompt(): string {
    const styleGuide =
      this.style === 'technical'
        ? 'Use clear, precise technical language. Be concise but thorough.'
        : this.style === 'casual'
          ? 'Write in a friendly, approachable tone. Keep it engaging.'
          : 'Use formal, professional language. Maintain appropriate gravitas.';

    return `You are a writer agent responsible for creating high-quality written content.

Writing style: ${this.style}
${styleGuide}

Your responsibilities:
- Understand the audience and purpose
- Structure content logically
- Use clear, effective language
- Proofread for errors
- Provide citations/references when needed

Always explain your structural choices and suggest improvements.`;
  }

  override async create(context: ExecutionContext): Promise<CreativeResult> {
    const topic = context.input['topic'] as string | undefined;
    const requirements = context.input['requirements'] as string | undefined;
    const targetLength = context.input['targetLength'] as number | undefined;

    if (!topic) {
      throw new Error('No topic provided for writing');
    }

    // Build the prompt for the LLM
    const prompt = this.buildWritingPrompt(topic, requirements, targetLength);

    // Make the LLM call
    const llmResult = await context.llm.invoke(prompt, {
      streaming: true,
      onStream: (event) => {
        if (event.type === 'delta' && event.accumulated) {
          context.emit({
            type: 'output',
            data: { progress: event.accumulated.length },
            timestamp: new Date(),
          });
        }
      },
    });

    if (!llmResult.success) {
      throw new Error(llmResult.error ?? 'LLM call failed');
    }

    return {
      artifact: this.createArtifact(
        'text',
        topic,
        llmResult.content,
        {
          format: 'markdown',
          confidence: 0.85,
          metadata: {
            tokensUsed: llmResult.usage?.totalTokens,
            style: this.style,
          },
        }
      ),
      reasoning: `Generated ${this.style} content based on the provided topic and requirements`,
    };
  }

  /**
   * Build the prompt for writing tasks.
   */
  private buildWritingPrompt(topic: string, requirements?: string, targetLength?: number): string {
    const styleGuide =
      this.style === 'technical'
        ? 'Use clear, precise technical language. Be concise but thorough.'
        : this.style === 'casual'
          ? 'Write in a friendly, approachable tone. Keep it engaging.'
          : 'Use formal, professional language. Maintain appropriate gravitas.';

    let prompt = `Write content about the following topic:

Topic: ${topic}

Style: ${this.style}
Guidelines: ${styleGuide}`;

    if (requirements) {
      prompt += `\n\nSpecific requirements:\n${requirements}`;
    }

    if (targetLength) {
      prompt += `\n\nTarget length: approximately ${targetLength} words`;
    }

    prompt += `

Please write well-structured content in markdown format.`;

    return prompt;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coder Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role for generating code and technical implementations.
 */
export class CoderRole extends CreativeRole {
  protected override artifactTypes: ArtifactType[] = ['code', 'specification'];

  /** Primary programming languages */
  protected languages: string[] = ['typescript'];

  /** Code style preferences */
  protected codeStyle: {
    useComments: boolean;
    preferFunctional: boolean;
    strictTypes: boolean;
  } = {
    useComments: true,
    preferFunctional: true,
    strictTypes: true,
  };

  constructor(
    agentId: string,
    config?: RoleConfig & {
      languages?: string[];
      codeStyle?: Partial<CoderRole['codeStyle']>;
    },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.languages) {
      this.languages = config.languages;
    }
    if (config?.codeStyle) {
      this.codeStyle = { ...this.codeStyle, ...config.codeStyle };
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'coder',
      displayName: 'Coder',
      description: 'Generates code and technical implementations',
      category: 'creative',
      parentRole: 'creative',
      version: '1.0.0',
      tags: ['coding', 'development', 'implementation'],
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
          description: 'Read source code files for context',
        },
        {
          id: 'search_code',
          name: 'Search Code',
          description: 'Search for patterns and references',
        },
        {
          id: 'write_file',
          name: 'Write File',
          description: 'Write generated code to files',
          requiresPermission: true,
        },
      ],
    };
  }

  override getSystemPrompt(): string {
    const langList = this.languages.join(', ');
    const styleDesc = [
      this.codeStyle.useComments ? 'Include helpful comments' : 'Minimal comments',
      this.codeStyle.preferFunctional ? 'Prefer functional style' : 'Use OOP when appropriate',
      this.codeStyle.strictTypes ? 'Use strict typing' : 'Flexible typing',
    ].join('. ');

    return `You are a coder agent responsible for generating high-quality code.

Primary languages: ${langList}
Code style: ${styleDesc}

Your responsibilities:
- Understand requirements and existing patterns
- Write clean, maintainable code
- Follow project conventions
- Handle edge cases and errors
- Consider performance implications
- Write testable code

Always:
- Explain your implementation approach
- Note any assumptions made
- Identify areas that need testing
- Suggest potential improvements`;
  }

  override async create(context: ExecutionContext): Promise<CreativeResult> {
    const task = context.input['task'] as string | undefined;
    const language = (context.input['language'] as string) ?? this.languages[0];
    const additionalContext = context.input['context'] as string | undefined;

    if (!task) {
      throw new Error('No task provided for coding');
    }

    // Build the prompt for the LLM
    const prompt = this.buildCodingPrompt(task, language, additionalContext);

    // Make the LLM call with streaming
    const llmResult = await context.llm.invoke(prompt, {
      streaming: true,
      onStream: (event) => {
        // Emit progress events
        if (event.type === 'delta' && event.accumulated) {
          context.emit({
            type: 'output',
            data: { progress: event.accumulated.length },
            timestamp: new Date(),
          });
        }
      },
    });

    if (!llmResult.success) {
      throw new Error(llmResult.error ?? 'LLM call failed');
    }

    // Parse the LLM response to extract code and explanation
    const { code, reasoning, reviewAreas } = this.parseCodingResponse(llmResult.content, language);

    return {
      artifact: this.createArtifact(
        'code',
        task,
        code,
        {
          format: language,
          confidence: 0.8,
          metadata: {
            tokensUsed: llmResult.usage?.totalTokens,
            toolCalls: llmResult.toolCalls?.length ?? 0,
          },
        }
      ),
      reasoning,
      reviewNeeded: reviewAreas,
    };
  }

  /**
   * Build the prompt for coding tasks.
   */
  private buildCodingPrompt(task: string, language: string, additionalContext?: string): string {
    const styleDesc = [
      this.codeStyle.useComments ? 'Include helpful comments' : 'Minimal comments',
      this.codeStyle.preferFunctional ? 'Prefer functional style' : 'Use OOP when appropriate',
      this.codeStyle.strictTypes ? 'Use strict typing' : 'Flexible typing',
    ].join('. ');

    let prompt = `Generate ${language} code for the following task:

Task: ${task}

Code style requirements: ${styleDesc}

Requirements:
1. Write clean, maintainable code
2. Handle edge cases appropriately
3. Follow ${language} best practices`;

    if (additionalContext) {
      prompt += `\n\nAdditional context:\n${additionalContext}`;
    }

    prompt += `

Respond with:
1. The code implementation
2. A brief explanation of your approach
3. Any areas that should be reviewed or tested`;

    return prompt;
  }

  /**
   * Parse the LLM response to extract structured output.
   */
  private parseCodingResponse(
    content: string,
    language: string
  ): { code: string; reasoning: string; reviewAreas: string[] } {
    // Try to extract code blocks
    const codeBlockRegex = new RegExp(`\`\`\`${language}?\\n([\\s\\S]*?)\`\`\``, 'i');
    const codeMatch = content.match(codeBlockRegex);

    let code: string;
    let remainingContent: string;

    if (codeMatch && codeMatch[1]) {
      code = codeMatch[1].trim();
      remainingContent = content.replace(codeMatch[0], '').trim();
    } else {
      // No code block found, treat entire response as code
      code = content.trim();
      remainingContent = '';
    }

    // Extract reasoning and review areas from remaining content
    const reviewAreas: string[] = [];
    const reviewMatch = remainingContent.match(/(?:review|test|check)[^\n]*:/i);
    if (reviewMatch) {
      const reviewSection = remainingContent.substring(reviewMatch.index ?? 0);
      const items = reviewSection.match(/[-•*]\s*([^\n]+)/g);
      if (items) {
        reviewAreas.push(...items.map(item => item.replace(/^[-•*]\s*/, '').trim()));
      }
    }

    // The reasoning is everything that's not code or review items
    const reasoning = remainingContent
      .split(/(?:review|test|check)[^\n]*:/i)[0]
      ?.trim() || 'Generated code based on requirements';

    return { code, reasoning, reviewAreas };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Designer Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role for making design decisions and creating specifications.
 */
export class DesignerRole extends CreativeRole {
  protected override artifactTypes: ArtifactType[] = [
    'design',
    'specification',
    'plan',
  ];

  /** Design domain */
  protected domain: 'architecture' | 'api' | 'data' | 'system' = 'architecture';

  constructor(
    agentId: string,
    config?: RoleConfig & { domain?: DesignerRole['domain'] },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.domain) {
      this.domain = config.domain;
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'designer',
      displayName: 'Designer',
      description: 'Creates designs, specifications, and architectural plans',
      category: 'creative',
      parentRole: 'creative',
      version: '1.0.0',
      tags: ['design', 'architecture', 'specification'],
    };
  }

  override getSystemPrompt(): string {
    const domainDesc = {
      architecture: 'software architecture and system design',
      api: 'API design and contracts',
      data: 'data models and database design',
      system: 'system integration and infrastructure',
    }[this.domain];

    return `You are a designer agent specializing in ${domainDesc}.

Your responsibilities:
- Analyze requirements thoroughly
- Consider scalability and maintainability
- Document tradeoffs clearly
- Provide diagrams or schemas when helpful
- Consider security and performance
- Align with existing patterns

Design principles:
- Favor simplicity over complexity
- Design for change
- Consider failure modes
- Document assumptions

Always explain your design decisions and their rationale.`;
  }

  override async create(context: ExecutionContext): Promise<CreativeResult> {
    // Base implementation - subclasses should override with actual LLM calls
    const requirement = context.input['requirement'] as string | undefined;

    if (!requirement) {
      throw new Error('No requirement provided for design');
    }

    // Placeholder - actual implementation would call LLM
    return {
      artifact: this.createArtifact(
        'design',
        `Design: ${requirement.substring(0, 50)}...`,
        `# Design Document\n\n## Requirement\n${requirement}\n\n## Design\n[TODO: Design details]`,
        { format: 'markdown' }
      ),
      reasoning: 'Placeholder implementation',
      alternatives: ['Alternative approach 1', 'Alternative approach 2'],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Register Role Types
// ─────────────────────────────────────────────────────────────────────────────

const registerCreativeRoles = () => {
  roleRegistry.register(
    new WriterRole('_template_').getMetadata(),
    (id, config, state) => new WriterRole(id, config, state)
  );

  roleRegistry.register(
    new CoderRole('_template_').getMetadata(),
    (id, config, state) => new CoderRole(id, config, state)
  );

  roleRegistry.register(
    new DesignerRole('_template_').getMetadata(),
    (id, config, state) => new DesignerRole(id, config, state)
  );
};

// Auto-register on module load
registerCreativeRoles();

export { registerCreativeRoles };
