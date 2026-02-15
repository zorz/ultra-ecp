/**
 * Transform Utilities
 *
 * Provides template languages and data transformation utilities for workflow nodes:
 * - Handlebars-style templates with conditionals, loops, and helpers
 * - Safe JavaScript expression evaluation sandbox
 * - Variable extraction and mapping utilities
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TemplateOptions {
  /** Custom helpers to register */
  helpers?: Record<string, TemplateHelper>;
  /** Whether to escape HTML in output (default: false) */
  escapeHtml?: boolean;
  /** Strict mode - throw on missing variables (default: false) */
  strict?: boolean;
}

export type TemplateHelper = (
  ...args: unknown[]
) => unknown;

export interface SafeEvalOptions {
  /** Maximum execution time in milliseconds (default: 1000) */
  timeout?: number;
  /** Additional safe globals to expose */
  globals?: Record<string, unknown>;
  /** Maximum output size in characters (default: 100000) */
  maxOutputSize?: number;
}

export interface VariableMapping {
  /** Source path (dot notation) */
  from: string;
  /** Destination path (dot notation) */
  to: string;
  /** Optional transform to apply */
  transform?: 'string' | 'number' | 'boolean' | 'json' | 'uppercase' | 'lowercase' | 'trim';
  /** Default value if source is undefined */
  default?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlebars-Style Template Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Built-in template helpers.
 */
const BUILT_IN_HELPERS: Record<string, TemplateHelper> = {
  // String helpers
  uppercase: (value: unknown) => String(value ?? '').toUpperCase(),
  lowercase: (value: unknown) => String(value ?? '').toLowerCase(),
  capitalize: (value: unknown) => {
    const str = String(value ?? '');
    return str.charAt(0).toUpperCase() + str.slice(1);
  },
  trim: (value: unknown) => String(value ?? '').trim(),
  truncate: (value: unknown, length: unknown) => {
    const str = String(value ?? '');
    const len = Number(length) || 50;
    return str.length > len ? str.slice(0, len) + '...' : str;
  },
  replace: (value: unknown, search: unknown, replacement: unknown) => {
    return String(value ?? '').replace(String(search), String(replacement ?? ''));
  },
  split: (value: unknown, separator: unknown) => {
    return String(value ?? '').split(String(separator ?? ','));
  },
  join: (value: unknown, separator: unknown) => {
    if (Array.isArray(value)) {
      return value.join(String(separator ?? ', '));
    }
    return String(value ?? '');
  },

  // Number helpers
  add: (a: unknown, b: unknown) => Number(a) + Number(b),
  subtract: (a: unknown, b: unknown) => Number(a) - Number(b),
  multiply: (a: unknown, b: unknown) => Number(a) * Number(b),
  divide: (a: unknown, b: unknown) => {
    const divisor = Number(b);
    return divisor !== 0 ? Number(a) / divisor : 0;
  },
  round: (value: unknown, decimals?: unknown) => {
    const num = Number(value);
    const places = Number(decimals) || 0;
    return Number(num.toFixed(places));
  },
  abs: (value: unknown) => Math.abs(Number(value)),
  min: (...args: unknown[]) => Math.min(...args.map(Number)),
  max: (...args: unknown[]) => Math.max(...args.map(Number)),

  // Array helpers
  length: (value: unknown) => {
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'string') return value.length;
    if (value && typeof value === 'object') return Object.keys(value).length;
    return 0;
  },
  first: (value: unknown) => Array.isArray(value) ? value[0] : value,
  last: (value: unknown) => Array.isArray(value) ? value[value.length - 1] : value,
  at: (value: unknown, index: unknown) => {
    if (Array.isArray(value)) {
      const idx = Number(index);
      return value[idx < 0 ? value.length + idx : idx];
    }
    return undefined;
  },
  slice: (value: unknown, start: unknown, end?: unknown) => {
    if (Array.isArray(value) || typeof value === 'string') {
      return value.slice(Number(start), end !== undefined ? Number(end) : undefined);
    }
    return value;
  },
  reverse: (value: unknown) => {
    if (Array.isArray(value)) return [...value].reverse();
    if (typeof value === 'string') return value.split('').reverse().join('');
    return value;
  },
  sort: (value: unknown) => {
    if (Array.isArray(value)) return [...value].sort();
    return value;
  },
  unique: (value: unknown) => {
    if (Array.isArray(value)) return [...new Set(value)];
    return value;
  },
  flatten: (value: unknown) => {
    if (Array.isArray(value)) return value.flat();
    return value;
  },

