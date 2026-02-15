/**
 * Working Set Middleware
 *
 * Minimal enforcement for folder-anchored Balanced governance.
 *
 * Current scope (intentionally coarse):
 * - Block file write/edit/delete/rename/create* outside effective working set.
 * - Block terminal/execute and terminal/spawn when working set is empty.
 *
 * Notes:
 * - This is NOT a full policy engine.
 * - We intentionally avoid deep shell parsing in this iteration.
 */

import type { ECPMiddleware, MiddlewareContext, MiddlewareResult } from './types.ts';

const PROJECT_KEY = 'ultra.governance.workingSet.project';
const SESSION_KEY = 'ultra.governance.workingSet.session';

const FILE_MUTATION_METHODS = new Set([
  'file/write',
  'file/edit',
  'file/delete',
  'file/deleteDir',
  'file/rename',
  'file/create',
  'file/createDirectory',
  'file/createDir',
]);

const TERMINAL_EXEC_METHODS = new Set([
  'terminal/execute',
  'terminal/spawn',
]);

function uriToPath(uriOrPath: string): string {
  if (uriOrPath.startsWith('file://')) return uriOrPath.slice(7);
  return uriOrPath;
}

function normalizeFolder(folder: string): string {
  // Normalize to a relative-ish folder with no trailing slash.
  // We store folders as user-entered (relative to workspace root), so we just trim.
  return folder.trim().replace(/\/+$/g, '');
}

function isInsideFolder(absPath: string, workspaceRoot: string, folderRel: string): boolean {
  const root = workspaceRoot.replace(/\/+$/g, '');
  const rel = normalizeFolder(folderRel);
  if (!rel) return false;

  const folderAbs = `${root}/${rel}`;
  return absPath === folderAbs || absPath.startsWith(folderAbs + '/');
}

function getEffectiveWorkingSet(ctx: MiddlewareContext): string[] {
  const settings = (ctx.metadata['settings'] as Record<string, unknown> | undefined) ?? undefined;
  if (!settings) return [];

  const project = Array.isArray(settings[PROJECT_KEY]) ? settings[PROJECT_KEY] as unknown[] : [];
  const session = settings[SESSION_KEY];

  const projectFolders = project.filter((v): v is string => typeof v === 'string').map(normalizeFolder).filter(Boolean);

  if (session === undefined || session === null) {
    return projectFolders;
  }

  const sessionFolders = Array.isArray(session)
    ? (session as unknown[]).filter((v): v is string => typeof v === 'string').map(normalizeFolder).filter(Boolean)
    : [];

  return sessionFolders;
}

function extractTargetPaths(method: string, params: unknown): string[] {
  const p = (params ?? {}) as Record<string, unknown>;

  const readString = (key: string): string | null => {
    const v = p[key];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };

  // file/* tends to use uri, but some callers use path.
  if (method === 'file/rename') {
    const oldUri = readString('oldUri') ?? readString('old_uri') ?? readString('oldPath') ?? readString('old_path');
    const newUri = readString('newUri') ?? readString('new_uri') ?? readString('newPath') ?? readString('new_path');
    return [oldUri, newUri].filter((x): x is string => Boolean(x)).map(uriToPath);
  }

  const uri = readString('uri');
  const path = readString('path');
  const filePath = readString('file_path');

  return [uri, path, filePath].filter((x): x is string => Boolean(x)).map(uriToPath);
}

export class WorkingSetMiddleware implements ECPMiddleware {
  name = 'working-set';
  // Run before validation so we fail fast.
  priority = 40;

  private isEnforcementEnabled(ctx: MiddlewareContext): boolean {
    const s = ctx.metadata['settings'] as Record<string, unknown> | undefined;
    return Boolean(s?.['governance.workingSet.enforcementEnabled']);
  }

