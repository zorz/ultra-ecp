/**
 * Workflow Loader
 *
 * Loads workflow definitions from YAML files and registers them
 * in the database. Supports system workflows and user-defined workflows.
 */

import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Database } from 'bun:sqlite';
import { WorkflowService } from '../services/WorkflowService.ts';
import type {
  WorkflowDefinition,
  WorkflowTriggerType,
  TriggerConfig,
  WorkflowStep,
} from '../types/workflow-schema.ts';

/**
 * Raw workflow YAML structure.
 */
interface RawWorkflowYaml {
  id: string;
  name: string;
  description?: string;
  is_system?: boolean;
  is_default?: boolean;
  trigger?: {
    type: WorkflowTriggerType;
    config?: TriggerConfig;
  };
  agent_pool?: string[];
  default_agent?: string;
  /** Default tools allowed for all nodes in this workflow */
  defaultAllowedTools?: string[];
  /** Tools explicitly denied for all nodes */
  defaultDeniedTools?: string[];
  steps?: Array<{
    id: string;
    type?: string;
    agent?: string;
    action?: string;
    prompt?: string;
    depends?: string[];
    checkpoint?: boolean;
    checkpointMessage?: string;
    /** Tools this node is allowed to use (overrides workflow defaults) */
    allowedTools?: string[];
    /** Tools this node is explicitly denied (overrides workflow defaults) */
    deniedTools?: string[];
  }>;
  on_error?: 'fail' | 'retry' | 'continue';
  max_iterations?: number;
  cca_config?: {
    vote_options?: string[];
    thresholds?: {
      arbiter_escalation?: number;
      immediate_action?: number;
    };
    feedback_surface_trigger?: string;
  };
}

/**
 * Result of loading workflows.
 */
export interface LoadWorkflowsResult {
  loaded: string[];
  skipped: string[];
  errors: Array<{ file: string; error: string }>;
}

/**
 * Load a single workflow from a YAML file.
 */