  // Object helpers
  keys: (value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value);
    }
    return [];
  },
  values: (value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.values(value);
    }
    return [];
  },
  entries: (value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value);
    }
    return [];
  },
  get: (value: unknown, path: unknown) => getNestedValue(value, String(path)),
  has: (value: unknown, key: unknown) => {
    if (value && typeof value === 'object') {
      return String(key) in (value as Record<string, unknown>);
    }
    return false;
  },

  // JSON helpers
  json: (value: unknown, pretty?: unknown) => {
    try {
      return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
    } catch {
      return String(value);
    }
  },
  parse: (value: unknown) => {
    try {
      return JSON.parse(String(value));
    } catch {
      return value;
    }
  },

  // Date helpers
  now: () => new Date().toISOString(),
  date: (value: unknown, format?: unknown) => {
    const date = value ? new Date(String(value)) : new Date();
    if (isNaN(date.getTime())) return String(value);

    const fmt = String(format || 'iso');
    switch (fmt) {
      case 'iso': return date.toISOString();
      case 'date': return date.toDateString();
      case 'time': return date.toTimeString();
      case 'locale': return date.toLocaleString();
      case 'unix': return Math.floor(date.getTime() / 1000);
      default: return date.toISOString();
    }
  },

  // Comparison helpers (return boolean for conditionals)
  eq: (a: unknown, b: unknown) => a === b,
  ne: (a: unknown, b: unknown) => a !== b,
  lt: (a: unknown, b: unknown) => Number(a) < Number(b),
  lte: (a: unknown, b: unknown) => Number(a) <= Number(b),
  gt: (a: unknown, b: unknown) => Number(a) > Number(b),
  gte: (a: unknown, b: unknown) => Number(a) >= Number(b),
  and: (...args: unknown[]) => args.every(Boolean),
  or: (...args: unknown[]) => args.some(Boolean),
  not: (value: unknown) => !value,

  // Type helpers
  typeof: (value: unknown) => typeof value,
  isArray: (value: unknown) => Array.isArray(value),
  isObject: (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value),
  isString: (value: unknown) => typeof value === 'string',
  isNumber: (value: unknown) => typeof value === 'number' && !isNaN(value),
  isBoolean: (value: unknown) => typeof value === 'boolean',
  isNull: (value: unknown) => value === null,
  isUndefined: (value: unknown) => value === undefined,
  isEmpty: (value: unknown) => {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.length === 0;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
  },

  // Coercion helpers
  toString: (value: unknown) => String(value ?? ''),
  toNumber: (value: unknown) => Number(value) || 0,
  toBoolean: (value: unknown) => Boolean(value),
  default: (value: unknown, defaultValue: unknown) => value ?? defaultValue,
  coalesce: (...args: unknown[]) => args.find(v => v !== null && v !== undefined),
};

/**
 * Compile and render a Handlebars-style template.
 *
 * Supports:
 * - Variable interpolation: {{variable}}, {{object.nested.path}}
 * - Conditionals: {{#if condition}}...{{else}}...{{/if}}
 * - Inverse conditionals: {{#unless condition}}...{{/unless}}
 * - Loops: {{#each array}}...{{/each}} with {{@index}}, {{@first}}, {{@last}}, {{this}}
 * - Helpers: {{helperName arg1 arg2}}
 * - Raw blocks: {{{{raw}}}}...{{{{/raw}}}} (no processing)
 * - Comments: {{!-- comment --}}
 */