  private getCaller(ctx: MiddlewareContext):
    | { type: 'human' }
    | { type: 'agent'; agentId?: string; executionId?: string; roleType?: string } {
    // Caller identity must be asserted by the server at the ECP boundary.
    // Do NOT trust user/agent-provided params for security decisions.
    const asserted = ctx.metadata['caller'] as Record<string, unknown> | undefined;

    if (asserted?.type === 'agent') {
      return {
        type: 'agent',
        agentId: typeof asserted.agentId === 'string' ? asserted.agentId : undefined,
        executionId: typeof asserted.executionId === 'string' ? asserted.executionId : undefined,
        roleType: typeof asserted.roleType === 'string' ? asserted.roleType : undefined,
      };
    }

    // Default: treat as human UI call.
    return { type: 'human' };
  }

  private appliesToCaller(ctx: MiddlewareContext): boolean {
    const caller = this.getCaller(ctx);
    if (caller.type === 'human') return false;

    const s = ctx.metadata['settings'] as Record<string, unknown> | undefined;
    const bypassAgents = Array.isArray(s?.['governance.workingSet.bypassAgents'])
      ? (s?.['governance.workingSet.bypassAgents'] as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    const bypassRoles = Array.isArray(s?.['governance.workingSet.bypassRoles'])
      ? (s?.['governance.workingSet.bypassRoles'] as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];

    // Deny-list semantics:
    // - default: governance applies to all agents
    // - bypass lists: exempt specific agents/roles
    if (bypassAgents.length > 0 && caller.agentId && bypassAgents.includes(caller.agentId)) {
      return false;
    }

    if (bypassRoles.length > 0 && caller.roleType && bypassRoles.includes(caller.roleType)) {
      return false;
    }

    return true;
  }

  appliesTo(method: string): boolean {
    return FILE_MUTATION_METHODS.has(method) || TERMINAL_EXEC_METHODS.has(method);
  }

  async validate(ctx: MiddlewareContext): Promise<MiddlewareResult> {
    if (!this.isEnforcementEnabled(ctx)) return { allowed: true };

    // Working set is agent governance only. Never block human UI actions.
    if (!this.appliesToCaller(ctx)) return { allowed: true };

    const effective = getEffectiveWorkingSet(ctx);

    // Terminal enforcement: require non-empty working set.
    // NOTE: This does not attempt to parse shell commands. It only prevents the
    // most dangerous "empty working set" case.
    if (TERMINAL_EXEC_METHODS.has(ctx.method)) {
      if (effective.length === 0) {
        return {
          allowed: false,
          feedback: 'Working set is empty. Set it before running terminal commands.',
          errorData: { code: 'WORKING_SET_EMPTY' },
        };
      }
      return { allowed: true };
    }

    // File mutation enforcement: require target inside working set.
    const targets = extractTargetPaths(ctx.method, ctx.params);
    // Default-deny: if this is a file mutation method and we can't extract a target,
    // treat it as suspicious rather than allowing a bypass via param-shape.
    if (targets.length === 0) {
      return {
        allowed: false,
        feedback: `Blocked ${ctx.method}: could not determine target path(s).`,
        errorData: { code: 'WORKING_SET_TARGET_UNKNOWN' },
      };
    }

    // If no working set, block all mutations.
    if (effective.length === 0) {
      return {
        allowed: false,
        feedback: 'Working set is empty. Set it before modifying files.',
        errorData: { code: 'WORKING_SET_EMPTY' },
      };
    }

    const wsRoot = ctx.workspaceRoot;

    for (const t of targets) {
      const abs = t.startsWith(wsRoot) ? t : `${wsRoot}/${t.replace(/^\/+/, '')}`;
      const ok = effective.some((folder) => isInsideFolder(abs, wsRoot, folder));
      if (!ok) {
        return {
          allowed: false,
          feedback: `Blocked ${ctx.method}: target is outside working set (${t}).`,
          errorData: {
            code: 'OUTSIDE_WORKING_SET',
            target: t,
            workingSet: effective,
          },
        };
      }
    }

    return { allowed: true };
  }
}

export function createWorkingSetMiddleware(): WorkingSetMiddleware {
  return new WorkingSetMiddleware();
}
