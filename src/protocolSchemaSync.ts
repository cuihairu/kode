//! PA-007 第二增量:KBEngine 协议 Schema 自动生成与协议文件监听(todo PA-007)。
//!
//! 职责:把工作区 KBEngine 资产根(scripts/entities.xml + entity_defs/**/*.def
//! + types.xml/alias.xml,CLI schema build 的输入契约)经 kode-kbengine CLI
//! `schema build` 生成 Schema JSON,落扩展 globalStorage;协议定义文件变更经
//! 共享合并器防抖后自动重建。Python 业务文件不在监听 glob 内——「仅协议定义
//! 文件触发重建」由装配面结构性保证,不靠运行时后判。
//!
//! 诚实边界:
//! - 激活不主动起子进程(初始生成 = 手动命令或首个协议文件事件);
//! - 自动面失败只落输出通道不刷通知(防连编失败刷屏);手动命令面才出通知;
//! - 项目根复用 kbengine.assetsRoot 配置与既有发现链(resolveAssetsRootFor-
//!   Workspace),多根工作区取第一根(多项目资产根挂账);项目根外协议文件
//!   事件不触发(防仓库内 fixture 误触发);
//! - 建图在途不重入,完成后补一次尾随变更(合并器窗口外的连改不丢)。

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ensureProtocolChannel,
  readProtocolToolingConfig,
  resolveCliPath,
  type ProtocolToolingDeps,
  type RunBinary
} from './protocolTooling';
import { resolveAssetsRootForWorkspace } from './scanRoots';
import { createSharedFileEventMerger, type SharedFileEventKind } from './sharedFileEvents';

export const BUILD_SCHEMA_COMMAND = 'kbengine.protocol.buildSchema';
/** Schema JSON 落点文件名(globalStorage 下;CLI schema inspect/diff 的输入)。 */
export const SCHEMA_OUT_FILENAME = 'kbengine-schema.json';
/** kbengine.* 下的自动重建开关键(protocol.schemaAutoBuild)。 */
export const SCHEMA_AUTO_BUILD_CONFIG = 'protocol.schemaAutoBuild';
/** 协议定义文件监听 glob(与 typeStorageIndexWatchers 同源集,外加 alias.xml
 * ——CLI schema 布局抽取的别名线输入)。 */
const PROTOCOL_FILE_GLOBS = ['**/*.def', '**/types.xml', '**/entities.xml', '**/alias.xml'];

export interface SchemaBuildPlan {
  kind: 'ready';
  cli: string;
  project: string;
  out: string;
}

export interface SchemaBuildUnavailable {
  kind: 'unavailable';
  /** 如实落空原因(CLI 未检出/探测失败/资产根未检出),不猜测。 */
  reason: string;
}

export type SchemaBuildPlanResult = SchemaBuildPlan | SchemaBuildUnavailable;

/**
 * 建图计划解析:CLI(配置优先/自动发现 + `--version` 探测)+ 项目根
 * (resolveProject 注入点,默认 assetsRoot 配置→发现链)+ 输出落点
 * (globalStorage/kbengine-schema.json)。任一环落空 → unavailable。
 */