export function renderTemplate(
  template: string,
  data: Record<string, unknown>,
  options: TemplateOptions = {}
): string {
  const helpers = { ...BUILT_IN_HELPERS, ...options.helpers };
  const escapeHtml = options.escapeHtml ?? false;
  const strict = options.strict ?? false;

  // Remove comments
  let result = template.replace(/\{\{!--[\s\S]*?--\}\}/g, '');

  // Handle raw blocks (no processing)
  const rawBlocks: string[] = [];
  result = result.replace(/\{\{\{\{raw\}\}\}\}([\s\S]*?)\{\{\{\{\/raw\}\}\}\}/g, (_, content) => {
    rawBlocks.push(content);
    return `__RAW_BLOCK_${rawBlocks.length - 1}__`;
  });

  // Process block helpers (if, unless, each)
  result = processBlocks(result, data, helpers, strict);

  // Process inline helpers and variables
  result = result.replace(/\{\{([^}]+)\}\}/g, (match, expression) => {
    const trimmed = expression.trim();

    // Check if it's a helper call (has spaces)
    if (trimmed.includes(' ')) {
      return processHelper(trimmed, data, helpers);
    }

    // Simple variable lookup
    const value = getNestedValue(data, trimmed);
    if (value === undefined) {
      if (strict) throw new Error(`Missing variable: ${trimmed}`);
      return match; // Keep original if not found
    }

    const strValue = String(value);
    return escapeHtml ? escapeHtmlChars(strValue) : strValue;
  });

  // Restore raw blocks
  for (let i = 0; i < rawBlocks.length; i++) {
    result = result.replace(`__RAW_BLOCK_${i}__`, rawBlocks[i]!);
  }

  return result;
}

/**
 * Process block helpers (if, unless, each).
 */
function processBlocks(
  template: string,
  data: Record<string, unknown>,
  helpers: Record<string, TemplateHelper>,
  strict: boolean
): string {
  let result = template;

  // Process {{#each array}}...{{/each}}
  result = processEachBlocks(result, data, helpers, strict);

  // Process {{#if condition}}...{{else}}...{{/if}}
  result = processIfBlocks(result, data, helpers, strict);

  // Process {{#unless condition}}...{{/unless}}
  result = processUnlessBlocks(result, data, helpers, strict);

  return result;
}

/**
 * Process {{#each}} blocks.
 */
function processEachBlocks(
  template: string,
  data: Record<string, unknown>,
  helpers: Record<string, TemplateHelper>,
  strict: boolean
): string {
  const eachRegex = /\{\{#each\s+([^}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;

  return template.replace(eachRegex, (_, arrayExpr, block) => {
    const arrayPath = arrayExpr.trim();
    const array = getNestedValue(data, arrayPath);

    if (!Array.isArray(array)) {
      if (strict) throw new Error(`Expected array at ${arrayPath}`);
      return '';
    }

    return array.map((item, index) => {
      // Create context with special variables
      const context: Record<string, unknown> = {
        ...data,
        this: item,
        '@index': index,
        '@first': index === 0,
        '@last': index === array.length - 1,
        '@length': array.length,
      };

      // If item is an object, spread its properties
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        Object.assign(context, item);
      }

      // Recursively process the block
      let blockResult = processBlocks(block, context, helpers, strict);

      // Process variables in block
      blockResult = blockResult.replace(/\{\{([^}]+)\}\}/g, (match, expr) => {
        const trimmed = expr.trim();
        if (trimmed.includes(' ')) {
          return processHelper(trimmed, context, helpers);
        }
        const value = getNestedValue(context, trimmed);
        if (value === undefined) {
          if (strict) throw new Error(`Missing variable in each: ${trimmed}`);
          return match;
        }
        return String(value);
      });

      return blockResult;
    }).join('');
  });
}

