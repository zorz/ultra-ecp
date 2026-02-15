/**
 * Enhanced Permission Types for Ensemble Framework
 *
 * Extends the base permission system with:
 * - Command pattern matching
 * - Risk levels for operations
 * - Detailed permission rules
 */

// ============================================
// Risk Levels
// ============================================

/**
 * Risk level for operations.
 * Determines the approval flow.
 */
export type RiskLevel =
  | 'safe'       // No approval needed (read operations)
  | 'low'        // Single approval
  | 'medium'     // Approval with feedback option
  | 'high'       // Approval required, cannot be auto-approved
  | 'dangerous'; // Double confirmation required

// ============================================
// Permission Rules
// ============================================

/**
 * A permission rule with pattern matching.
 */
export interface PermissionRule {
  /** Rule ID */
  id: string;
  /** Tool name (e.g., 'Bash', 'Write', 'Edit') */
  tool: string;
  /** Pattern to match (glob-style for paths, regex for commands) */
  pattern?: string;
  /** Whether this is an allow or deny rule */
  action: 'allow' | 'deny';
  /** Scope of the rule */
  scope: 'once' | 'session' | 'folder' | 'global';
  /** Folder path if scope is 'folder' */
  folderPath?: string;
  /** Risk level override */
  riskLevel?: RiskLevel;
  /** Description for display */
  description?: string;
  /** When the rule was created */
  createdAt: number;
  /** When the rule expires (optional) */
  expiresAt?: number;
}

/**
 * Result of permission evaluation.
 */
export interface PermissionEvaluation {
  /** Whether the action is allowed */
  allowed: boolean;
  /** Risk level of the action */
  riskLevel: RiskLevel;
  /** Matching rule if any */
  matchingRule?: PermissionRule;
  /** Reason for the decision */
  reason: string;
  /** Whether user confirmation is required */
  requiresConfirmation: boolean;
  /** Whether double confirmation is required (for dangerous operations) */
  requiresDoubleConfirmation: boolean;
}

// ============================================
// Tool Categories
// ============================================

/**
 * Predefined tool categories with default risk levels.
 */
export const TOOL_RISK_LEVELS: Record<string, RiskLevel> = {
  // Safe - no approval needed
  'Read': 'safe',
  'Glob': 'safe',
  'Grep': 'safe',
  'LSP': 'safe',

  // Low - single approval
  'Write': 'low',
  'Edit': 'low',
  'NotebookEdit': 'low',

  // Medium - approval with feedback
  'Bash': 'medium',
  'Task': 'medium',

  // Dangerous commands patterns
  'Bash:rm': 'dangerous',
  'Bash:git reset': 'high',
  'Bash:git push --force': 'dangerous',
  'Bash:sudo': 'dangerous',
  'Bash:chmod': 'high',
  'Bash:mv': 'medium',
  'Bash:cp': 'low',
};

/**
 * Patterns for dangerous bash commands.
 */
export const DANGEROUS_COMMAND_PATTERNS = [
  /^rm\s+(-[rf]+\s+)?.*$/,           // rm, rm -rf
  /^sudo\s+/,                         // sudo anything
  /^chmod\s+/,                        // chmod
  /^chown\s+/,                        // chown
  /^git\s+reset\s+--hard/,           // git reset --hard
  /^git\s+push\s+.*--force/,         // git push --force
  /^git\s+push\s+-f/,                // git push -f
  /^>\s*\//,                          // Redirect to root
  /\|\s*sudo/,                        // Pipe to sudo
  /;\s*rm\s+/,                        // Command chain with rm
  /&&\s*rm\s+/,                       // Command chain with rm
];

/**
 * Patterns for high-risk bash commands.
 */
export const HIGH_RISK_COMMAND_PATTERNS = [
  /^git\s+reset/,                    // git reset
  /^git\s+checkout\s+\./,            // git checkout .
  /^git\s+clean/,                    // git clean
  /^mv\s+.*\//,                      // mv to different directory
  /^dd\s+/,                          // dd command
  // Package managers (can execute arbitrary scripts)
  /^npm\s+(install|i|ci|run|exec)/,  // npm install, run, exec
  /^npx\s+/,                         // npx
  /^yarn(\s+|$)/,                    // yarn (any command)
  /^pnpm\s+(install|i|run|exec)/,   // pnpm install, run, exec
  /^bun\s+(install|i|run|x)/,       // bun install, run, x
  /^pip\s+install/,                  // pip install
  /^pip3\s+install/,                 // pip3 install
  /^cargo\s+(install|run)/,         // cargo install, run
  /^go\s+(install|run|get)/,        // go install, run, get
  /^gem\s+install/,                  // gem install
  /^composer\s+(install|require)/,  // composer install, require
  /^brew\s+install/,                 // homebrew install
  /^apt(-get)?\s+install/,          // apt install
  /^curl\s+.*\|\s*(ba)?sh/,         // curl | sh pattern
  /^wget\s+.*\|\s*(ba)?sh/,         // wget | sh pattern
];

// ============================================
// Permission Request
// ============================================

/**
 * A request for permission approval.
 */
export interface PermissionRequest {
  /** Request ID */
  id: string;
  /** Session ID */
  sessionId: string;
  /** Tool name */
  tool: string;
  /** Operation description */
  description: string;
  /** Full command/path/input for display */
  input: string;
  /** Risk level */
  riskLevel: RiskLevel;
  /** Available scope options */
  scopeOptions: Array<{
    scope: PermissionRule['scope'];
    label: string;
    description: string;
  }>;
  /** Whether this requires double confirmation */
  doubleConfirm: boolean;
  /** Timestamp */
  timestamp: number;
}

/**
 * Response to a permission request.
 */
export interface PermissionResponse {
  /** Request ID being responded to */
  requestId: string;
  /** Whether permission was granted */
  granted: boolean;
  /** Selected scope if granted */
  scope?: PermissionRule['scope'];
  /** Folder path if folder scope */
  folderPath?: string;
  /** Optional pattern to create a rule for */
  pattern?: string;
  /** User feedback/notes */
  feedback?: string;
  /** Timestamp */
  timestamp: number;
}

// ============================================
// Permission Prompt Options
// ============================================

/**
 * Options for displaying permission prompt.
 */
export interface PermissionPromptOptions {
  /** Title for the prompt */
  title: string;
  /** Message/description */
  message: string;
  /** The tool being used */
  tool: string;
  /** The input/command/path */
  input: string;
  /** Risk level */
  riskLevel: RiskLevel;
  /** Available choices */
  choices: PermissionChoice[];
  /** Default selected choice index */
  defaultChoice?: number;
  /** Whether to show scope options */
  showScopeOptions?: boolean;
  /** Whether double confirmation is needed */
  doubleConfirm?: boolean;
}

/**
 * A choice in the permission prompt.
 */
export interface PermissionChoice {
  /** Choice key (for keyboard shortcut) */
  key: string;
  /** Display label */
  label: string;
  /** Description */
  description: string;
  /** Action type */
  action: 'allow' | 'deny' | 'allow-once' | 'allow-session' | 'allow-folder' | 'allow-always';
  /** Scope if action is allow */
  scope?: PermissionRule['scope'];
}