export async function loadWorkflowFromFile(
  filePath: string,
  workflowService: WorkflowService
): Promise<{ id: string; isNew: boolean } | { error: string }> {
  try {
    const content = await Bun.file(filePath).text();
    const raw = parseYaml(content) as RawWorkflowYaml;

    if (!raw.id || !raw.name) {
      return { error: 'Missing required fields: id and name' };
    }

    // Check if workflow already exists
    const existing = workflowService.getWorkflow(raw.id);

    // Convert raw YAML to WorkflowDefinition
    const definition: WorkflowDefinition = {
      name: raw.name,
      description: raw.description,
      trigger: {
        type: raw.trigger?.type ?? 'manual',
        config: raw.trigger?.config,
      },
      steps: (raw.steps ?? []).map((step) => ({
        id: step.id,
        type: step.type as WorkflowStep['type'],
        agent: step.agent,
        action: step.action,
        prompt: step.prompt,
        depends: step.depends,
        checkpoint: step.checkpoint,
        checkpointMessage: step.checkpointMessage,
        allowedTools: step.allowedTools,
        deniedTools: step.deniedTools,
      })),
      on_error: raw.on_error,
      max_iterations: raw.max_iterations,
      defaultAllowedTools: raw.defaultAllowedTools,
      defaultDeniedTools: raw.defaultDeniedTools,
    };

    if (existing) {
      // Update existing workflow
      workflowService.updateWorkflow(raw.id, {
        name: raw.name,
        description: raw.description ?? null,
        definition,
        triggerType: raw.trigger?.type,
        triggerConfig: raw.trigger?.config,
        isDefault: raw.is_default,
        agentPool: raw.agent_pool,
        defaultAgentId: raw.default_agent,
      });
      return { id: raw.id, isNew: false };
    } else {
      // Create new workflow
      workflowService.createWorkflow({
        id: raw.id,
        name: raw.name,
        description: raw.description,
        sourceType: 'file',
        sourcePath: filePath,
        definition,
        triggerType: raw.trigger?.type,
        triggerConfig: raw.trigger?.config,
        isSystem: raw.is_system,
        isDefault: raw.is_default,
        agentPool: raw.agent_pool,
        defaultAgentId: raw.default_agent,
      });
      return { id: raw.id, isNew: true };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Load all workflows from a directory.
 */
export async function loadWorkflowsFromDirectory(
  dirPath: string,
  workflowService: WorkflowService
): Promise<LoadWorkflowsResult> {
  const result: LoadWorkflowsResult = {
    loaded: [],
    skipped: [],
    errors: [],
  };

  try {
    const files = await readdir(dirPath);
    const yamlFiles = files.filter(
      (f) => f.endsWith('.yaml') || f.endsWith('.yml')
    );

    for (const file of yamlFiles) {
      const filePath = join(dirPath, file);
      const loadResult = await loadWorkflowFromFile(filePath, workflowService);

      if ('error' in loadResult) {
        result.errors.push({ file, error: loadResult.error });
      } else if (loadResult.isNew) {
        result.loaded.push(loadResult.id);
      } else {
        result.skipped.push(loadResult.id);
      }
    }
  } catch (error) {
    // Directory doesn't exist or other error
    result.errors.push({
      file: dirPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

/**
 * Load system workflows from the default config location.
 */
export async function loadSystemWorkflows(
  db: Database,
  configDir?: string
): Promise<LoadWorkflowsResult> {
  const workflowService = new WorkflowService(db);
  const workflowsDir = configDir ?? join(process.cwd(), 'config', 'workflows');

  return loadWorkflowsFromDirectory(workflowsDir, workflowService);
}

/**
 * Get or create the default workflow.
 * If no default exists, creates a minimal default chat workflow.
 */
export function ensureDefaultWorkflow(db: Database): string {
  const workflowService = new WorkflowService(db);
  const defaultWorkflow = workflowService.getDefaultWorkflow();

  if (defaultWorkflow) {
    return defaultWorkflow.id;
  }

  // Create minimal default workflow
  const workflow = workflowService.createWorkflow({
    id: 'default-chat',
    name: 'Default Chat',
    description: 'Simple multi-agent chat workflow',
    definition: {
      name: 'Default Chat',
      description: 'Simple multi-agent chat workflow',
      trigger: { type: 'manual' },
      steps: [
        {
          id: 'agent',
          type: 'agent',
          prompt: 'Process the user request.',
        },
      ],
      max_iterations: 1000,
    },
    triggerType: 'manual',
    isSystem: true,
    isDefault: true,
    agentPool: ['assistant'],
    defaultAgentId: 'assistant',
  });

  return workflow.id;
}

/**
 * Parse workflow definition from YAML string.
 */
export function parseWorkflowYaml(yamlContent: string): WorkflowDefinition | null {
  try {
    const raw = parseYaml(yamlContent) as RawWorkflowYaml;

    return {
      name: raw.name,
      description: raw.description,
      trigger: {
        type: raw.trigger?.type ?? 'manual',
        config: raw.trigger?.config,
      },
      steps: (raw.steps ?? []).map((step) => ({
        id: step.id,
        type: step.type as WorkflowStep['type'],
        agent: step.agent,
        action: step.action,
        prompt: step.prompt,
        depends: step.depends,
        checkpoint: step.checkpoint,
        checkpointMessage: step.checkpointMessage,
        allowedTools: step.allowedTools,
        deniedTools: step.deniedTools,
      })),
      on_error: raw.on_error,
      max_iterations: raw.max_iterations,
      defaultAllowedTools: raw.defaultAllowedTools,
      defaultDeniedTools: raw.defaultDeniedTools,
    };
  } catch {
    return null;
  }
}

/**
 * Validate a workflow definition.
 */
export function validateWorkflowDefinition(
  definition: WorkflowDefinition
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!definition.name) {
    errors.push('Workflow name is required');
  }

  if (!definition.trigger?.type) {
    errors.push('Trigger type is required');
  }

  if (!definition.steps || definition.steps.length === 0) {
    errors.push('At least one step is required');
  }

  // Check for duplicate step IDs
  const stepIds = new Set<string>();
  for (const step of definition.steps ?? []) {
    if (!step.id) {
      errors.push('All steps must have an id');
    } else if (stepIds.has(step.id)) {
      errors.push(`Duplicate step id: ${step.id}`);
    } else {
      stepIds.add(step.id);
    }
  }

  // Check dependencies reference valid steps
  for (const step of definition.steps ?? []) {
    for (const dep of step.depends ?? []) {
      if (!stepIds.has(dep)) {
        errors.push(`Step '${step.id}' depends on unknown step '${dep}'`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
