/**
 * Linter Adapter Types
 *
 * Pluggable linter system that supports multiple linters
 * (ESLint, Biome, Ruff, Clippy, etc.)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Lint Results
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single lint error or warning.
 */
export interface LintMessage {
  /** File path (absolute) */
  file: string;

  /** Line number (1-indexed) */
  line: number;

  /** Column number (1-indexed) */
  column: number;

  /** End line (optional) */
  endLine?: number;

  /** End column (optional) */
  endColumn?: number;

  /** Error message */
  message: string;

  /** Rule ID that triggered this message */
  ruleId: string;

  /** Severity level */
  severity: 'error' | 'warning' | 'info';

  /** Optional fix suggestion */
  fix?: {
    description: string;
    replacement?: string;
  };
}

/**
 * Result from running a linter.
 */
export interface LintResult {
  /** Whether linting passed (no errors, warnings OK) */
  success: boolean;

  /** Error messages */
  errors: LintMessage[];

  /** Warning messages */
  warnings: LintMessage[];

  /** Total files checked */
  filesChecked: number;

  /** Time taken in milliseconds */
  duration: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Linter Adapter Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Linter adapter interface.
 *
 * Each supported linter implements this interface.
 */
export interface LinterAdapter {
  /** Linter name (e.g., "eslint", "biome", "ruff") */
  name: string;

  /** Human-readable display name */
  displayName: string;

  /** File extensions this linter handles */
  extensions: string[];

  /**
   * Check if this linter's config exists in the workspace.
   * Used for auto-detection.
   */
  detect(workspaceRoot: string): Promise<boolean>;

  /**
   * Check if the linter binary is available.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Run the linter on specific files.
   *
   * @param files Absolute file paths to lint
   * @param workspaceRoot Workspace root for config resolution
   * @returns Lint results
   */
  lint(files: string[], workspaceRoot: string): Promise<LintResult>;

  /**
   * Optional: Get the linter version.
   */
  getVersion?(): Promise<string | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Command Adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Output format for custom command parsing.
 */
export type CustomOutputFormat =
  | 'eslint-json'  // ESLint JSON format
  | 'sarif'        // SARIF format (standard)
  | 'checkstyle'   // Checkstyle XML format
  | 'json-lines';  // One JSON object per line

/**
 * Configuration for a custom linter command.
 */
export interface CustomLinterConfig {
  /** Command template ({{files}} replaced with file list) */
  command: string;

  /** Output format to parse */
  outputFormat: CustomOutputFormat;

  /** File extensions this handles */
  extensions: string[];

  /** Optional: working directory */
  cwd?: string;

  /** Optional: environment variables */
  env?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation Config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Linter mode configuration.
 */
export type LinterMode =
  | 'auto'      // Auto-detect from config files
  | 'explicit'  // Use specified linter
  | 'disabled'; // Skip linting entirely

/**
 * Validation configuration for a workspace.
 */
export interface ValidationConfig {
  linter: {
    /** How to select the linter */
    mode: LinterMode;

    /** Linter name (when mode is 'explicit') */
    name?: string;

    /** Custom command config (escape hatch) */
    custom?: CustomLinterConfig;

    /** Files/patterns to exclude from linting */
    exclude?: string[];

    /** Only lint these files/patterns */
    include?: string[];
  };

  semanticRules: {
    /** Whether semantic rules are enabled */
    enabled: boolean;

    /** Override default validation/ path */
    paths?: string[];
  };
}

/**
 * Default validation configuration.
 */
export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  linter: {
    mode: 'auto',
    exclude: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
  },
  semanticRules: {
    enabled: true,
  },
};
