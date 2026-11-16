// RUST-172 项目向导:五步走完「资源 roots → 引擎版本 → 脚本环境 →
// component paths → server startup config」。每步即时落盘,任何一步 Esc
// 即停(已完成步骤保留,未到步骤零写)。识别/解释器/版本探测/进程环境/
// 组件默认表全部复用既有原语(不重造):identifyProjectLayout /
// resolveProfileInterpreter / findEngineRoot + readEngineVersionMarker /
// buildProcessEnvironments / SOURCE_DEFAULT_COMPONENTS;动作项直接转发
// 既有命令(kbengine.python.syncExtraPaths 等),向导只做编排与事实呈现。
// 条目构造是纯函数(导出可钉),vscode 交互面只在 runProjectWizard。

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10nText } from './nlsRuntime';
import { buildImportPreviewItems, identifyProjectLayout } from './projectImport';
import { ProjectProfileStore } from './projectProfiles';
import { readActiveProfileId, setActiveProfile } from './activeProfile';
import { ensureDefaultDeploymentProfile } from './ensureDefaultProfile';
import { ENGINE_VERSION_PRESETS } from './engineVersion';
import { hasEngineTreeMarker, readEngineVersionMarker } from './backend/engineApiMetadata';
import { detectEngineVersionMarker } from './backend/engineVersionDetect';
import { findEngineRoot } from './backend/engineCompatibility';
import {
  describeInterpreterState,
  locateInterpreterOnPath,
  locateVenvInterpreter,
  resolveProfileInterpreter
} from './profileInterpreter';
import { PYTHON_PROCESSES } from './backend/pythonProcess';
import { buildProcessEnvironments } from './pythonProcessConfig';
import { pythonScriptRootCandidates } from './pythonExtraPaths';
import { resolveStubDir } from './pythonStubExport';
import { SOURCE_DEFAULT_COMPONENTS } from './debugConfig';

/** 单步结果:向导收尾汇总的事实面(只记发生了什么,不修饰)。 */
export interface WizardStepOutcome {
  step: 'roots' | 'engineVersion' | 'scriptEnv' | 'componentPaths' | 'startup';
  applied: boolean;
  detail: string;
}

const stepLabel = (step: WizardStepOutcome['step']): string => {
  switch (step) {
    case 'roots': return l10nText('Asset roots');
    case 'engineVersion': return l10nText('Engine version');
    case 'scriptEnv': return l10nText('Script environment');
    case 'componentPaths': return l10nText('Component paths');
    case 'startup': return l10nText('Server startup');
  }
};

/** 向导条目的公共形状(label 驱动 QuickPick,value 是选中时的落盘载荷)。 */
export interface WizardPickItem {
  label: string;
  description?: string;
  detail?: string;
  value: string | string[] | null;
}

/** 引擎版本步条目:探测命中置顶(带引擎根出处),其后预设,末位保留当前。 */
export function buildEngineVersionItems(
  current: string,
  detected: { version: string; engineRoot: string } | null
): WizardPickItem[] {
  const items: WizardPickItem[] = [];
  if (detected) {
    items.push({
      label: l10nText('Use detected version {v}', { v: detected.version }),
      description: detected.engineRoot,
      detail: l10nText('Read from the engine version marker; unknown markers are never fabricated'),
      value: detected.version
    });
  }
  for (const preset of ENGINE_VERSION_PRESETS) {
    items.push({ label: preset.label, detail: preset.detail, value: preset.value });
  }
  items.push({
    label: l10nText('Keep current version {v}', { v: current }),
    value: null
  });
  return items;
}

