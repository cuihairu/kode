/**
 * Build task spec for a profile (IDE-TSK-001): one profile (assets root +
 * interpreter) yields one precisely previewable script compile-check task.
 * All four elements command/args/cwd/env derive from the profile and match
 * the preview verbatim -- TSK-002's TaskProvider registers by this spec and
 * TSK-003's problem matcher consumes the same output (compileall -q only
 * emits error lines). The task itself runs the interpreter's `-m compileall`
 * over the assets scripts directory: pure syntax compilation, no engine
 * module imports, runnable by any profile interpreter.
 */

/** Task type id (vscode TaskDefinition.type; the TSK-002 TaskProvider registration surface) */
export const BUILD_TASK_TYPE = 'kbengine.build';

export interface BuildTaskSpecInput {
  id: string;
  displayName: string;
  assetsRoot: string;
  /** null = no interpreter chosen for the profile, falls back to python3 on PATH (noted as-is in the detail) */
  interpreterPath: string | null;
}

export interface BuildTaskSpec {
  type: typeof BUILD_TASK_TYPE;
  profileId: string;
  /** Task name (shown in the task list: profile display name + action) */
  name: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Per-line execution detail (fallback annotations etc.; shared by preview and task detail) */
  detail: readonly string[];
}

/** Fallback when no interpreter is available (same contract as the debugpy source chain: python3 on PATH) */
const FALLBACK_INTERPRETER = 'python3';

/**
 * Derive the script compile-check task: command = profile interpreter (falls
 * back to python3 with an annotation when missing), args =
 * `-m compileall -q <assets>/scripts`, cwd = assets root, env carries only
 * PYTHONUTF8=1 (paths inside compileall error lines print stably as UTF-8,
 * avoiding mojibake on the Windows default GBK console).
 */
export function buildScriptCheckTaskSpec(profile: BuildTaskSpecInput): BuildTaskSpec {
  const assetsRoot = profile.assetsRoot.replace(/\/+$/, '');
  const scriptsDir = `${assetsRoot}/scripts`;
  const detail: string[] = [];
  let command = FALLBACK_INTERPRETER;
  if (profile.interpreterPath) {
    command = profile.interpreterPath;
    detail.push(`解释器:profile 所选 ${command}`);
  } else {
    detail.push(`解释器:profile 未选,回退 PATH 上的 ${FALLBACK_INTERPRETER}`);
  }
  return {
    type: BUILD_TASK_TYPE,
    profileId: profile.id,
    name: `${profile.displayName}: 脚本编译检查`,
    command,
    args: ['-m', 'compileall', '-q', scriptsDir],
    cwd: assetsRoot,
    env: { PYTHONUTF8: '1' },
    detail
  };
}

/** Preview argument quoting rule: double-quote whenever it contains whitespace (matching shell word splitting) */
const quoteIfNeeded = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

/**
 * Preview = exactly what gets executed: the cd line + the command line verbatim
 * (each argument quoted per shell word-splitting rules) + one env entry each +
 * the detail lines. The task list / execution detail display this text directly,
 * so what you see is what runs.
 */
export function formatBuildTaskPreview(spec: BuildTaskSpec): string {
  const commandLine = [spec.command, ...spec.args].map(quoteIfNeeded).join(' ');
  return [
    `[${spec.type}] ${spec.name}`,
    `cd ${quoteIfNeeded(spec.cwd)}`,
    commandLine,
    `env:`,
    ...Object.entries(spec.env).map(([key, value]) => `  ${key}=${value}`),
    ...spec.detail
  ].join('\n');
}