export async function resolveSchemaBuildPlan(
  deps: ProtocolToolingDeps,
  globalStoragePath: string,
  resolveProject: (workspaceRoot: string) => string = resolveAssetsRootForWorkspace
): Promise<SchemaBuildPlanResult> {
  const cli = await resolveCliPath(deps);
  if (cli.path === '') {
    return {
      kind: 'unavailable',
      reason: 'kode-kbengine CLI 未检出(未配置且 target/{debug,release} 自动发现落空)'
    };
  }
  if (cli.outcome.code !== 0) {
    return {
      kind: 'unavailable',
      reason: `kode-kbengine CLI 探测失败(code ${cli.outcome.code}):${firstLine(cli.outcome.stderr ?? cli.outcome.stdout)}`
    };
  }
  // 空工作区语义归 resolveProject(默认实现自身对空根返回 ''),这里不二次
  // 短路——注入的解析器决定空语义。
  const project = resolveProject(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
  if (project === '') {
    return {
      kind: 'unavailable',
      reason: '未检出 KBEngine 资产根(kbengine.assetsRoot 未配置且自动发现落空)'
    };
  }
  return {
    kind: 'ready',
    cli: cli.path,
    project,
    out: path.join(globalStoragePath, SCHEMA_OUT_FILENAME)
  };
}

export interface SchemaBuildOutcome {
  ok: boolean;
  code: number;
  /** 归因文本:失败优先 stderr(stderr 空回落 stdout);成功为输出摘要。 */
  message: string;
}

/** 建图执行:`<cli> schema build --project <root> --out <file>`。非零退出 =
 * 失败(进程存在即返回,不用异常通道——CLI 用退出码表达结果)。 */
export async function runProtocolSchemaBuild(
  run: RunBinary,
  plan: SchemaBuildPlan
): Promise<SchemaBuildOutcome> {
  const outcome = await run(plan.cli, [
    'schema',
    'build',
    '--project',
    plan.project,
    '--out',
    plan.out
  ]);
  const message = clampText(
    outcome.code === 0
      ? outcome.stdout.trim() || `schema written: ${plan.out}`
      : firstLine(outcome.stderr ?? '') || firstLine(outcome.stdout) || `exit code ${outcome.code}`
  );
  return { ok: outcome.code === 0, code: outcome.code, message };
}

/** 建图串行器:在途不重入;在途期间的新请求只记最新一份,完成后补一次
 * (连改合并为一轮尾随重建,不排队放大)。 */
export function createSchemaBuildScheduler(
  run: (plan: SchemaBuildPlan) => Promise<SchemaBuildOutcome>,
  log: (line: string) => void
): { request: (plan: SchemaBuildPlan) => void } {
  let inFlight = false;
  let pending: SchemaBuildPlan | null = null;
  const pump = (plan: SchemaBuildPlan): void => {
    inFlight = true;
    void run(plan).then((outcome) => {
      inFlight = false;
      log(
        outcome.ok
          ? `schema build ok → ${plan.out}`
          : `schema build failed (code ${outcome.code}): ${outcome.message}`
      );
      const next = pending;
      pending = null;
      if (next) {
        pump(next);
      }
    });
  };
  return {
    request(plan: SchemaBuildPlan): void {
      if (inFlight) {
        pending = plan;
        return;
      }
      pump(plan);
    }
  };
}

/** 当前工作区的资产根(空工作区/落空 → '')。合并器窗口内多次事件共享 memo,
 * 无重复扫描成本。 */
function currentProjectRoot(): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return workspaceRoot === '' ? '' : resolveAssetsRootForWorkspace(workspaceRoot);
}

/** 自动重建装配:协议定义文件 watcher × 项目根过滤 × 合并器防抖 × 串行器。
 * 返回 teardown(拆 watcher + 断合并订阅);句柄是否入 subscriptions 由调用
 * 方定(config 切换要能拆干净再重挂,不能依赖 subscriptions 永活)。 */
export function wireProtocolSchemaAutoBuild(
  context: vscode.ExtensionContext,
  opts: {
    deps: () => ProtocolToolingDeps;
    globalStoragePath: () => string;
    /** 合并窗口 ms(默认 30ms;测试注入)。 */
    mergerWindowMs?: number;
  }
): vscode.Disposable {
  // 通道懒取(首次事件/首条日志才建;激活零开销面与 showStatus 同款)。
  const channel = (): vscode.OutputChannel => ensureProtocolChannel(context);
  const merger = createSharedFileEventMerger(opts.mergerWindowMs);
  const scheduler = createSchemaBuildScheduler(
    (plan) => runProtocolSchemaBuild(opts.deps().run, plan),
    (line) => channel().appendLine(`[schema-sync] ${line}`)
  );
  const unsubscribe = merger.subscribe(() => {
    if (currentProjectRoot() === '') {
      return; // 无资产根:事件面如实不建(手动命令面会给出归因)
    }
    void resolveSchemaBuildPlan(opts.deps(), opts.globalStoragePath()).then((plan) => {
      if (plan.kind === 'ready') {
        scheduler.request(plan);
      } else {
        channel().appendLine(`[schema-sync] skip: ${plan.reason}`);
      }
    });
  });

  const isInsideProject = (fsPath: string): boolean => {
    const project = currentProjectRoot();
    return (
      project !== '' &&
      (fsPath === project ||
        fsPath.startsWith(`${project}/`) ||
        fsPath.startsWith(`${project}${path.sep}`))
    );
  };
  const emit = (fsPath: string, kind: SharedFileEventKind): void => {
    if (isInsideProject(fsPath)) {
      merger.emit(fsPath, kind);
    }
  };
  const watchers: vscode.FileSystemWatcher[] = [];
  for (const pattern of PROTOCOL_FILE_GLOBS) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange((uri) => emit(uri.fsPath, 'change'));
    watcher.onDidCreate((uri) => emit(uri.fsPath, 'create'));
    watcher.onDidDelete((uri) => emit(uri.fsPath, 'delete'));
    watchers.push(watcher);
  }
  return {
    dispose(): void {
      unsubscribe();
      for (const watcher of watchers) {
        watcher.dispose();
      }
      watchers.length = 0;
    }
  };
}

/** 装配入口:手动命令 kbengine.protocol.buildSchema + 自动面(schemaAutoBuild
 * 开时挂 watcher,配置切换即拆/重挂)。全部句柄进 context.subscriptions。 */
