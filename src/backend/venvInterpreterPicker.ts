/**
 * Interpreter status-bar display, QuickPick selection, and one-click venv creation
 * (PY-ENV phase 2). The status-bar item shows the current interpreter (venv name /
 * version / source badge auto|configured|PATH|missing); clicking opens the QuickPick:
 * the current item first (✓), then the environments discovered in the workspace, PATH
 * interpreters, and at the end of the list "create a new venv…". A selection writes
 * kbengine.python.interpreterPath (workspace level) and takes effect immediately — the
 * resolution chain reads live configuration every time, no reload needed. Creation
 * flow: pick a directory (defaults to <root>/.venv) → if the base interpreter (PATH
 * chain) is missing, report honestly and never fabricate → run python -m venv in
 * progress state → on completion, verify the target directly (independent of scan
 * scope) and then select it automatically; command failures carry stderr, and an
 * environment that was built but fails verification is never selected.
 *
 * All interaction faces are dependency-injected (showQuickPick / progress / spawn /
 * settings write); this module does not import vscode directly — unit tests use
 * in-memory stand-ins; extension.ts only does thin wiring.
 */

import { l10nText } from '../nlsRuntime';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import {
  type DiscoveredVenv,
  parsePythonVersionOutput,
  scanVenvs
} from './venvDiscovery';
import type { InterpreterResolution, InterpreterSource } from '../profileInterpreter';
import { DEFAULT_VENV_DIRECTORY_NAMES } from './quickActionConfig';

/** Source badge for the status bar / picker: configured > auto > PATH, with missing stated plainly */
export function interpreterSourceBadge(source: InterpreterSource): string {
  switch (source) {
    case 'setting':
      return 'configured';
    case 'venv':
      return 'auto';
    case 'path':
      return 'PATH';
    default:
      return 'missing';
  }
}

/** Owning extension of the Python interpreter picker status-bar item (2026-11-10 user order, venv/Pylance
 * dedup): ms-python.python already renders the interpreter picker in the status bar; showing the same
 * venv from this extension too is a duplicate. */
export const PYTHON_INTERPRETER_EXTENSION_ID = 'ms-python.python';

/**
 * Whether the interpreter status-bar item should be shown (venv/Pylance dedup;
 * tightened on 2026-11-17 to yield upon installation): the Python extension
 * **installed** → hide this extension's item; not installed → show this extension's item.
 *
 * Why install-based rather than isActive: it is a lazily activated extension, so when
 * this extension activates first, it mostly has not activated yet — judging by
 * isActive means we appear first, then after it activates the status bar shows both,
 * while extensions.onDidChange only fires on install/uninstall/enable/disable (not on
 * activation), leaving no hook to re-check. Yield-upon-install means ownership holds at
 * install time, with no double-entry window from the start. Pure decision; the install
 * fact is gathered by the caller (getExtension(...) !== undefined), which keeps unit
 * tests easy. No functionality is lost while hidden: selecting/creating a venv still
 * goes through the command palette kbengine.python.selectInterpreter / createVenv.
 */
export function shouldShowInterpreterStatusBar(pythonExtensionInstalled: boolean): boolean {
  return !pythonExtensionInstalled;
}

/** Status-bar one-liner: $(python) <name> <version> (badge); the missing state is stated plainly */
export function interpreterStatusBarText(
  resolution: InterpreterResolution,
  version?: string | null
): string {
  if (!resolution.interpreterPath) {
    return l10nText('$(circle-slash) Python interpreter missing');
  }
  const segments = resolution.interpreterPath.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? resolution.interpreterPath;
  // The environment layout (.../<env>/bin|Scripts/python*) is independent of source
  // identification: once a selected venv is written into settings its source becomes
  // configured, and the status bar must still show the environment directory name, not
  // degrade to python. But the environment directory name only takes over when the
  // directory is known to be an environment — source = venv (already verified by the
  // workspace scan) or the directory name hits the venv naming list (.venv/venv/.kbenv);
  // otherwise (/usr/bin/python3, /opt/py/bin/python and the like — system/bare paths)
  // fall back to the binary name rather than guessing an environment into existence.
  const parent = segments[segments.length - 2];
  const inEnvLayout = parent === 'bin' || parent === 'Scripts';
  const parentDirName = segments[segments.length - 3];
  const knownEnv =
    inEnvLayout &&
    parentDirName !== undefined &&
    (resolution.interpreterSource === 'venv' || DEFAULT_VENV_DIRECTORY_NAMES.includes(parentDirName));
  const name = knownEnv && parentDirName ? parentDirName : last;
  const versionPart = version ? ` ${version}` : '';
  return `$(python) ${name}${versionPart} (${interpreterSourceBadge(resolution.interpreterSource)})`;
}