/** 脚本环境步条目:链式解析现值置顶,设置值/venv 候选/PATH 候选随后(去重)。 */
export function buildInterpreterItems(input: {
  current: { interpreterPath: string | null; interpreterSource: string };
  settingValue: string;
  venvDirectories: readonly string[];
  workspaceRoot: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
}): WizardPickItem[] {
  const platform = input.platform ?? process.platform;
  const items: WizardPickItem[] = [];
  items.push({
    label: l10nText('Keep current interpreter ({source})', { source: input.current.interpreterSource }),
    description: input.current.interpreterPath ?? l10nText('not found'),
    value: null
  });
  const seen = new Set<string>();
  const pushCandidate = (candidate: string | null, detail: string): void => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    items.push({ label: candidate, detail, value: candidate });
  };
  if (input.settingValue.trim()) {
    pushCandidate(input.settingValue.trim(), l10nText('kbengine.python.interpreterPath setting'));
  }
  for (const name of input.venvDirectories) {
    pushCandidate(
      locateVenvInterpreter(input.workspaceRoot, [name], platform),
      l10nText('venv directory {name}', { name })
    );
  }
  pushCandidate(locateInterpreterOnPath(input.pathEnv ?? process.env.PATH, platform), l10nText('on PATH'));
  return items;
}

/** component paths 步事实清单:scripts 根数 + 派生进程环境数 + 组件默认表 + debug.json 在盘。 */
export function buildComponentPathFacts(input: {
  workspaceRoot: string;
  assetsRoot: string;
  stubDir: string;
  debugJsonExists: boolean;
}): string[] {
  const root = input.assetsRoot || input.workspaceRoot;
  const scriptsRoots = root && fs.existsSync(root)
    ? pythonScriptRootCandidates(root, {
        exists: candidate => fs.existsSync(candidate),
        listSubdirs: dir => {
          try {
            return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
          } catch {
            return [];
          }
        }
      })
    : [];
  const environments = scriptsRoots.length
    ? buildProcessEnvironments(input.workspaceRoot, scriptsRoots, input.stubDir, candidate => fs.existsSync(candidate))
    : [];
  const facts: string[] = [];
  facts.push(l10nText('Scripts roots: {n}', { n: scriptsRoots.length }));
  facts.push(l10nText('Pyright execution environments derived: {n} ({roles})', {
    n: environments.length,
    roles: PYTHON_PROCESSES.join('/')
  }));
  facts.push(l10nText('Stub dir: {dir}', { dir: input.stubDir }));
  const components = SOURCE_DEFAULT_COMPONENTS.map(c => `${c.name}:${c.telnetPort}`).join(' ');
  facts.push(l10nText('Component defaults (telnet): {table}', { table: components }));
  facts.push(l10nText('debug.json: {state}', {
    state: input.debugJsonExists ? l10nText('on disk') : l10nText('absent')
  }));
  return facts;
}

/** 启动配置步:profile 推导的 bin/config 路径与 autoStart 现值。 */
export function buildStartupFacts(profile: {
  engineRoot?: string | null;
  assetsRoot?: string | null;
  autoStart: readonly string[];
}): string[] {
  const facts: string[] = [];
  facts.push(l10nText('binPath (derived): {p}', {
    p: profile.engineRoot ? path.join(profile.engineRoot, 'kbe', 'bin', 'server') : l10nText('not set')
  }));
  facts.push(l10nText('configPath (derived): {p}', { p: profile.assetsRoot || l10nText('not set') }));
  facts.push(l10nText('autoStart components: {list}', { list: profile.autoStart.join(', ') || l10nText('none') }));
  return facts;
}

/** autoStart 预设组(多选语义整组落盘):默认组/加管理器/全部组件。 */
export const AUTO_START_PRESETS: Record<string, readonly string[]> = {
  default: ['machine', 'logger', 'dbmgr'],
  managers: ['machine', 'logger', 'dbmgr', 'baseappmgr', 'cellappmgr'],
  all: [
    'machine', 'logger', 'dbmgr', 'baseappmgr', 'cellappmgr',
    'loginapp', 'baseapp', 'cellapp', 'bots', 'interfaces'
  ]
};

