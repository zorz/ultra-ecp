/**
 * Workflow Node System
 *
 * A generic node-based workflow engine for building any agent pattern.
 */

// Core types
export * from './types.ts';

// Executor
export {
  WorkflowExecutor,
  registerNodeExecutor,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutorFn,
  type WorkflowExecutorOptions,
} from './executor.ts';

// Conversion layer (editor ↔ backend)
export {
  editorWorkflowToBackend,
  backendWorkflowToEditor,
  validateWorkflow,
  autoLayoutNodes,
  type EditorNode,
  type EditorEdge,
  type EditorWorkflow,
  type ValidationError,
} from './conversion.ts';