/** A single QuickPick item (shape shared by tests and wiring) */
export interface InterpreterPickItem {
  label: string;
  description?: string;
  detail?: string;
  /** The settings value to write for this item; absent for the create item */
  interpreterPath?: string;
  /** Currently active item (✓ first) */
  current?: boolean;
  /** Environment discovered in the workspace */
  venv?: DiscoveredVenv;
  /** PATH interpreter item */
  pathEntry?: boolean;
  /** The "create a new venv…" item */
  create?: boolean;
}

export const VENV_CREATE_ITEM_LABEL = l10nText('$(add) Create a new venv…');

/** Picker item assembly (pure function): current → discovered environments → PATH → create */
export function buildInterpreterPickItems(inputs: {
  current: InterpreterResolution;
  discovered: DiscoveredVenv[];
  pathInterpreter: string | null;
}): InterpreterPickItem[] {
  const items: InterpreterPickItem[] = [];
  if (inputs.current.interpreterPath) {
    items.push({
      label: `✓ ${inputs.current.interpreterPath}`,
      description: l10nText('current ({source})', { source: interpreterSourceBadge(inputs.current.interpreterSource) }),
      interpreterPath: inputs.current.interpreterPath,
      current: true
    });
  }
  for (const env of inputs.discovered) {
    items.push({
      label: `$(package) ${env.name}`,
      description: env.rootPath,
      detail: `${env.interpreterPath}(${env.envKind === 'conda' ? 'conda' : 'venv'})`,
      interpreterPath: env.interpreterPath,
      venv: env
    });
  }
  if (inputs.pathInterpreter) {
    items.push({
      label: `$(globe) ${inputs.pathInterpreter}`,
      description: 'PATH',
      interpreterPath: inputs.pathInterpreter,
      pathEntry: true
    });
  }
  items.push({ label: VENV_CREATE_ITEM_LABEL, create: true });
  return items;
}

export interface SelectInterpreterDeps {
  /** Accepts both sync and async (the async face = KODE-RESP-010 cached discovery; a hot value returns
   * immediately, a cold value's in-flight scan never blocks the main thread), so callers need not distinguish */
  current: () => InterpreterResolution | Promise<InterpreterResolution>;
  discovered: () => DiscoveredVenv[] | Promise<DiscoveredVenv[]>;
  pathInterpreter: () => string | null;
  showQuickPick: (items: InterpreterPickItem[]) => Promise<InterpreterPickItem | undefined>;
  writeInterpreterSetting: (value: string | null) => Promise<void>;
  report: (message: string) => Promise<void>;
  createVenv: () => Promise<'created' | null>;
}

/**
 * Select command body: pick an environment → write kbengine.python.interpreterPath
 * (effective immediately; the resolution chain reads live configuration); Esc writes
 * nothing; the "create a new venv…" item switches to the creation flow. current/
 * discovered may be async — once the wiring layer hooks the cached async discovery
 * (KODE-RESP-010), the list first shows existing candidates (hot cache values), and a
 * cold start only runs one budgeted async scan, never blocking the command thread.
 */
export async function selectInterpreter(
  deps: SelectInterpreterDeps
): Promise<'selected' | 'created' | null> {
  const current = await deps.current();
  const picked = await deps.showQuickPick(
    buildInterpreterPickItems({
      current,
      discovered: await deps.discovered(),
      pathInterpreter: deps.pathInterpreter()
    })
  );
  if (!picked) {
    return null;
  }
  if (picked.create) {
    return (await deps.createVenv()) === 'created' ? 'created' : null;
  }
  if (!picked.interpreterPath) {
    return null;
  }
  await deps.writeInterpreterSetting(picked.interpreterPath);
  await deps.report(
    l10nText(
      'Python interpreter switched: {path} (written to kbengine.python.interpreterPath, effective immediately)',
      { path: picked.interpreterPath }
    )
  );
  return 'selected';
}

export interface CreateVenvDeps {
  workspaceRoot: string | undefined;
  /**
   * Pick the parent directory to place the venv in (the dialog can only pick an
   * existing directory, defaults to the workspace root);
   * null = user canceled. The target directory is fixed to .venv under the picked
   * parent (python -m venv creates the directory itself; the parent is not required to
   * already contain a .venv).
   */
  pickTargetParentDir: (defaultDir: string) => Promise<string | null>;
  /** Base interpreter (settings value adopted only when present → PATH chain); null = missing (report honestly, never fabricate) */
  baseInterpreter: () => string | null;
  /** The target directory exists and is non-empty (occupied; refuse to create) */
  targetDirectoryExistsNonEmpty: (dir: string) => boolean;
  /** Run python -m venv in progress state (async, does not block the extension host) */
  runVenvModule: (
    baseInterpreterPath: string,
    targetDir: string
  ) => Promise<{ exitCode: number | null; stderr: string }>;
  /** Verify the target directory directly after creation (independent of scan scope; null = fails verification) */
  verifyTarget: (dir: string) => string | null;
  writeInterpreterSetting: (value: string | null) => Promise<void>;
  report: (message: string) => Promise<void>;
}

