/**
 * Workflow Conversion Layer
 *
 * Converts between the frontend editor's flat step model and the backend's
 * port-based graph model. This enables:
 * - Visual workflows created in editor to execute on backend
 * - Backend workflows to be loaded and edited in visual editor
 */

import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowEdge,
  NodeType,
  NodePort,
  NodeConfig,
  PortDataType,
  TriggerConfig,
  AgentConfig,
  ConditionConfig,
  TransformConfig,
  MergeConfig,
  SplitConfig,
  LoopConfig,
  HumanConfig,
  OutputConfig,
  VoteConfig,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Editor Types (matching frontend/stores/workflowStore.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type EditorNodeType =
  | 'trigger'
  | 'agent'
  | 'condition'
  | 'transform'
  | 'checkpoint'
  | 'output'
  | 'merge'
  | 'split'
  | 'loop'
  | 'vote'
  | 'human';

export type WorkflowStepAction =
  | 'analyze'
  | 'review'
  | 'implement'
  | 'test'
  | 'summarize'
  | 'custom';

export type WorkflowTriggerType =
  | 'manual'
  | 'on_message'
  | 'on_file_change'
  | 'scheduled';

export interface EditorNode {
  id: string;
  type: EditorNodeType;
  label: string;
  agent?: string;
  provider?: string;
  model?: string;
  action?: WorkflowStepAction;
  prompt?: string;
  depends?: string[];
  checkpoint?: boolean;
  checkpointMessage?: string;
  position: { x: number; y: number };
  // Trigger specific
  triggerType?: WorkflowTriggerType;
  // Extended properties for non-agent nodes
  condition?: string;
  transformType?: 'template' | 'jq' | 'javascript';
  template?: string;
  mergeStrategy?: 'wait_all' | 'wait_any';
  splitStrategy?: 'parallel' | 'broadcast';
  loopType?: 'for_each' | 'while' | 'times';
  loopCount?: number;
  outputDestination?: 'chat' | 'file' | 'variable';
  // Vote/Human specific
  voteOptions?: string[];
  voteThreshold?: number;
  humanChoices?: Array<{ id: string; label: string; description?: string }>;
  allowFreeText?: boolean;
}

export interface EditorEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  keywords?: string[];
  patterns?: string[];
  schedule?: string;
}

export interface WorkflowStep {
  id: string;
  type?: NodeType;
  agent: string;
  action: WorkflowStepAction;
  prompt: string;
  depends?: string[];
  checkpoint?: boolean;
  checkpointMessage?: string;
  timeout?: number;
  retries?: number;
  condition?: string;
}

