/**
 * Workflow System
 *
 * Node-based workflow engine for building and executing agent patterns.
 *
 * Key concepts:
 * - Nodes: Building blocks (agent, condition, transform, etc.)
 * - Edges: Connections between nodes
 * - Templates: Pre-built patterns (CCA, simple chat, etc.)
 * - Executor: Runtime that traverses and executes node graphs
 *
 * Users can:
 * - Use templates directly
 * - Modify templates in the visual editor
 * - Build custom workflows from scratch
 * - Create workflows via chat (AI-assisted)
 */

// Node system
export * from './nodes/index.ts';

// Templates
export * from './templates/index.ts';