export function summarizeWizard(outcomes: readonly WizardStepOutcome[]): string {
  if (outcomes.length === 0) {
    return l10nText('Project wizard: nothing done');
  }
  const applied = outcomes.filter(o => o.applied);
  if (applied.length === 0) {
    return l10nText('Project wizard: stopped at {step}; nothing written', {
      step: stepLabel(outcomes[0].step)
    });
  }
  const parts = outcomes.map(o =>
    o.applied
      ? l10nText('{step}: applied', { step: stepLabel(o.step) })
      : l10nText('{step}: skipped', { step: stepLabel(o.step) })
  );
  return `${l10nText('Project wizard')} — ${parts.join('; ')}`;
}

async function pickFirst(
  items: ReadonlyArray<WizardPickItem>,
  placeHolder: string
): Promise<WizardPickItem | undefined> {
  return vscode.window.showQuickPick(items, { placeHolder });
}

async function wizardStepRoots(
  store: ProjectProfileStore,
  profileId: string,
  prefillRoot: string
): Promise<WizardStepOutcome> {
  const pickedFolders = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectMany: false,
    canSelectFiles: false,
    openLabel: l10nText('Select asset root'),
    defaultUri: prefillRoot && fs.existsSync(prefillRoot) ? vscode.Uri.file(prefillRoot) : undefined
  });
  const assetsRoot = pickedFolders?.[0]?.fsPath;
  if (!assetsRoot) {
    return { step: 'roots', applied: false, detail: l10nText('no folder picked') };
  }
  const identification = identifyProjectLayout(assetsRoot);
  const confirmLabel = l10nText('Apply roots');
  const picked = await pickFirst(
    [
      { label: confirmLabel, description: l10nText('Save roots to the active profile'), value: 'apply' },
      ...buildImportPreviewItems(identification).map(item => ({ ...item, value: null }))
    ],
    l10nText('Review the identified layout ({root})', { root: assetsRoot })
  );
  if (picked?.label !== confirmLabel) {
    return { step: 'roots', applied: false, detail: l10nText('review dismissed') };
  }
  await store.saveRoots(profileId, {
    assetsRoot,
    engineRoot: identification.engineRoot ?? ''
  });
  return {
    step: 'roots',
    applied: true,
    detail: l10nText('assets={assets} engine={engine}', {
      assets: assetsRoot,
      engine: identification.engineRoot || l10nText('not identified')
    })
  };
}

async function wizardStepEngineVersion(
  workspaceRoots: readonly string[],
  explicitEngineRoot: string | undefined,
  currentVersion: string
): Promise<WizardStepOutcome> {
  // 与 databaseWiring 同一探测链(findEngineRoot + readEngineVersionMarker)。
  // profile.engineRoot 的形态是引擎仓的 kbe/ 目录本身(identifyProjectLayout
  // 口径),而 findEngineRoot 的 marker 探测只认引擎仓根(含 kbe/ 的那层)
  // ——两种形态先归一,形态不符时回落向上找,探测不中即 null 不伪造。
  const exists = (candidate: string): boolean => fs.existsSync(candidate);
  const normalizeExplicit = (explicit: string): string | undefined => {
    if (hasEngineTreeMarker(explicit, exists)) return explicit;
    if (path.basename(explicit) === 'kbe' && hasEngineTreeMarker(path.dirname(explicit), exists)) {
      return path.dirname(explicit);
    }
    return undefined;
  };
  const detected = detectEngineVersionMarker(workspaceRoots as string[], explicitEngineRoot, {
    findRoot: (root, explicit) => {
      const normalized = explicit ? normalizeExplicit(explicit) : undefined;
      return normalized ?? findEngineRoot(root);
    },
    readMarker: root => readEngineVersionMarker(root, probe => fs.readFileSync(probe, 'utf8'))
  });
  const picked = await pickFirst(
    buildEngineVersionItems(currentVersion, detected),
    l10nText('Engine version: pick a value for kbengine.engineVersion')
  );
  if (!picked) {
    return { step: 'engineVersion', applied: false, detail: l10nText('no value picked') };
  }
  if (typeof picked.value !== 'string') {
    return { step: 'engineVersion', applied: false, detail: l10nText('kept {v}', { v: currentVersion }) };
  }
  await vscode.workspace.getConfiguration('kbengine').update(
    'engineVersion', picked.value, vscode.ConfigurationTarget.Workspace
  );
  return { step: 'engineVersion', applied: true, detail: picked.value };
}

