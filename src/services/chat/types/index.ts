/**
 * Chat Types Index
 *
 * Re-exports all type definitions for the chat system.
 */

// Message types
export type {
  ITextBlock,
  IToolUseBlock,
  IToolResultBlock,
  IImageBlock,
  IContentBlock,
  IUsageStats,
  IBaseMessage,
  IContentMessage,
  ISessionMessage,
  IUserMessage,
  IToolUse,
  IAssistantMessage,
  IToolResultMessage,
  ISystemMessage,
  IAgentMessage,
  IStreamingMessage,
  IAnyMessage,
} from './messages.ts';

export {
  isUserMessage,
  isAssistantMessage,
  isToolResultMessage,
  isAgentMessage,
  isStreamingMessage,
  getMessageText,
  getToolUses,
} from './messages.ts';

// Permission types
export type {
  PermissionScope,
  PermissionDecision,
  IPermission,
  IPermissionRequest,
  IPermissionCheckResult,
  IGrantPermissionOptions,
  IPermissionStore,
} from './permissions.ts';

export {
  SCOPE_PRIORITY,
  isMoreSpecific,
  getDefaultExpiration,
} from './permissions.ts';

// Agent types
export type {
  AgentRole,
  AgentStatus,
  IAgentConfig,
  IAgent,
  IDelegationRequest,
  IDelegationResult,
  IAgentMention,
  IAgentManager,
} from './agents.ts';

export {
  DEFAULT_AGENTS,
  parseAgentMentions,
} from './agents.ts';