/**
 * Creation flow: pick a parent directory → occupancy precheck → refuse honestly when
 * the base interpreter is missing → python -m venv (failures carry stderr) → verify the
 * target directly → select it automatically and write the setting. Every step states
 * its failure reason plainly; success is never fabricated.
 */
export async function createVenvFlow(deps: CreateVenvDeps): Promise<'created' | null> {
  if (!deps.workspaceRoot) {
    await deps.report(l10nText('No workspace open; cannot create a venv'));
    return null;
  }
  const parent = await deps.pickTargetParentDir(deps.workspaceRoot);
  if (!parent) {
    return null;
  }
  const target = path.join(parent, '.venv');
  if (deps.targetDirectoryExistsNonEmpty(target)) {
    await deps.report(
      l10nText('Target directory already exists and is not empty; refusing to create (avoid overwriting): {path}', { path: target })
    );
    return null;
  }
  const base = deps.baseInterpreter();
  if (!base) {
    await deps.report(
      l10nText(
        'Missing a base Python interpreter (neither kbengine.python.interpreterPath nor PATH has a usable python3/python); cannot create a venv; specify a working system interpreter first'
      )
    );
    return null;
  }
  const run = await deps.runVenvModule(base, target);
  if (run.exitCode !== 0) {
    const tail = run.stderr.trim().split('\n').slice(-3).join('; ');
    await deps.report(
      l10nText('python -m venv failed (exit code {code}): {tail}', { code: run.exitCode ?? -1, tail: tail || l10nText('no stderr output') })
    );
    return null;
  }
  // Verify the target directly after creation (environment evidence + interpreter
  // binary), independent of scan scope — the target is selected as usual even when it
  // sits beyond the scan depth; a verification failure (missing pyvenv.cfg or binary)
  // is reported honestly; an unverified path is never written into settings.
  const interpreterPath = deps.verifyTarget(target);
  if (!interpreterPath) {
    await deps.report(
      l10nText(
        'venv command ran but {path} did not pass verification (missing pyvenv.cfg or interpreter binary); not selected',
        { path: target }
      )
    );
    return null;
  }
  await deps.writeInterpreterSetting(interpreterPath);
  await deps.report(l10nText('venv created and selected: {path}', { path: interpreterPath }));
  return 'created';
}

/** Run a process asynchronously, collect stdout/stderr, kill on timeout; does not block the extension host */
const runProcess = (
  file: string,
  args: string[],
  timeoutMs: number,
  onSpawn?: (child: ChildProcess) => void
): Promise<{ exitCode: number | null; stderr: string }> =>
  new Promise(resolve => {
    let stderrTail = '';
    let settled = false;
    const child = spawn(file, args, { timeout: timeoutMs });
    onSpawn?.(child);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });
    const finish = (exitCode: number | null, stderr: string) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ exitCode, stderr });
    };
    child.on('error', error => finish(-1, error.message));
    child.on('close', code => finish(code, stderrTail));
  });

/** Real dependency side: run python -m venv in progress state (async, kill on timeout); onSpawn lets the
 * withProgress cancel token take the child-process handle (RUST-222, cancel = kill; the half-built result is
 * honestly rejected by the verification face) */
export const runVenvModuleProcess = (
  base: string,
  target: string,
  onSpawn?: (child: ChildProcess) => void
): Promise<{ exitCode: number | null; stderr: string }> =>
  runProcess(base, ['-m', 'venv', target], 300_000, onSpawn);

/** Real dependency side: probe <python> --version asynchronously (5s timeout); failure honestly returns null */
export const probePythonVersion = async (interpreterPath: string): Promise<string | null> => {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        interpreterPath,
        ['--version'],
        { timeout: 5000 },
        (error, stdout, stderr) => {
          if (error && !stdout && !stderr) {
            reject(error);
            return;
          }
          resolve(`${stdout}${stderr}`);
        }
      );
    });
    return parsePythonVersionOutput(output);
  } catch {
    return null;
  }
};

/** Real dependency side: scan the workspace root (re-export so the wiring layer has a single import) */
export const scanWorkspaceVenvs = scanVenvs;