async function wizardStepScriptEnv(
  store: ProjectProfileStore,
  profileId: string,
  workspaceRoot: string
): Promise<WizardStepOutcome> {
  const current = resolveProfileInterpreter(workspaceRoot);
  const configuration = vscode.workspace.getConfiguration('kbengine');
  const settingValue = configuration.get<string>('python.interpreterPath', '') ?? '';
  const venvDirectories = configuration.get<string[]>('python.venvDirectories', []) ?? [];
  const picked = await pickFirst(
    buildInterpreterItems({
      current: { interpreterPath: current.interpreterPath, interpreterSource: current.interpreterSource },
      settingValue,
      venvDirectories,
      workspaceRoot
    }),
    l10nText('Script environment: pick the interpreter to record')
  );
  if (!picked) {
    return { step: 'scriptEnv', applied: false, detail: l10nText('no interpreter picked') };
  }
  if (typeof picked.value !== 'string') {
    return {
      step: 'scriptEnv',
      applied: false,
      detail: describeInterpreterState({
        interpreterPath: current.interpreterPath,
        interpreterSource: current.interpreterSource
      })
    };
  }
  await configuration.update('python.interpreterPath', picked.value, vscode.ConfigurationTarget.Workspace);
  await store.saveInterpreter(profileId, { interpreterPath: picked.value, interpreterSource: 'path' });
  return { step: 'scriptEnv', applied: true, detail: picked.value };
}

async function wizardStepComponentPaths(workspaceRoot: string, assetsRoot: string): Promise<WizardStepOutcome> {
  const stubDir = resolveStubDir(workspaceRoot).dir;
  const facts = buildComponentPathFacts({
    workspaceRoot,
    assetsRoot,
    stubDir,
    debugJsonExists: fs.existsSync(path.join(workspaceRoot, '.kbengine', 'debug.json'))
  });
  const actions: WizardPickItem[] = [
    { label: l10nText('Run Python wiring sync'), value: 'kbengine.python.syncExtraPaths' },
    { label: l10nText('Create debug.json example'), value: 'kbengine.debug.createConfig' },
    { label: l10nText('Continue without changes'), value: null }
  ];
  const picked = await vscode.window.showQuickPick(
    [
      { label: l10nText('Component paths (facts)'), kind: vscode.QuickPickItemKind.Separator },
      ...facts.map(fact => ({ label: fact })),
      { label: l10nText('Actions'), kind: vscode.QuickPickItemKind.Separator },
      ...actions
    ],
    { placeHolder: l10nText('Component paths: derived set above; pick an action or continue') }
  );
  if (!picked) {
    return { step: 'componentPaths', applied: false, detail: l10nText('dismissed') };
  }
  const chosen = actions.find(action => action.label === picked.label);
  if (!chosen || typeof chosen.value !== 'string') {
    return { step: 'componentPaths', applied: false, detail: l10nText('no action taken') };
  }
  await vscode.commands.executeCommand(chosen.value);
  return { step: 'componentPaths', applied: true, detail: chosen.value };
}