export function setupProtocolSchemaSync(context: vscode.ExtensionContext): void {
  // 通道懒取(命令触发面才建;激活零开销面与 showStatus 同款)。
  const channel = (): vscode.OutputChannel => ensureProtocolChannel(context);
  const deps = (): ProtocolToolingDeps => readProtocolToolingConfig(context.extensionUri.fsPath);
  const globalStoragePath = (): string => context.globalStorageUri.fsPath;
  const readAutoBuild = (): boolean =>
    vscode.workspace.getConfiguration('kbengine').get<boolean>(SCHEMA_AUTO_BUILD_CONFIG, true);

  const command = vscode.commands.registerCommand(BUILD_SCHEMA_COMMAND, async () => {
    const plan = await resolveSchemaBuildPlan(deps(), globalStoragePath());
    if (plan.kind !== 'ready') {
      channel().appendLine(`[schema-sync] build unavailable: ${plan.reason}`);
      void vscode.window.showWarningMessage(`KBEngine 协议 Schema 未生成:${plan.reason}`);
      return;
    }
    const outcome = await runProtocolSchemaBuild(deps().run, plan);
    channel().appendLine(
      outcome.ok
        ? `[schema-sync] manual build ok → ${plan.out}`
        : `[schema-sync] manual build failed (code ${outcome.code}): ${outcome.message}`
    );
    if (outcome.ok) {
      void vscode.window.showInformationMessage(`KBEngine 协议 Schema 已生成:${plan.out}`);
    } else {
      void vscode.window.showErrorMessage(`KBEngine 协议 Schema 生成失败:${outcome.message}`);
    }
  });

  let auto: vscode.Disposable | null = null;
  const rewire = (): void => {
    auto?.dispose();
    auto = null;
    if (readAutoBuild()) {
      auto = wireProtocolSchemaAutoBuild(context, { deps, globalStoragePath });
    }
  };
  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(`kbengine.${SCHEMA_AUTO_BUILD_CONFIG}`)) {
      rewire();
    }
  });

  context.subscriptions.push(command, configListener, { dispose: () => auto?.dispose() });
  rewire();
}

// ---------------------------------------------------------------- schema state

/** Schema 文件状态(PA-007 第四增量:版本提示+错误诊断的读面)。present 只
 * 在 JSON 可解析时给出;字段逐个防御提取(CLI canonical 序,无时间戳字段)。 */
export type SchemaState =
  | {
      kind: 'present';
      schemaVersion: number;
      engineBaseline: string;
      messages: number;
      entities: number;
      missingEntities: string[];
      diagnostics: string[];
    }
  | { kind: 'absent' }
  | { kind: 'unreadable'; reason: string };

async function defaultReadSchemaFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

/**
 * 读 globalStorage/kbengine-schema.json:缺文件 = absent(如实「未生成」),
 * 读失败/坏 JSON = unreadable(带归因,不猜);present 面提取 IR 版本、引擎
 * 基线、消息/实体规模、缺失实体清单与构建诊断(SYNTAX-005 同规:CLI 把坏
 * 输入保留为诊断不失败——错误诊断面就是把它们原样呈给用户)。
 */
export async function readSchemaState(
  globalStoragePath: string,
  readFile: (path: string) => Promise<string> = defaultReadSchemaFile
): Promise<SchemaState> {
  if (globalStoragePath === '') {
    return { kind: 'absent' }; // 无 globalStorage 面:如实按未生成处理
  }
  let raw: string;
  try {
    raw = await readFile(path.join(globalStoragePath, SCHEMA_OUT_FILENAME));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { kind: 'absent' };
    }
    return { kind: 'unreadable', reason: `${err.code ?? 'Error'}: ${err.message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'unreadable', reason: `JSON parse: ${(error as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'unreadable', reason: 'schema JSON 根不是对象' };
  }
  const root = parsed as Record<string, unknown>;
  const messagesTable =
    typeof root['messages'] === 'object' && root['messages'] !== null
      ? (root['messages'] as Record<string, unknown>)
      : {};
  const stringList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const entities = root['entities'];
  return {
    kind: 'present',
    schemaVersion: typeof root['schema_version'] === 'number' ? root['schema_version'] : 0,
    engineBaseline: typeof root['engine_baseline'] === 'string' ? root['engine_baseline'] : '',
    messages: Array.isArray(messagesTable['entries']) ? messagesTable['entries'].length : 0,
    entities:
      entities !== null && typeof entities === 'object' && !Array.isArray(entities)
        ? Object.keys(entities).length
        : 0,
    missingEntities: stringList(root['missing_entities']),
    diagnostics: stringList(root['diagnostics'])
  };
}

// ---------------------------------------------------------------- text utils

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

function clampText(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