export interface EditorWorkflow {
  id: string;
  name: string;
  description?: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  enabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Port Templates by Node Type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default ports for each node type.
 */
function getDefaultPorts(nodeType: NodeType): { inputs: NodePort[]; outputs: NodePort[] } {
  switch (nodeType) {
    case 'trigger':
      return {
        inputs: [],
        outputs: [
          { id: 'output', name: 'Output', dataType: 'any', required: true },
        ],
      };

    case 'agent':
      return {
        inputs: [
          { id: 'input', name: 'Input', dataType: 'any', required: true },
        ],
        outputs: [
          { id: 'output', name: 'Output', dataType: 'text', required: true },
        ],
      };

    case 'condition':
      return {
        inputs: [
          { id: 'input', name: 'Input', dataType: 'any', required: true },
        ],
        outputs: [
          { id: 'true', name: 'True', dataType: 'any', required: true, condition: 'true' },
          { id: 'false', name: 'False', dataType: 'any', required: true, condition: 'false' },
        ],
      };

    case 'transform':
      return {
        inputs: [
          { id: 'input', name: 'Input', dataType: 'any', required: true },
        ],
        outputs: [
          { id: 'output', name: 'Output', dataType: 'any', required: true },
        ],
      };

    case 'merge':
      return {
        inputs: [
          { id: 'input_1', name: 'Input 1', dataType: 'any', required: true },
          { id: 'input_2', name: 'Input 2', dataType: 'any', required: false },
          { id: 'input_3', name: 'Input 3', dataType: 'any', required: false },
        ],
        outputs: [
          { id: 'output', name: 'Output', dataType: 'any', required: true },
        ],
      };

    case 'split':
      return {
        inputs: [
          { id: 'input', name: 'Input', dataType: 'any', required: true },
        ],
        outputs: [
          { id: 'output_1', name: 'Branch 1', dataType: 'any', required: true },
          { id: 'output_2', name: 'Branch 2', dataType: 'any', required: true },
          { id: 'output_3', name: 'Branch 3', dataType: 'any', required: false },
        ],
      };

    case 'loop':
      return {
        inputs: [
          { id: 'input', name: 'Input', dataType: 'array', required: true },
        ],
        outputs: [
          { id: 'item', name: 'Item', dataType: 'any', required: true },
          { id: 'done', name: 'Done', dataType: 'array', required: true },
        ],
      };

    case 'vote':
      return {
        inputs: [
          { id: 'vote_1', name: 'Vote 1', dataType: 'vote', required: true },
          { id: 'vote_2', name: 'Vote 2', dataType: 'vote', required: true },
          { id: 'vote_3', name: 'Vote 3', dataType: 'vote', required: false },
        ],
        outputs: [
          { id: 'pass', name: 'Pass', dataType: 'any', required: true, condition: 'pass' },
          { id: 'queue', name: 'Queue', dataType: 'any', required: true, condition: 'queue' },
          { id: 'fail', name: 'Fail', dataType: 'any', required: true, condition: 'fail' },
        ],
      };

    case 'human':
      return {
        inputs: [
          { id: 'input', name: 'Input', dataType: 'any', required: true },
        ],
        outputs: [
          { id: 'output', name: 'Output', dataType: 'any', required: true },
        ],
      };

    case 'output':
      return {
        inputs: [
          { id: 'input', name: 'Input', dataType: 'any', required: true },
        ],
        outputs: [],
      };

    default:
      return {
        inputs: [{ id: 'input', name: 'Input', dataType: 'any', required: true }],
        outputs: [{ id: 'output', name: 'Output', dataType: 'any', required: true }],
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor → Backend Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map editor node type to backend node type.
 */
function mapEditorTypeToBackend(editorType: EditorNodeType): NodeType {
  switch (editorType) {
    case 'checkpoint':
      return 'human'; // Checkpoint is a human decision node
    default:
      return editorType as NodeType;
  }
}

/**
 * Map editor trigger type to backend trigger type.
 */
function mapTriggerType(editorType: WorkflowTriggerType): 'message' | 'file' | 'schedule' | 'webhook' | 'manual' {
  switch (editorType) {
    case 'on_message':
      return 'message';
    case 'on_file_change':
      return 'file';
    case 'scheduled':
      return 'schedule';
    default:
      return 'manual';
  }
}

/**
 * Create node config from editor node.
 */
function createNodeConfig(node: EditorNode): NodeConfig {
  const nodeType = mapEditorTypeToBackend(node.type);

  switch (nodeType) {
    case 'trigger':
      return {
        nodeType: 'trigger',
        triggerType: mapTriggerType(node.triggerType || 'manual'),
      } as TriggerConfig;

    case 'agent':
      return {
        nodeType: 'agent',
        roleType: node.agent || 'assistant',
        systemPrompt: node.prompt,
        model: node.model,
        streaming: true,
      } as AgentConfig;

    case 'condition':
      return {
        nodeType: 'condition',
        rules: node.condition
          ? [{ field: 'input', operator: 'custom' as const, expression: node.condition }]
          : [],
        trueLabel: 'Yes',
        falseLabel: 'No',
      } as ConditionConfig;

    case 'transform':
      return {
        nodeType: 'transform',
        transformType: node.transformType || 'template',
        template: node.template || '{{input}}',
      } as TransformConfig;

    case 'merge':
      return {
        nodeType: 'merge',
        strategy: node.mergeStrategy || 'wait_all',
      } as MergeConfig;

    case 'split':
      return {
        nodeType: 'split',
        strategy: node.splitStrategy || 'parallel',
      } as SplitConfig;

    case 'loop':
      return {
        nodeType: 'loop',
        loopType: node.loopType || 'for_each',
        count: node.loopCount,
        maxIterations: 100,
      } as LoopConfig;

    case 'vote':
      return {
        nodeType: 'vote',
        voteOptions: ['pass', 'queue', 'fail'],
        threshold: node.voteThreshold || 0.5,
        tieBreaker: 'first',
        voteField: 'vote',
      } as VoteConfig;

    case 'human':
      return {
        nodeType: 'human',
        prompt: node.checkpointMessage || node.prompt || 'Please review and decide',
        choices: node.humanChoices || [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
        allowFreeText: node.allowFreeText ?? true,
      } as HumanConfig;

    case 'output':
      return {
        nodeType: 'output',
        destination: node.outputDestination || 'chat',
      } as OutputConfig;

    default:
      return {
        nodeType: 'agent',
        roleType: 'assistant',
        streaming: true,
      } as AgentConfig;
  }
}

/**
 * Convert editor node to backend workflow node.
 */
function editorNodeToBackendNode(node: EditorNode): WorkflowNode {
  const nodeType = mapEditorTypeToBackend(node.type);
  const ports = getDefaultPorts(nodeType);

  return {
    id: node.id,
    type: nodeType,
    label: node.label,
    position: node.position,
    inputs: ports.inputs,
    outputs: ports.outputs,
    config: createNodeConfig(node),
  };
}

/**
 * Create edges from node dependencies.
 * Maps the `depends` array to proper port-based edges.
 */
function createEdgesFromDependencies(
  nodes: EditorNode[],
  backendNodes: WorkflowNode[]
): WorkflowEdge[] {
  const edges: WorkflowEdge[] = [];
  const nodeMap = new Map(backendNodes.map(n => [n.id, n]));

  for (const node of nodes) {
    if (!node.depends || node.depends.length === 0) continue;

    const targetNode = nodeMap.get(node.id);
    if (!targetNode) continue;

    for (let i = 0; i < node.depends.length; i++) {
      const sourceId = node.depends[i];
      if (!sourceId) continue;

      const sourceNode = nodeMap.get(sourceId);
      if (!sourceNode) continue;

      // Determine source port
      let sourcePortId = 'output';
      const firstOutput = sourceNode.outputs[0];
      if (firstOutput) {
        // For condition nodes, we need to determine which branch
        // Default to first output port
        sourcePortId = firstOutput.id;
      }

      // Determine target port
      let targetPortId = 'input';
      if (targetNode.inputs.length > 1) {
        // For merge nodes with multiple inputs, assign to next available
        const inputIndex = Math.min(i, targetNode.inputs.length - 1);
        const inputPort = targetNode.inputs[inputIndex];
        if (inputPort) {
          targetPortId = inputPort.id;
        }
      } else {
        const firstInput = targetNode.inputs[0];
        if (firstInput) {
          targetPortId = firstInput.id;
        }
      }

      edges.push({
        id: `${sourceId}-${node.id}-${i}`,
        sourceNodeId: sourceId,
        sourcePortId,
        targetNodeId: node.id,
        targetPortId,
      });
    }
  }

  return edges;
}

/**
 * Convert a complete editor workflow to backend workflow definition.
 */
export function editorWorkflowToBackend(
  workflow: EditorWorkflow,
  editorNodes?: EditorNode[]
): WorkflowDefinition {
  // If editor nodes are provided, use them; otherwise convert steps to nodes
  let nodes: WorkflowNode[];
  let edges: WorkflowEdge[];

  if (editorNodes && editorNodes.length > 0) {
    // Direct conversion from editor nodes
    nodes = editorNodes.map(editorNodeToBackendNode);
    edges = createEdgesFromDependencies(editorNodes, nodes);
  } else {
    // Convert from workflow steps (simpler model)
    const stepNodes: EditorNode[] = [];

    // Create trigger node with workflow's trigger type
    const triggerNode: EditorNode = {
      id: 'trigger',
      type: 'trigger',
      label: 'Trigger',
      triggerType: workflow.trigger.type,
      position: { x: 50, y: 100 },
    };
    stepNodes.push(triggerNode);

    // Convert steps to editor nodes
    let yPos = 100;
    for (const step of workflow.steps) {
      const previousNode = stepNodes[stepNodes.length - 1];
      const defaultDepends = previousNode ? [previousNode.id] : ['trigger'];

      const editorNode: EditorNode = {
        id: step.id,
        type: step.type || 'agent',
        label: step.agent || step.id,
        agent: step.agent,
        action: step.action,
        prompt: step.prompt,
        depends: step.depends || defaultDepends,
        checkpoint: step.checkpoint,
        checkpointMessage: step.checkpointMessage,
        condition: step.condition,
        position: { x: 250, y: yPos },
      };
      stepNodes.push(editorNode);
      yPos += 120;
    }

    // Add output node if there are steps
    if (workflow.steps.length > 0) {
      const lastStep = stepNodes[stepNodes.length - 1];
      if (lastStep) {
        const outputNode: EditorNode = {
          id: 'output',
          type: 'output',
          label: 'Output',
          depends: [lastStep.id],
          position: { x: 450, y: 100 + (workflow.steps.length * 60) },
        };
        stepNodes.push(outputNode);
      }
    }

    nodes = stepNodes.map(editorNodeToBackendNode);
    edges = createEdgesFromDependencies(stepNodes, nodes);
  }

  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    version: '1.0.0',
    nodes,
    edges,
    metadata: {
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend → Editor Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map backend node type to editor node type.
 */
function mapBackendTypeToEditor(backendType: NodeType): EditorNodeType {
  // Most types map directly
  return backendType as EditorNodeType;
}

/**
 * Extract editor properties from backend node config.
 */
function extractEditorPropsFromConfig(config: NodeConfig): Partial<EditorNode> {
  switch (config.nodeType) {
    case 'agent': {
      const agentConfig = config as AgentConfig;
      return {
        agent: agentConfig.roleType,
        model: agentConfig.model,
        prompt: agentConfig.systemPrompt,
      };
    }

    case 'condition': {
      const condConfig = config as ConditionConfig;
      const customRule = condConfig.rules.find(r => r.operator === 'custom');
      return {
        condition: customRule?.expression,
      };
    }

    case 'transform': {
      const transformConfig = config as TransformConfig;
      return {
        transformType: transformConfig.transformType as 'template' | 'jq' | 'javascript',
        template: transformConfig.template,
      };
    }

    case 'merge': {
      const mergeConfig = config as MergeConfig;
      return {
        mergeStrategy: mergeConfig.strategy as 'wait_all' | 'wait_any',
      };
    }

    case 'split': {
      const splitConfig = config as SplitConfig;
      return {
        splitStrategy: splitConfig.strategy as 'parallel' | 'broadcast',
      };
    }

    case 'loop': {
      const loopConfig = config as LoopConfig;
      return {
        loopType: loopConfig.loopType,
        loopCount: loopConfig.count,
      };
    }

    case 'vote': {
      const voteConfig = config as VoteConfig;
      return {
        voteOptions: voteConfig.voteOptions,
        voteThreshold: voteConfig.threshold,
      };
    }

    case 'human': {
      const humanConfig = config as HumanConfig;
      return {
        checkpointMessage: humanConfig.prompt,
        humanChoices: humanConfig.choices,
        allowFreeText: humanConfig.allowFreeText,
        checkpoint: true,
      };
    }

    case 'output': {
      const outputConfig = config as OutputConfig;
      return {
        outputDestination: outputConfig.destination as 'chat' | 'file' | 'variable',
      };
    }

    default:
      return {};
  }
}

/**
 * Convert backend workflow node to editor node.
 */
function backendNodeToEditorNode(node: WorkflowNode, edges: WorkflowEdge[]): EditorNode {
  // Find all edges pointing to this node to build depends array
  const incomingEdges = edges.filter(e => e.targetNodeId === node.id);
  const depends = incomingEdges.map(e => e.sourceNodeId);

  const configProps = extractEditorPropsFromConfig(node.config);

  return {
    id: node.id,
    type: mapBackendTypeToEditor(node.type),
    label: node.label,
    position: node.position,
    depends: depends.length > 0 ? depends : undefined,
    ...configProps,
  };
}

/**
 * Convert backend workflow definition to editor workflow and nodes.
 */
export function backendWorkflowToEditor(definition: WorkflowDefinition): {
  workflow: EditorWorkflow;
  nodes: EditorNode[];
  edges: EditorEdge[];
} {
  // Convert nodes
  const editorNodes = definition.nodes.map(node =>
    backendNodeToEditorNode(node, definition.edges)
  );

  // Convert edges (simpler format for editor)
  const editorEdges: EditorEdge[] = definition.edges.map(edge => ({
    id: edge.id,
    from: edge.sourceNodeId,
    to: edge.targetNodeId,
    label: edge.label,
  }));

  // Find trigger node to extract trigger config
  const triggerNode = definition.nodes.find(n => n.type === 'trigger');
  const triggerConfig = triggerNode?.config as TriggerConfig | undefined;

  // Convert nodes to steps for the flat workflow model
  const steps: WorkflowStep[] = definition.nodes
    .filter(n => n.type === 'agent')
    .map(node => {
      const agentConfig = node.config as AgentConfig;
      const editorNode = editorNodes.find(e => e.id === node.id);
      return {
        id: node.id,
        type: node.type,
        agent: agentConfig.roleType,
        action: 'custom' as WorkflowStepAction,
        prompt: agentConfig.systemPrompt || '',
        depends: editorNode?.depends,
      };
    });

  // Map trigger type back
  let triggerType: WorkflowTriggerType = 'manual';
  if (triggerConfig?.triggerType === 'message') triggerType = 'on_message';
  else if (triggerConfig?.triggerType === 'file') triggerType = 'on_file_change';
  else if (triggerConfig?.triggerType === 'schedule') triggerType = 'scheduled';

  const workflow: EditorWorkflow = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    trigger: { type: triggerType },
    steps,
    enabled: true,
  };

  return { workflow, nodes: editorNodes, edges: editorEdges };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationError {
  nodeId?: string;
  edgeId?: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Validate port data type compatibility.
 */
function areTypesCompatible(sourceType: PortDataType, targetType: PortDataType): boolean {
  if (targetType === 'any' || sourceType === 'any') return true;
  if (sourceType === targetType) return true;

  // Text is compatible with JSON (can be parsed)
  if (sourceType === 'text' && targetType === 'json') return true;
  if (sourceType === 'json' && targetType === 'text') return true;

  // Code is a form of text
  if (sourceType === 'code' && targetType === 'text') return true;
  if (sourceType === 'text' && targetType === 'code') return true;

  return false;
}

/**
 * Validate a workflow definition.
 */
export function validateWorkflow(definition: WorkflowDefinition): ValidationError[] {
  const errors: ValidationError[] = [];
  const nodeMap = new Map(definition.nodes.map(n => [n.id, n]));

  // Check for trigger node
  const triggerNodes = definition.nodes.filter(n => n.type === 'trigger');
  if (triggerNodes.length === 0) {
    errors.push({
      message: 'Workflow must have at least one trigger node',
      severity: 'error',
    });
  }

  // Check for output node
  const outputNodes = definition.nodes.filter(n => n.type === 'output');
  if (outputNodes.length === 0) {
    errors.push({
      message: 'Workflow should have at least one output node',
      severity: 'warning',
    });
  }

  // Validate edges
  for (const edge of definition.edges) {
    const sourceNode = nodeMap.get(edge.sourceNodeId);
    const targetNode = nodeMap.get(edge.targetNodeId);

    if (!sourceNode) {
      errors.push({
        edgeId: edge.id,
        message: `Edge references non-existent source node: ${edge.sourceNodeId}`,
        severity: 'error',
      });
      continue;
    }

    if (!targetNode) {
      errors.push({
        edgeId: edge.id,
        message: `Edge references non-existent target node: ${edge.targetNodeId}`,
        severity: 'error',
      });
      continue;
    }

    // Validate port existence
    const sourcePort = sourceNode.outputs.find(p => p.id === edge.sourcePortId);
    const targetPort = targetNode.inputs.find(p => p.id === edge.targetPortId);

    if (!sourcePort) {
      errors.push({
        edgeId: edge.id,
        message: `Edge references non-existent output port: ${edge.sourcePortId} on node ${sourceNode.label}`,
        severity: 'error',
      });
    }

    if (!targetPort) {
      errors.push({
        edgeId: edge.id,
        message: `Edge references non-existent input port: ${edge.targetPortId} on node ${targetNode.label}`,
        severity: 'error',
      });
    }

    // Validate type compatibility
    if (sourcePort && targetPort && !areTypesCompatible(sourcePort.dataType, targetPort.dataType)) {
      errors.push({
        edgeId: edge.id,
        message: `Type mismatch: ${sourcePort.dataType} → ${targetPort.dataType} between ${sourceNode.label} and ${targetNode.label}`,
        severity: 'warning',
      });
    }
  }

  // Check for required inputs without connections
  for (const node of definition.nodes) {
    for (const input of node.inputs) {
      if (input.required) {
        const hasConnection = definition.edges.some(
          e => e.targetNodeId === node.id && e.targetPortId === input.id
        );
        if (!hasConnection) {
          errors.push({
            nodeId: node.id,
            message: `Required input "${input.name}" on node "${node.label}" has no connection`,
            severity: 'warning',
          });
        }
      }
    }
  }

  // Check for cycles (simple detection)
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(nodeId: string): boolean {
    visited.add(nodeId);
    recursionStack.add(nodeId);

    const outgoingEdges = definition.edges.filter(e => e.sourceNodeId === nodeId);
    for (const edge of outgoingEdges) {
      if (!visited.has(edge.targetNodeId)) {
        if (hasCycle(edge.targetNodeId)) return true;
      } else if (recursionStack.has(edge.targetNodeId)) {
        // Allow cycles involving loop nodes
        const targetNode = nodeMap.get(edge.targetNodeId);
        if (targetNode?.type !== 'loop') {
          return true;
        }
      }
    }

    recursionStack.delete(nodeId);
    return false;
  }

  for (const node of definition.nodes) {
    if (!visited.has(node.id)) {
      if (hasCycle(node.id)) {
        errors.push({
          message: 'Workflow contains a cycle (not in a loop node)',
          severity: 'error',
        });
        break;
      }
    }
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auto-layout nodes in a top-to-bottom flow.
 */
export function autoLayoutNodes(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const nodeMap = new Map(nodes.map(n => [n.id, { ...n }]));
  const levels = new Map<string, number>();

  // Find root nodes (no incoming edges)
  const rootIds = nodes
    .filter(n => !edges.some(e => e.targetNodeId === n.id))
    .map(n => n.id);

  // Assign levels using BFS
  const queue = rootIds.map(id => ({ id, level: 0 }));
  while (queue.length > 0) {
    const { id, level } = queue.shift()!;
    const currentLevel = levels.get(id);
    if (currentLevel !== undefined && currentLevel >= level) continue;

    levels.set(id, level);

    const outgoing = edges.filter(e => e.sourceNodeId === id);
    for (const edge of outgoing) {
      queue.push({ id: edge.targetNodeId, level: level + 1 });
    }
  }

  // Position nodes by level
  const levelNodes = new Map<number, string[]>();
  for (const [nodeId, level] of levels) {
    if (!levelNodes.has(level)) levelNodes.set(level, []);
    levelNodes.get(level)!.push(nodeId);
  }

  const NODE_WIDTH = 180;
  const NODE_HEIGHT = 80;
  const HORIZONTAL_GAP = 100;
  const VERTICAL_GAP = 60;

  for (const [level, nodeIds] of levelNodes) {
    const totalWidth = nodeIds.length * NODE_WIDTH + (nodeIds.length - 1) * HORIZONTAL_GAP;
    let x = -totalWidth / 2 + NODE_WIDTH / 2 + 400; // Center around x=400

    for (const nodeId of nodeIds) {
      const node = nodeMap.get(nodeId);
      if (node) {
        node.position = {
          x,
          y: level * (NODE_HEIGHT + VERTICAL_GAP) + 50,
        };
        x += NODE_WIDTH + HORIZONTAL_GAP;
      }
    }
  }

  return Array.from(nodeMap.values());
}