async function wizardStepStartup(): Promise<WizardStepOutcome> {
  const configuration = vscode.workspace.getConfiguration('kbengine');
  const current: string[] = configuration.get<string[]>('autoStart', []) ?? [];
  const keepLabel = l10nText('Keep current autoStart group');
  const picked = await pickFirst(
    [
      { label: keepLabel, value: null },
      ...Object.entries(AUTO_START_PRESETS).map(([key, values]) => ({
        label: l10nText('autoStart preset: {key} ({n})', { key, n: values.length }),
        description: values.join(', '),
        value: [...values] as string[]
      }))
    ],
    l10nText('Startup: current autoStart = {list}', { list: current.join(', ') || l10nText('none') })
  );
  if (!picked) {
    return { step: 'startup', applied: false, detail: l10nText('dismissed') };
  }
  let applied = false;
  let detail = l10nText('kept {list}', { list: current.join(', ') });
  if (Array.isArray(picked.value)) {
    await configuration.update('autoStart', picked.value, vscode.ConfigurationTarget.Workspace);
    applied = true;
    detail = picked.value.join(', ');
  }
  const launchLabel = l10nText('Update launch.json now');
  const launchPick = await pickFirst(
    [
      { label: launchLabel, value: 'launch' },
      { label: l10nText('Skip launch.json'), value: null }
    ],
    l10nText('Generate debug launch entries for the components?')
  );
  if (launchPick?.value === 'launch') {
    await vscode.commands.executeCommand('kbengine.debug.updateLaunchJson');
    applied = true;
    detail += ` + ${l10nText('launch.json updated')}`;
  }
  return { step: 'startup', applied, detail };
}

/**
 * 五步项目向导。deps 仅测注入(默认 profile 种子);真实进入走默认装配。
 * 每步即时落盘:Esc/取消 = 后续步骤全部不执行,已完成步骤保留。
 */
export async function runProjectWizard(
  context: {
    workspaceState?: vscode.Memento;
  },
  deps?: {
    ensureProfile?: typeof ensureDefaultDeploymentProfile;
  }
): Promise<WizardStepOutcome[]> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  if (!workspaceRoot) {
    await vscode.window.showWarningMessage(l10nText('Project wizard needs an open workspace folder'));
    return [];
  }
  const store = new ProjectProfileStore(context.workspaceState);
  let profileId = readActiveProfileId(context.workspaceState);
  if (!profileId) {
    const ensure = deps?.ensureProfile ?? ensureDefaultDeploymentProfile;
    const seeded = await ensure({
      store,
      activateProfile: id => setActiveProfile(context.workspaceState, id),
      workspaceRoot
    });
    profileId = readActiveProfileId(context.workspaceState) ?? seeded?.id ?? null;
    if (seeded) {
      await vscode.window.showInformationMessage(
        l10nText('Seeded default deployment profile {id}', { id: seeded.id })
      );
    }
  }
  if (!profileId) {
    await vscode.window.showWarningMessage(l10nText('Project wizard needs an active profile; none exists'));
    return [];
  }
  const outcomes: WizardStepOutcome[] = [];
  const profile = store.get(profileId);
  const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];

  const rootsOutcome = await wizardStepRoots(store, profileId, profile?.assetsRoot || workspaceRoot);
  outcomes.push(rootsOutcome);
  if (!rootsOutcome.applied) {
    await vscode.window.showInformationMessage(summarizeWizard(outcomes));
    return outcomes;
  }
  const freshProfile = store.get(profileId);

  const currentVersion = vscode.workspace.getConfiguration('kbengine')
    .get<string>('engineVersion', '3.7.3') ?? '3.7.3';
  outcomes.push(await wizardStepEngineVersion(
    folders,
    freshProfile?.engineRoot?.trim() || undefined,
    currentVersion
  ));
  outcomes.push(await wizardStepScriptEnv(store, profileId, workspaceRoot));
  outcomes.push(await wizardStepComponentPaths(workspaceRoot, freshProfile?.assetsRoot || workspaceRoot));
  outcomes.push(await wizardStepStartup());

  await vscode.window.showInformationMessage(summarizeWizard(outcomes));
  return outcomes;
}
