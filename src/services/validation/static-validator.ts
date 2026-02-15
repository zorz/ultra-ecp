/**
 * Static Validator
 *
 * Executes shell commands and parses their output for validation.
 * Provides built-in parsers for TypeScript, ESLint, and test runners.
 */

import type {
  ValidationResult,
  ValidationContext,
  ValidatorDefinition,
  ValidationDetails,
} from './types.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

/**
 * Output format for static validators.
 */
export type OutputFormat = 'text' | 'json' | 'typescript' | 'eslint' | 'jest' | 'tap';

/**
 * Parsed output from a static validator.
 */
export interface ParsedOutput {
  success: boolean;
  message: string;
  issues: ValidationDetails[];
  rawOutput: string;
  exitCode: number;
}

/**
 * Options for running a static validator.
 */
export interface StaticValidatorOptions {
  /** Shell command to execute */
  command: string;
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Output format for parsing */
  outputFormat?: OutputFormat;
  /** File paths to validate (replaces {{files}} in command) */
  filePaths?: string[];
}

/**
 * Execute a static validator command and parse output.
 */
export async function runStaticValidator(
  validator: ValidatorDefinition,
  context: ValidationContext,
  options: Partial<StaticValidatorOptions> = {}
): Promise<ValidationResult> {
  const startTime = Date.now();

  if (!validator.command) {
    return {
      status: 'skipped',
      validator: validator.id,
      severity: 'warning',
      message: 'Static validator has no command',
      durationMs: 0,
      cached: false,
    };
  }

  // Build command with file paths
  const filePaths = options.filePaths ?? context.files.map((f) => f.path);
  const command = buildCommand(validator.command, filePaths);

  log(`Executing: ${command}`);

  try {
    const result = await executeCommand(command, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? validator.behavior.timeoutMs ?? 30000,
    });

    const parsed = parseOutput(
      result.stdout,
      result.stderr,
      result.exitCode,
      options.outputFormat ?? detectOutputFormat(validator.command)
    );

    const durationMs = Date.now() - startTime;

    if (parsed.success) {
      return {
        status: 'approved',
        validator: validator.id,
        severity: 'info',
        message: parsed.message || 'Validation passed',
        durationMs,
        cached: false,
        details: parsed.issues.length > 0 ? parsed.issues[0] : undefined,
        metadata: { rawOutput: parsed.rawOutput },
      };
    } else {
      return {
        status: 'rejected',
        validator: validator.id,
        severity: validator.behavior.onFailure === 'error' ? 'error' : 'warning',
        message: parsed.message,
        durationMs,
        cached: false,
        details: parsed.issues.length > 0 ? parsed.issues[0] : undefined,
        metadata: {
          rawOutput: parsed.rawOutput,
          allIssues: parsed.issues,
          issueCount: parsed.issues.length,
        },
      };
    }
  } catch (error) {
    return {
      status: 'rejected',
      validator: validator.id,
      severity: 'error',
      message: `Command execution failed: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startTime,
      cached: false,
    };
  }
}

/**
 * Build command string with file path substitution.
 */
function buildCommand(template: string, filePaths: string[]): string {
  const quotedPaths = filePaths.map((p) => `"${p}"`).join(' ');

  if (template.includes('{{files}}')) {
    return template.replace('{{files}}', quotedPaths);
  }

  // If command already has files placeholder or no files needed, use as-is
  if (filePaths.length === 0 || template.includes('--')) {
    return template;
  }

  // Append files to command
  return `${template} ${quotedPaths}`;
}

/**
 * Execute a shell command.
 */
async function executeCommand(
  command: string,
  options: { cwd?: string; env?: Record<string, string>; timeoutMs: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const proc = Bun.spawn(['sh', '-c', command], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Detect output format from command.
 */
function detectOutputFormat(command: string): OutputFormat {
  const lower = command.toLowerCase();

  if (lower.includes('tsc') || lower.includes('typescript')) {
    return 'typescript';
  }
  if (lower.includes('eslint')) {
    if (lower.includes('--format json') || lower.includes('-f json')) {
      return 'eslint';
    }
  }
  if (lower.includes('jest') || lower.includes('--json')) {
    return 'jest';
  }
  if (lower.includes('bun test') || lower.includes('vitest')) {
    return 'text';
  }

  return 'text';
}

/**
 * Parse command output based on format.
 */
function parseOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
  format: OutputFormat
): ParsedOutput {
  const rawOutput = stdout + (stderr ? '\n' + stderr : '');

  switch (format) {
    case 'typescript':
      return parseTypeScriptOutput(stdout, stderr, exitCode);
    case 'eslint':
      return parseESLintOutput(stdout, stderr, exitCode);
    case 'jest':
      return parseJestOutput(stdout, stderr, exitCode);
    case 'json':
      return parseJSONOutput(stdout, stderr, exitCode);
    case 'tap':
      return parseTAPOutput(stdout, stderr, exitCode);
    default:
      return parseTextOutput(stdout, stderr, exitCode);
  }
}

/**
 * Parse TypeScript compiler output.
 */
function parseTypeScriptOutput(
  stdout: string,
  stderr: string,
  exitCode: number
): ParsedOutput {
  const output = stdout || stderr;
  const issues: ValidationDetails[] = [];

  // TypeScript error format: path(line,col): error TSxxxx: message
  const errorRegex = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let match;

  while ((match = errorRegex.exec(output)) !== null) {
    issues.push({
      file: match[1],
      line: parseInt(match[2]!, 10),
      column: parseInt(match[3]!, 10),
      reasoning: `${match[5]}: ${match[6]}`,
    });
  }

  // Also handle format: path:line:col - error TSxxxx: message
  const altErrorRegex = /^(.+):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  while ((match = altErrorRegex.exec(output)) !== null) {
    issues.push({
      file: match[1],
      line: parseInt(match[2]!, 10),
      column: parseInt(match[3]!, 10),
      reasoning: `${match[5]}: ${match[6]}`,
    });
  }

  const success = exitCode === 0;
  let message = success ? 'TypeScript: No errors found' : '';

  if (!success && issues.length > 0) {
    message = `TypeScript: ${issues.length} error(s) found`;
  } else if (!success) {
    message = output.trim().split('\n')[0] || 'TypeScript compilation failed';
  }

  return {
    success,
    message,
    issues,
    rawOutput: output,
    exitCode,
  };
}

/**
 * Parse ESLint JSON output.
 */
function parseESLintOutput(
  stdout: string,
  stderr: string,
  exitCode: number
): ParsedOutput {
  const issues: ValidationDetails[] = [];

  try {
    // ESLint JSON output is an array of file results
    const results = JSON.parse(stdout) as Array<{
      filePath: string;
      messages: Array<{
        line: number;
        column: number;
        message: string;
        ruleId: string | null;
        severity: number;
      }>;
      errorCount: number;
      warningCount: number;
    }>;

    let totalErrors = 0;
    let totalWarnings = 0;

    for (const result of results) {
      totalErrors += result.errorCount;
      totalWarnings += result.warningCount;

      for (const msg of result.messages) {
        issues.push({
          file: result.filePath,
          line: msg.line,
          column: msg.column,
          reasoning: msg.ruleId ? `[${msg.ruleId}] ${msg.message}` : msg.message,
          suggestedFix: undefined, // Could add autofix suggestion
        });
      }
    }

    const success = totalErrors === 0;
    let message: string;

    if (success && totalWarnings === 0) {
      message = 'ESLint: No issues found';
    } else if (success) {
      message = `ESLint: ${totalWarnings} warning(s)`;
    } else {
      message = `ESLint: ${totalErrors} error(s), ${totalWarnings} warning(s)`;
    }

    return {
      success,
      message,
      issues,
      rawOutput: stdout,
      exitCode,
    };
  } catch {
    // Fall back to text parsing if JSON parsing fails
    log('ESLint JSON parsing failed, falling back to text');
    return parseTextOutput(stdout, stderr, exitCode);
  }
}

/**
 * Parse Jest JSON output.
 */
function parseJestOutput(
  stdout: string,
  stderr: string,
  exitCode: number
): ParsedOutput {
  const issues: ValidationDetails[] = [];

  try {
    const result = JSON.parse(stdout) as {
      success: boolean;
      numFailedTests: number;
      numPassedTests: number;
      numTotalTests: number;
      testResults: Array<{
        name: string;
        status: string;
        message: string;
        assertionResults: Array<{
          title: string;
          status: string;
          failureMessages: string[];
        }>;
      }>;
    };

    for (const testFile of result.testResults) {
      if (testFile.status === 'failed') {
        for (const assertion of testFile.assertionResults) {
          if (assertion.status === 'failed') {
            issues.push({
              file: testFile.name,
              reasoning: `${assertion.title}: ${assertion.failureMessages.join('\n')}`,
            });
          }
        }
      }
    }

    const success = result.success;
    const message = success
      ? `Tests: ${result.numPassedTests}/${result.numTotalTests} passed`
      : `Tests: ${result.numFailedTests}/${result.numTotalTests} failed`;

    return {
      success,
      message,
      issues,
      rawOutput: stdout,
      exitCode,
    };
  } catch {
    // Fall back to text parsing
    log('Jest JSON parsing failed, falling back to text');
    return parseTextOutput(stdout, stderr, exitCode);
  }
}

/**
 * Parse generic JSON output.
 */
function parseJSONOutput(
  stdout: string,
  stderr: string,
  exitCode: number
): ParsedOutput {
  try {
    const result = JSON.parse(stdout);
    const success = exitCode === 0 || result.success === true || result.status === 'approved';
    const message = result.message || (success ? 'Validation passed' : 'Validation failed');

    const issues: ValidationDetails[] = [];
    if (Array.isArray(result.issues)) {
      for (const issue of result.issues) {
        issues.push({
          file: issue.file,
          line: issue.line,
          column: issue.column,
          reasoning: issue.message || issue.reasoning,
          suggestedFix: issue.fix || issue.suggestedFix,
        });
      }
    }

    return {
      success,
      message,
      issues,
      rawOutput: stdout || stderr,
      exitCode,
    };
  } catch {
    return parseTextOutput(stdout, stderr, exitCode);
  }
}

/**
 * Parse TAP (Test Anything Protocol) output.
 */
function parseTAPOutput(
  stdout: string,
  _stderr: string,
  exitCode: number
): ParsedOutput {
  const issues: ValidationDetails[] = [];
  const lines = stdout.split('\n');

  let passed = 0;
  let failed = 0;

  for (const line of lines) {
    if (line.startsWith('ok ')) {
      passed++;
    } else if (line.startsWith('not ok ')) {
      failed++;
      // Extract test name
      const match = line.match(/^not ok \d+ - (.+)$/);
      if (match) {
        issues.push({
          reasoning: match[1],
        });
      }
    }
  }

  const success = failed === 0 && exitCode === 0;
  const message = success
    ? `TAP: ${passed} test(s) passed`
    : `TAP: ${failed} test(s) failed, ${passed} passed`;

  return {
    success,
    message,
    issues,
    rawOutput: stdout,
    exitCode,
  };
}

/**
 * Parse plain text output.
 */
function parseTextOutput(
  stdout: string,
  stderr: string,
  exitCode: number
): ParsedOutput {
  const output = stdout || stderr;
  const success = exitCode === 0;

  // Try to extract error count or summary
  let message: string;
  if (success) {
    message = output.trim().split('\n').slice(-1)[0] || 'Validation passed';
  } else {
    // Look for error summary lines
    const lines = output.split('\n');
    const errorLine = lines.find(
      (l) =>
        l.includes('error') ||
        l.includes('failed') ||
        l.includes('Error') ||
        l.includes('FAIL')
    );
    message = errorLine || lines[0] || 'Validation failed';
  }

  // Try to extract file:line:col patterns
  const issues: ValidationDetails[] = [];
  const fileLineRegex = /([^\s:]+):(\d+)(?::(\d+))?[:\s]+(.+)/g;
  let match;

  while ((match = fileLineRegex.exec(output)) !== null) {
    // Skip if it looks like a path or URL
    if (match[1]!.includes('node_modules') || match[1]!.startsWith('http')) {
      continue;
    }

    issues.push({
      file: match[1],
      line: parseInt(match[2]!, 10),
      column: match[3] ? parseInt(match[3], 10) : undefined,
      reasoning: match[4],
    });
  }

  return {
    success,
    message: message.trim(),
    issues,
    rawOutput: output,
    exitCode,
  };
}

/**
 * Create a TypeScript validator definition.
 */
export function createTypeScriptValidator(
  options: Partial<ValidatorDefinition> = {}
): ValidatorDefinition {
  return {
    id: 'typescript',
    name: 'TypeScript Type Check',
    type: 'static',
    enabled: true,
    priority: 10,
    command: 'tsc --noEmit',
    triggers: ['pre-write', 'pre-commit'],
    filePatterns: ['**/*.ts', '**/*.tsx'],
    behavior: {
      onFailure: 'error',
      blockOnFailure: true,
      required: true,
      timeoutMs: 60000,
      onTimeout: 'error',
      cacheable: true,
      ...options.behavior,
    },
    ...options,
  };
}

/**
 * Create an ESLint validator definition.
 */
export function createESLintValidator(
  options: Partial<ValidatorDefinition> = {}
): ValidatorDefinition {
  return {
    id: 'eslint',
    name: 'ESLint',
    type: 'static',
    enabled: true,
    priority: 20,
    command: 'eslint --format json {{files}}',
    triggers: ['pre-write'],
    filePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    behavior: {
      onFailure: 'warning',
      blockOnFailure: false,
      required: false,
      timeoutMs: 30000,
      onTimeout: 'warning',
      cacheable: true,
      ...options.behavior,
    },
    ...options,
  };
}

/**
 * Create a test runner validator definition.
 */
export function createTestValidator(
  options: Partial<ValidatorDefinition> = {}
): ValidatorDefinition {
  return {
    id: 'tests',
    name: 'Test Suite',
    type: 'static',
    enabled: true,
    priority: 100,
    command: 'bun test --bail',
    triggers: ['pre-commit'],
    behavior: {
      onFailure: 'error',
      blockOnFailure: true,
      required: true,
      timeoutMs: 300000, // 5 minutes
      onTimeout: 'error',
      cacheable: false, // Always run tests
      ...options.behavior,
    },
    ...options,
  };
}

/**
 * Create a formatter validator (e.g., Prettier).
 */
export function createFormatterValidator(
  options: Partial<ValidatorDefinition> = {}
): ValidatorDefinition {
  return {
    id: 'formatter',
    name: 'Code Formatter',
    type: 'static',
    enabled: true,
    priority: 5,
    command: 'prettier --check {{files}}',
    triggers: ['pre-write'],
    filePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.json'],
    behavior: {
      onFailure: 'warning',
      blockOnFailure: false,
      required: false,
      timeoutMs: 30000,
      onTimeout: 'skip',
      cacheable: true,
      ...options.behavior,
    },
    ...options,
  };
}

/**
 * Create a custom static validator.
 */
export function createStaticValidator(
  id: string,
  name: string,
  command: string,
  options: Partial<Omit<ValidatorDefinition, 'id' | 'name' | 'command'>> = {}
): ValidatorDefinition {
  return {
    id,
    name,
    type: 'static',
    enabled: true,
    priority: 50,
    command,
    triggers: ['pre-write'],
    behavior: {
      onFailure: 'warning',
      blockOnFailure: false,
      required: false,
      timeoutMs: 30000,
      onTimeout: 'warning',
      cacheable: true,
      ...options.behavior,
    },
    ...options,
  };
}

function log(msg: string): void {
  if (isDebugEnabled()) {
    debugLog(`[StaticValidator] ${msg}`);
  }
}
