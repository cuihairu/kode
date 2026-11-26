/**
 * VS Code official variable substitution (batch 141, task sheet kode-varfix.md user
 * order: "this is VS Code's variable substitution syntax"): the repo previously had
 * two unrelated implementations — workspacePath's `${workspaceFolder}`/`${env:}`
 * silent-empty-string semantics and quickActionConfig's `${workspaceFolder:Name}`
 * throwing semantics — and both lacked the other members of the official variable
 * table. This module is the single source of truth; the two old implementations now
 * delegate instead of each maintaining a copy.
 *
 * Official variable table (the execution sheet required "implement per the official
 * variable table", covering at least the 8 the user named):
 * https://code.visualstudio.com/docs/reference/variables-in-scope-files
 *
 * Two semantics for unresolved variables (each caller picks by meaning; behavior is
 * unchanged from before batch 141):
 * - `empty` (default): replace with the empty string. Path-class settings keep the
 *   old semantics — unreadable means not written, and one missing environment
 *   variable never fails the whole extension wiring.
 * - `throw`: error out immediately with the offending expression. Quick actions, the
 *   kind of command where "running wrong = a silent fake success", keep the old
 *   semantics — a script run with an "empty path" is worse than an error.
 */

import * as path from 'path';

export interface VariableFolderRef {
  fsPath: string;
  name: string;
}

export interface VariableContext {
  /** Multi-root workspace passed in vscode.workspace.workspaceFolders order */
  folders: readonly VariableFolderRef[];
  /** The currently open file (vscode.window.activeTextEditor?.document.fileName) */
  filePath?: string;
  /** Process working directory, for ${cwd} */
  cwd?: string;
  /** User home directory, for ${userHome} */
  userHome?: string;
  /** Platform path separator, for ${pathSeparator}; derived from the host platform when not injected */
  pathSeparator?: string;
  /** Environment-variable table, for ${env:NAME}; reads process.env when not injected */
  env?: Record<string, string | undefined>;
}

export type UnresolvedPolicy = 'empty' | 'throw';

const VARIABLE_PATTERN = /\$\{([^${}]*)\}/g;

/** The ${relativeFile} ruling: a relative path is given only when the file sits under some workspace root */
function isUnderRoot(filePath: string, root: string): boolean {
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

/**
 * Get a workspace root by name: without a name, take the first (matching the
 * ${workspaceFolder} official semantics); with a name, match folder.name exactly.
 * Returns null when not found, and the caller handles it per the unresolved
 * semantics.
 */
export function resolveWorkspaceFolderRef(
  name: string | undefined,
  folders: readonly VariableFolderRef[]
): VariableFolderRef | null {
  if (folders.length === 0) {
    return null;
  }
  if (name === undefined) {
    return folders[0];
  }
  return folders.find(folder => folder.name === name) ?? null;
}

function basenameOf(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function dirnameOf(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index === -1) {
    return '';
  }
  if (index === 0) {
    return '/';
  }
  return normalized.slice(0, index);
}

function resolveExpression(
  expression: string,
  context: VariableContext
): string | undefined {
  const [key, ...rest] = expression.split(':');
  const argument = rest.length > 0 ? rest.join(':') : undefined;

  if (key === 'workspaceFolder' || key === 'workspaceFolderBasename') {
    const folder = resolveWorkspaceFolderRef(argument, context.folders);
    if (folder === null) {
      return undefined;
    }
    return key === 'workspaceFolder' ? folder.fsPath : basenameOf(folder.fsPath);
  }

  if (key === 'env') {
    const table = context.env ?? process.env;
    // "${env:NAME}" must carry a name: a bare ${env} does not guess the first environment variable and is treated as unresolved
    const name = rest.join(':');
    return name.length > 0 ? table[name] : undefined;
  }

  if (key === 'file' || key === 'fileBasename' || key === 'fileBasenameNoExtension'
    || key === 'fileDirname' || key === 'fileExtname'
    || key === 'relativeFile' || key === 'relativeFileDirname') {
    const filePath = context.filePath;
    if (filePath === undefined) {
      return undefined;
    }
    if (key === 'file') {
      return filePath;
    }
    if (key === 'fileDirname') {
      return dirnameOf(filePath);
    }
    if (key === 'fileBasename' || key === 'fileBasenameNoExtension') {
      const fileName = basenameOf(filePath);
      if (key === 'fileBasename') {
        return fileName;
      }
      const stemDot = fileName.lastIndexOf('.');
      return stemDot <= 0 ? fileName : fileName.slice(0, stemDot);
    }
    if (key === 'fileExtname') {
      const fileName = basenameOf(filePath);
      const dot = fileName.lastIndexOf('.');
      return dot <= 0 ? '' : fileName.slice(dot);
    }
    // The relative family: a relative form is given only when the file sits under some
    // workspace root; files outside fall back to the absolute path
    // (same semantics as VS Code: a file outside the workspace has no "relative to workspace" meaning)
    const owner = context.folders.find(folder => isUnderRoot(filePath, folder.fsPath));
    const relative = owner ? filePath.replace(/\\/g, '/').slice(owner.fsPath.replace(/\\/g, '/').replace(/\/+$/, '').length + 1) : filePath;
    return key === 'relativeFile' ? relative : dirnameOf(relative);
  }

  if (key === 'cwd') {
    return context.cwd;
  }

  if (key === 'userHome') {
    return context.userHome;
  }

  if (key === 'pathSeparator') {
    // Use node's path.sep rather than a process.platform ternary: the host platform is
    // immutable in tests, and a hardcoded ternary would leave the other branch forever
    // unreachable — a false coverage gap
    return context.pathSeparator ?? path.sep;
  }

  return undefined;
}

/**
 * Replace every ${...} in a piece of text per the VS Code official variable table.
 * Multiple variables can be mixed in one text (URLs and paths alike); nesting and
 * unclosed `$` are kept verbatim.
 */
export function substituteVariables(
  text: string,
  context: VariableContext,
  policy: UnresolvedPolicy = 'empty'
): string {
  return text.replace(VARIABLE_PATTERN, (raw, expression: string) => {
    const value = resolveExpression(expression, context);
    if (value === undefined) {
      if (policy === 'throw') {
        throw new Error(`变量无法解析: ${raw}`);
      }
      return '';
    }
    return value;
  });
}

/**
 * Resolve a single variable expression (batch 152): for callers merging "custom
 * variables + official variables" in one pass — returns the value when resolve
 * produces one, returns undefined when the official table does not know it, and the
 * caller decides whether to keep the original text or fall to empty (the HTTP
 * template semantics: unknown placeholders kept verbatim, matching batch 105's
 * behavior).
 */
export function resolveVariableExpression(
  expression: string,
  context: VariableContext
): string | undefined {
  return resolveExpression(expression, context);
}
