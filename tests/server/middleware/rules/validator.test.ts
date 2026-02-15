/**
 * Rule Validator Unit Tests
 */

import { describe, test, expect } from 'bun:test';
import {
  validateContent,
  formatViolationFeedback,
} from '../../../../src/server/middleware/rules/validator.ts';
import type { ParsedRule } from '../../../../src/server/middleware/rules/types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// validateContent - Import Rules
// ─────────────────────────────────────────────────────────────────────────────

describe('validateContent', () => {
  describe('import rules', () => {
    test('detects disallowed imports', () => {
      const content = `
import { something } from '../stores/userStore';
import { other } from './utils';
`;

      const rules: ParsedRule[] = [
        {
          id: 'no-store-import',
          disallowImports: ['**/stores/*'],
          message: 'Cannot import from stores',
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/src/component.tsx', content, rules);

      expect(result.success).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.rule.id).toBe('no-store-import');
      expect(result.violations[0]!.message).toContain('Cannot import from stores');
    });

    test('allows imports not matching pattern', () => {
      const content = `
import { something } from './utils';
import { other } from '../helpers';
`;

      const rules: ParsedRule[] = [
        {
          id: 'no-store-import',
          disallowImports: ['**/stores/*'],
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/src/component.tsx', content, rules);

      expect(result.success).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    test('respects allow-imports override', () => {
      const content = `
import { uiState } from '../stores/uiStore';
import { userData } from '../stores/userStore';
`;

      const rules: ParsedRule[] = [
        {
          id: 'limited-store',
          disallowImports: ['**/stores/*'],
          allowImports: ['**/stores/uiStore'],
          message: 'Only uiStore is allowed',
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/src/component.tsx', content, rules);

      expect(result.success).toBe(false);
      expect(result.violations).toHaveLength(1);
      // userStore should be blocked, uiStore should be allowed
      expect(result.violations[0]!.violatingContent).toContain('userStore');
    });

    test('respects except-types for type imports', () => {
      const content = `
import type { UserState } from '../stores/userStore';
import { userData } from '../stores/userStore';
`;

      const rules: ParsedRule[] = [
        {
          id: 'no-store-values',
          disallowImports: ['**/stores/*'],
          exceptTypes: true,
          message: 'Cannot import values from stores',
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/src/component.tsx', content, rules);

      expect(result.success).toBe(false);
      expect(result.violations).toHaveLength(1);
      // Type import should be allowed, value import should be blocked
      expect(result.violations[0]!.violatingContent).not.toContain('import type');
    });

    test('handles multiple disallowed patterns', () => {
      const content = `
import { store } from '../stores/main';
import { state } from '../state/global';
`;

      const rules: ParsedRule[] = [
        {
          id: 'no-global-state',
          disallowImports: ['**/stores/*', '**/state/*'],
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/src/component.tsx', content, rules);

      expect(result.success).toBe(false);
      expect(result.violations).toHaveLength(2);
    });

    test('handles default imports', () => {
      const content = `
import store from '../stores/main';
`;

      const rules: ParsedRule[] = [
        {
          id: 'no-store',
          disallowImports: ['**/stores/*'],
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/src/component.tsx', content, rules);

      expect(result.success).toBe(false);
    });

    test('handles namespace imports', () => {
      const content = `
import * as store from '../stores/main';
`;

      const rules: ParsedRule[] = [
        {
          id: 'no-store',
          disallowImports: ['**/stores/*'],
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/src/component.tsx', content, rules);

      expect(result.success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Require Rules
  // ─────────────────────────────────────────────────────────────────────────

  describe('require rules', () => {
    test('detects missing required pattern', () => {
      const content = `
export function MyComponent() {
  return <div>Hello</div>;
}
`;

      const rules: ParsedRule[] = [
        {
          id: 'require-props-interface',
          require: ['interface.*Props'],
          message: 'Components must define a Props interface',
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/src/MyComponent.tsx', content, rules);

      expect(result.success).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.message).toContain('Props interface');
    });

    test('passes when required pattern is present', () => {
      const content = `
interface MyComponentProps {
  name: string;
}

export function MyComponent({ name }: MyComponentProps) {
  return <div>Hello {name}</div>;
}
`;

      const rules: ParsedRule[] = [
        {
          id: 'require-props-interface',
          require: ['interface.*Props'],
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/src/MyComponent.tsx', content, rules);

      expect(result.success).toBe(true);
    });

    test('handles multiple require patterns', () => {
      const content = `
export function Component() {
  return <div />;
}
`;

      const rules: ParsedRule[] = [
        {
          id: 'require-exports',
          require: ['export default', 'export function'],
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/src/Component.tsx', content, rules);

      // Missing 'export default'
      expect(result.success).toBe(false);
      expect(result.violations).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Multiple Rules
  // ─────────────────────────────────────────────────────────────────────────

  describe('multiple rules', () => {
    test('checks all rules and collects all violations', () => {
      const content = `
import { store } from '../stores/main';

export function Component() {
  return <div />;
}
`;

      const rules: ParsedRule[] = [
        {
          id: 'no-store',
          disallowImports: ['**/stores/*'],
          sourceFile: 'test.md',
          sourceLine: 1,
        },
        {
          id: 'require-props',
          require: ['interface.*Props'],
          sourceFile: 'test.md',
          sourceLine: 5,
        },
      ];

      const result = validateContent('/src/Component.tsx', content, rules);

      expect(result.success).toBe(false);
      expect(result.violations).toHaveLength(2);
      expect(result.rulesChecked).toBe(2);
    });

    test('passes when all rules are satisfied', () => {
      const content = `
import { utils } from './utils';

interface ComponentProps {
  name: string;
}

export function Component({ name }: ComponentProps) {
  return <div>{name}</div>;
}
`;

      const rules: ParsedRule[] = [
        {
          id: 'no-store',
          disallowImports: ['**/stores/*'],
          sourceFile: 'test.md',
          sourceLine: 1,
        },
        {
          id: 'require-props',
          require: ['interface.*Props'],
          sourceFile: 'test.md',
          sourceLine: 5,
        },
      ];

      const result = validateContent('/src/Component.tsx', content, rules);

      expect(result.success).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Result Metadata
  // ─────────────────────────────────────────────────────────────────────────

  describe('result metadata', () => {
    test('includes rulesChecked count', () => {
      const result = validateContent('/test.ts', '', [
        { id: 'rule1', sourceFile: 'test.md', sourceLine: 1 },
        { id: 'rule2', sourceFile: 'test.md', sourceLine: 2 },
        { id: 'rule3', sourceFile: 'test.md', sourceLine: 3 },
      ]);

      expect(result.rulesChecked).toBe(3);
    });

    test('includes duration', () => {
      const result = validateContent('/test.ts', '', []);
      expect(typeof result.duration).toBe('number');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    test('violation includes line number', () => {
      const content = `
line 1
import { store } from '../stores/main';
line 3
`;

      const rules: ParsedRule[] = [
        {
          id: 'no-store',
          disallowImports: ['**/stores/*'],
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/test.ts', content, rules);

      expect(result.violations[0]!.line).toBe(3);
    });

    test('violation includes file path', () => {
      const content = `import { store } from '../stores/main';`;

      const rules: ParsedRule[] = [
        {
          id: 'no-store',
          disallowImports: ['**/stores/*'],
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/src/test.ts', content, rules);

      expect(result.violations[0]!.file).toBe('/src/test.ts');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge Cases
  // ─────────────────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('handles empty content', () => {
      const rules: ParsedRule[] = [
        {
          id: 'no-store',
          disallowImports: ['**/stores/*'],
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/test.ts', '', rules);

      expect(result.success).toBe(true);
    });

    test('handles empty rules', () => {
      const result = validateContent('/test.ts', 'some content', []);

      expect(result.success).toBe(true);
      expect(result.rulesChecked).toBe(0);
    });

    test('handles rules with no disallow or require', () => {
      const rules: ParsedRule[] = [
        {
          id: 'empty-rule',
          message: 'This rule has no checks',
          sourceFile: 'test.md',
          sourceLine: 1,
        },
      ];

      const result = validateContent('/test.ts', 'any content', rules);

      expect(result.success).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatViolationFeedback
// ─────────────────────────────────────────────────────────────────────────────

describe('formatViolationFeedback', () => {
  test('formats single violation', () => {
    const result = {
      success: false,
      violations: [
        {
          rule: { id: 'test-rule', sourceFile: 'rules.md', sourceLine: 1 },
          file: '/src/test.ts',
          line: 5,
          message: 'Test violation message',
          violatingContent: "import { bad } from 'bad-module';",
        },
      ],
      rulesChecked: 1,
      duration: 10,
    };

    const feedback = formatViolationFeedback(result);

    expect(feedback).toContain('1 violation');
    expect(feedback).toContain('/src/test.ts:5');
    expect(feedback).toContain('[test-rule]');
    expect(feedback).toContain('Test violation message');
    expect(feedback).toContain('bad-module');
  });

  test('formats multiple violations', () => {
    const result = {
      success: false,
      violations: [
        {
          rule: { id: 'rule-1', sourceFile: 'rules.md', sourceLine: 1 },
          file: '/src/a.ts',
          line: 1,
          message: 'Violation 1',
        },
        {
          rule: { id: 'rule-2', sourceFile: 'rules.md', sourceLine: 5 },
          file: '/src/b.ts',
          line: 10,
          message: 'Violation 2',
        },
      ],
      rulesChecked: 2,
      duration: 5,
    };

    const feedback = formatViolationFeedback(result);

    expect(feedback).toContain('2 violation');
    expect(feedback).toContain('[rule-1]');
    expect(feedback).toContain('[rule-2]');
  });

  test('truncates after 10 violations', () => {
    const violations = Array.from({ length: 15 }, (_, i) => ({
      rule: { id: `rule-${i}`, sourceFile: 'rules.md', sourceLine: i },
      file: `/src/file${i}.ts`,
      line: i,
      message: `Violation ${i}`,
    }));

    const result = {
      success: false,
      violations,
      rulesChecked: 15,
      duration: 10,
    };

    const feedback = formatViolationFeedback(result);

    expect(feedback).toContain('15 violation');
    expect(feedback).toContain('5 more violations');
    // Should only show first 10 in detail
    expect(feedback).toContain('[rule-0]');
    expect(feedback).toContain('[rule-9]');
    expect(feedback).not.toContain('[rule-10]');
  });

  test('handles violation without line number', () => {
    const result = {
      success: false,
      violations: [
        {
          rule: { id: 'test-rule', sourceFile: 'rules.md', sourceLine: 1 },
          file: '/src/test.ts',
          message: 'Missing pattern',
        },
      ],
      rulesChecked: 1,
      duration: 5,
    };

    const feedback = formatViolationFeedback(result);

    // Should show file without line number
    expect(feedback).toContain('/src/test.ts');
    expect(feedback).not.toContain('/src/test.ts:');
  });
});