/**
 * Process {{#if}} blocks.
 */
function processIfBlocks(
  template: string,
  data: Record<string, unknown>,
  helpers: Record<string, TemplateHelper>,
  strict: boolean
): string {
  // Match {{#if condition}}...{{else}}...{{/if}} or {{#if condition}}...{{/if}}
  const ifRegex = /\{\{#if\s+([^}]+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;

  return template.replace(ifRegex, (_, condition, ifBlock, elseBlock = '') => {
    const conditionValue = evaluateCondition(condition.trim(), data, helpers);
    const block = conditionValue ? ifBlock : elseBlock;

    // Recursively process the chosen block
    let result = processBlocks(block, data, helpers, strict);

    // Process variables
    result = result.replace(/\{\{([^}]+)\}\}/g, (match, expr) => {
      const trimmed = expr.trim();
      if (trimmed.includes(' ')) {
        return processHelper(trimmed, data, helpers);
      }
      const value = getNestedValue(data, trimmed);
      if (value === undefined) {
        if (strict) throw new Error(`Missing variable in if: ${trimmed}`);
        return match;
      }
      return String(value);
    });

    return result;
  });
}

/**
 * Process {{#unless}} blocks.
 */
function processUnlessBlocks(
  template: string,
  data: Record<string, unknown>,
  helpers: Record<string, TemplateHelper>,
  strict: boolean
): string {
  const unlessRegex = /\{\{#unless\s+([^}]+)\}\}([\s\S]*?)\{\{\/unless\}\}/g;

  return template.replace(unlessRegex, (_, condition, block) => {
    const conditionValue = evaluateCondition(condition.trim(), data, helpers);

    if (conditionValue) {
      return ''; // Condition is truthy, so don't render
    }

    // Recursively process the block
    let result = processBlocks(block, data, helpers, strict);

    result = result.replace(/\{\{([^}]+)\}\}/g, (match, expr) => {
      const trimmed = expr.trim();
      if (trimmed.includes(' ')) {
        return processHelper(trimmed, data, helpers);
      }
      const value = getNestedValue(data, trimmed);
      if (value === undefined) {
        if (strict) throw new Error(`Missing variable in unless: ${trimmed}`);
        return match;
      }
      return String(value);
    });

    return result;
  });
}

/**
 * Evaluate a condition expression.
 */
function evaluateCondition(
  expression: string,
  data: Record<string, unknown>,
  helpers: Record<string, TemplateHelper>
): boolean {
  // Check if it's a helper call
  if (expression.includes(' ')) {
    const result = processHelper(expression, data, helpers);
    return Boolean(result && result !== 'false' && result !== '0');
  }

  // Simple variable lookup
  const value = getNestedValue(data, expression);

  // Falsy values
  if (value === null || value === undefined || value === false || value === 0 || value === '') {
    return false;
  }

  // Empty arrays and objects
  if (Array.isArray(value) && value.length === 0) return false;
  if (typeof value === 'object' && Object.keys(value).length === 0) return false;

  return true;
}

/**
 * Process a helper call.
 */
function processHelper(
  expression: string,
  data: Record<string, unknown>,
  helpers: Record<string, TemplateHelper>
): string {
  // Parse helper call: helperName arg1 arg2 "quoted arg"
  const parts = parseHelperArgs(expression);
  if (parts.length === 0) return '';

  const helperName = parts[0]!;
  const helper = helpers[helperName];

  if (!helper) {
    // Not a helper, might be a path with spaces (unlikely but handle gracefully)
    return `{{${expression}}}`;
  }

  // Resolve arguments
  const args = parts.slice(1).map(arg => {
    // Quoted string
    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      return arg.slice(1, -1);
    }
    // Number
    if (!isNaN(Number(arg))) {
      return Number(arg);
    }
    // Boolean
    if (arg === 'true') return true;
    if (arg === 'false') return false;
    if (arg === 'null') return null;
    if (arg === 'undefined') return undefined;
    // Variable lookup
    return getNestedValue(data, arg);
  });

  try {
    const result = helper(...args);
    return String(result ?? '');
  } catch (err) {
    return `[Helper error: ${err}]`;
  }
}

/**
 * Parse helper arguments, respecting quoted strings.
 */
function parseHelperArgs(expression: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (const char of expression) {
    if (inQuote) {
      current += char;
      if (char === inQuote) {
        inQuote = null;
      }
    } else if (char === '"' || char === "'") {
      current += char;
      inQuote = char;
    } else if (char === ' ') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

/**
 * Escape HTML special characters.
 */
function escapeHtmlChars(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe JavaScript Sandbox
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safe globals available in the sandbox.
 */
const SAFE_GLOBALS: Record<string, unknown> = {
  // Math functions
  Math: {
    abs: Math.abs,
    ceil: Math.ceil,
    floor: Math.floor,
    round: Math.round,
    max: Math.max,
    min: Math.min,
    pow: Math.pow,
    sqrt: Math.sqrt,
    random: Math.random,
    PI: Math.PI,
    E: Math.E,
  },

  // String functions (via String prototype simulation)
  String: {
    fromCharCode: String.fromCharCode,
  },

  // Array functions
  Array: {
    isArray: Array.isArray,
    from: Array.from,
    of: Array.of,
  },

  // Object functions
  Object: {
    keys: Object.keys,
    values: Object.values,
    entries: Object.entries,
    fromEntries: Object.fromEntries,
    assign: Object.assign,
  },

  // JSON
  JSON: {
    parse: JSON.parse,
    stringify: JSON.stringify,
  },

  // Date (limited)
  Date: {
    now: Date.now,
    parse: Date.parse,
  },

  // Type checking
  isNaN,
  isFinite,
  parseInt,
  parseFloat,

  // Constants
  undefined,
  null: null,
  true: true,
  false: false,
  NaN,
  Infinity,
};

/**
 * Dangerous patterns to block in JavaScript code.
 */
const DANGEROUS_PATTERNS = [
  /\beval\b/,
  /\bFunction\b/,
  /\bimport\b/,
  /\brequire\b/,
  /\bprocess\b/,
  /\bglobal\b/,
  /\bwindow\b/,
  /\bdocument\b/,
  /\bfetch\b/,
  /\bXMLHttpRequest\b/,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\bsetImmediate\b/,
  /\b__proto__\b/,
  /\bprototype\b/,
  /\bconstructor\b/,
  /\bBun\b/,
  /\bDeno\b/,
];

/**
 * Safely evaluate a JavaScript expression in a sandbox.
 *
 * The sandbox provides:
 * - Safe math, string, array, object operations
 * - Input data via `input` variable
 * - Additional variables via `variables`
 * - Custom globals via options
 *
 * Blocked:
 * - eval, Function, require, import
 * - process, global, window, document
 * - Network APIs (fetch, XMLHttpRequest)
 * - Timers (setTimeout, setInterval)
 * - Prototype manipulation
 */
export function safeEval(
  code: string,
  input: unknown,
  variables: Record<string, unknown> = {},
  options: SafeEvalOptions = {}
): unknown {
  const { timeout = 1000, globals = {}, maxOutputSize = 100000 } = options;

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(`Dangerous pattern detected: ${pattern.source}`);
    }
  }

  // Build sandbox context
  const sandbox: Record<string, unknown> = {
    ...SAFE_GLOBALS,
    ...globals,
    input,
    variables,
    // Utility functions
    log: (...args: unknown[]) => args.map(a => JSON.stringify(a)).join(' '),
    print: (...args: unknown[]) => args.map(a => String(a)).join(' '),
  };

  // Create function with sandbox context
  const argNames = Object.keys(sandbox);
  const argValues = Object.values(sandbox);

  try {
    // Wrap code in a function that returns the result
    const wrappedCode = `
      "use strict";
      return (function() {
        ${code}
      })();
    `;

    // Create and execute function
    const fn = new Function(...argNames, wrappedCode);

    // Execute with timeout (basic implementation)
    const startTime = Date.now();
    const result = fn(...argValues);

    if (Date.now() - startTime > timeout) {
      throw new Error(`Execution timeout (${timeout}ms)`);
    }

    // Check output size
    const outputStr = JSON.stringify(result);
    if (outputStr && outputStr.length > maxOutputSize) {
      throw new Error(`Output exceeds maximum size (${maxOutputSize} chars)`);
    }

    return result;
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Safe eval error: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Evaluate a simple JavaScript expression (no statements).
 * More restrictive than safeEval but faster for simple cases.
 */
export function safeExpression(
  expression: string,
  data: Record<string, unknown>
): unknown {
  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(expression)) {
      throw new Error(`Dangerous pattern in expression: ${pattern.source}`);
    }
  }

  // Only allow simple expressions (no semicolons, assignments, etc.)
  if (/[;{}]/.test(expression)) {
    throw new Error('Statements not allowed in expressions');
  }

  // Build context with data
  const context: Record<string, unknown> = {
    ...SAFE_GLOBALS,
    ...data,
  };

  const argNames = Object.keys(context);
  const argValues = Object.values(context);

  try {
    const fn = new Function(...argNames, `"use strict"; return (${expression});`);
    return fn(...argValues);
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Expression error: ${err.message}`);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable Extraction and Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract and transform variables from input data.
 */
export function extractVariables(
  data: unknown,
  mappings: VariableMapping[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const mapping of mappings) {
    let value = getNestedValue(data, mapping.from);

    // Apply default if undefined
    if (value === undefined && mapping.default !== undefined) {
      value = mapping.default;
    }

    // Apply transform
    if (value !== undefined && mapping.transform) {
      value = applyTransform(value, mapping.transform);
    }

    // Set at destination path
    setNestedValue(result, mapping.to, value);
  }

  return result;
}

/**
 * Apply a transform to a value.
 */
function applyTransform(
  value: unknown,
  transform: VariableMapping['transform']
): unknown {
  switch (transform) {
    case 'string':
      return String(value ?? '');
    case 'number':
      return Number(value) || 0;
    case 'boolean':
      return Boolean(value);
    case 'json':
      try {
        return typeof value === 'string' ? JSON.parse(value) : value;
      } catch {
        return value;
      }
    case 'uppercase':
      return String(value ?? '').toUpperCase();
    case 'lowercase':
      return String(value ?? '').toLowerCase();
    case 'trim':
      return String(value ?? '').trim();
    default:
      return value;
  }
}

/**
 * Set a nested value in an object using dot notation.
 */
function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!(part in current) || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1];
  if (lastPart) {
    current[lastPart] = value;
  }
}

/**
 * Get a nested value from an object using dot notation.
 * Supports array indexing with [n] syntax.
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  if (!path) return obj;

  // Handle array indexing: foo.bar[0].baz
  const normalizedPath = path.replace(/\[(\d+)\]/g, '.$1');
  const parts = normalizedPath.split('.');

  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      const index = parseInt(part, 10);
      if (!isNaN(index)) {
        current = current[index];
        continue;
      }
    }

    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Flatten a nested object into dot-notation keys.
 */
export function flattenObject(
  obj: Record<string, unknown>,
  prefix = ''
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, newKey));
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

/**
 * Unflatten dot-notation keys into a nested object.
 */
export function unflattenObject(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    setNestedValue(result, key, value);
  }

  return result;
}

/**
 * Deep merge two objects.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export Helpers for External Use
// ─────────────────────────────────────────────────────────────────────────────

export { BUILT_IN_HELPERS };
