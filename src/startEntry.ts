import * as vscode from 'vscode';
import { l10nText } from './nlsRuntime';
import {
  resolveDiscoveredEntitiesXmlPath,
  resolveDiscoveredEntityDefsRoot,
  resolveDiscoveredTypesXmlPath
} from './workspaceDiscovery';
import * as fs from 'fs';

// UX-REVIEW-002b/002c 侧栏「开始」入口:项目识别的可观察状态 + 按状态给出
// 真实可执行的操作。审查结论(2026-11-08):首次打开缺一条可执行的主路径,
// 识别中/无项目/识别失败/就绪四种状态不可辨,空实体列表容易被当成"就绪"。
// 本模块只做两件事:状态机(002b,含陈旧守卫——根切换后旧状态不得冒充新根)
// 与树视图(002c,条目全部指向既有真实命令,不新增不可执行的按钮)。
// 原有侧栏视图与命令一概保留(审查边界)。

/** 项目识别的可观察状态(002b) */
export type StartEntryStateKind = 'no-workspace' | 'scanning' | 'not-found' | 'failed' | 'ready';

export interface StartEntryState {
  kind: StartEntryStateKind;
  /** 状态所属工作区根;null = 未打开工作区(陈旧守卫的比较键) */
  workspaceRoot: string | null;
  /** failed = 原始错误信息(保留诊断价值);not-found = 未发现的锚点清单 */
  detail: string;
}

// ---- 可观察状态(002b)----

let current: StartEntryState = { kind: 'no-workspace', workspaceRoot: null, detail: '' };
const stateEmitter = new vscode.EventEmitter<StartEntryState>();

export const onStartEntryStateChanged = stateEmitter.event;

export function getStartEntryState(): StartEntryState {
  return { ...current };
}

export function setStartEntryState(state: StartEntryState): void {
  current = state;
  stateEmitter.fire(getStartEntryState());
}

export function resetStartEntryStateForTests(): void {
  current = { kind: 'no-workspace', workspaceRoot: null, detail: '' };
}

/**
 * 同步推导识别结论:entity_defs 根是核心锚点(实体浏览全链的输入),
 * 唯一命中且真实存在才算已识别——空列表绝不冒充就绪(002b 验收线)。
 * 根级读取失败(权限/被删)如实落 failed,不与「无匹配」混谈——深扫描
 * 对不可读目录是静默跳过(既有宁缺勿猜口径),这里在结论面把两种
 * 「什么都没有」分开:读不到 vs 真没有。其余锚点缺位列进 detail,
 * 诊断全图走发现与定位报告。
 */
export function deriveStartEntryOutcome(
  root: string
): { kind: 'ready' | 'not-found' | 'failed'; detail: string } {
  try {
    fs.accessSync(root, fs.constants.R_OK);
  } catch (err) {
    return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
  const entityDefsRoot = resolveDiscoveredEntityDefsRoot(root);
  if (entityDefsRoot && fs.existsSync(entityDefsRoot)) {
    return { kind: 'ready', detail: '' };
  }
  const missing: string[] = [];
  if (!entityDefsRoot || !fs.existsSync(entityDefsRoot)) {
    missing.push('entity_defs');
  }
  const entitiesXml = resolveDiscoveredEntitiesXmlPath(root);
  if (!entitiesXml || !fs.existsSync(entitiesXml)) {
    missing.push('entities.xml');
  }
  const typesXml = resolveDiscoveredTypesXmlPath(root);
  if (!typesXml || !fs.existsSync(typesXml)) {
    missing.push('types.xml');
  }
  return { kind: 'not-found', detail: missing.join(', ') };
}

// ---- 树视图条目(002c)----

export interface StartEntryTask {
  label: string;
  description?: string;
  tooltip?: string;
  /** 点击执行的既有命令 id;缺省 = 纯状态说明条目(不可执行,不装按钮) */
  commandId?: string;
  commandArgs?: unknown[];
  contextValue: string;
}

export class StartEntryTreeItem extends vscode.TreeItem {
  constructor(task: StartEntryTask) {
    super(task.label, vscode.TreeItemCollapsibleState.None);
    if (task.description) {
      this.description = task.description;
    }
    if (task.tooltip) {
      this.tooltip = task.tooltip;
    }
    this.contextValue = task.contextValue;
    if (task.commandId) {
      this.command = { command: task.commandId, title: task.label, arguments: task.commandArgs };
    }
  }
}

/** 各状态的任务清单:条目全部指向既有真实命令(UX-REVIEW-006c 纪律) */
export function buildStartEntryTasks(
  state: StartEntryState,
  currentRoot: string | null
): StartEntryTask[] {
  // 陈旧守卫:状态所属根 ≠ 当前根 = 切换在途,旧结论不得渲染(002d 验收线的
  // 显示面半边)。过渡期如实显示识别中,不拿上一棵工作区的结论顶替。
  const stale = state.workspaceRoot !== currentRoot;
  switch (stale ? 'scanning' : state.kind) {
    case 'no-workspace':
      return [
        {
          label: l10nText('No workspace open'),
          tooltip: l10nText('Open a KBEngine project folder to begin'),
          contextValue: 'startSummaryNoWorkspace'
        },
        {
          label: l10nText('Open Folder…'),
          description: l10nText('Open a KBEngine project to begin'),
          commandId: 'workbench.action.files.openFolder',
          contextValue: 'startOpenFolder'
        }
      ];
    case 'scanning':
      return [
        {
          label: l10nText('Identifying KBEngine project…'),
          tooltip: l10nText('Workspace anchors are being scanned; results appear here when done'),
          contextValue: 'startSummaryScanning'
        }
      ];
    case 'not-found':
      return [
        {
          label: l10nText('No KBEngine project found'),
          description: state.detail,
          tooltip: l10nText('Missing anchors: {anchors}', { anchors: state.detail }),
          contextValue: 'startSummaryNotFound'
        },
        {
          label: l10nText('Check discovery report'),
          description: l10nText('See how each anchor was resolved'),
          commandId: 'kbengine.discovery.report',
          contextValue: 'startCheckReport'
        },
        {
          label: l10nText('Rescan project'),
          description: l10nText('Run identification again after fixing the layout'),
          commandId: 'kbengine.start.retryDiscovery',
          contextValue: 'startRetry'
        }
      ];
    case 'failed':
      return [
        {
          label: l10nText('Project identification failed'),
          description: state.detail,
          tooltip: state.detail,
          contextValue: 'startSummaryFailed'
        },
        {
          label: l10nText('Check discovery report'),
          description: l10nText('See how each anchor was resolved'),
          commandId: 'kbengine.discovery.report',
          contextValue: 'startCheckReport'
        },
        {
          label: l10nText('Rescan project'),
          description: l10nText('Run identification again after fixing the layout'),
          commandId: 'kbengine.start.retryDiscovery',
          contextValue: 'startRetry'
        }
      ];
    case 'ready':
      return [
        {
          label: l10nText('Project ready'),
          tooltip: l10nText('entity_defs resolved; entity browsing and diagnostics are available'),
          contextValue: 'startSummaryReady'
        },
        {
          label: l10nText('View entities'),
          description: l10nText('Pick an entity definition and open it'),
          commandId: 'kbengine.entity.open',
          contextValue: 'startViewEntities'
        },
        {
          label: l10nText('Check discovery report'),
          description: l10nText('See how each anchor was resolved'),
          commandId: 'kbengine.discovery.report',
          contextValue: 'startCheckReport'
        },
        {
          label: l10nText('Start debugging'),
          description: l10nText('Attach to a component process or a debugpy port'),
          commandId: 'kbengine.debug.start',
          contextValue: 'startDebug'
        }
      ];
  }
}

export class StartEntryProvider implements vscode.TreeDataProvider<StartEntryTreeItem> {
  private readonly emitter = new vscode.EventEmitter<StartEntryTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly stateSubscription: { dispose(): void };

  constructor(private readonly deps: { getWorkspaceRoot(): string | null }) {
    // 状态落地 → 视图刷新:不订阅的话树视图停在旧渲染,识别完成后永远空白
    this.stateSubscription = onStartEntryStateChanged(() => {
      this.refresh();
    });
  }

  dispose(): void {
    this.stateSubscription.dispose();
    this.emitter.dispose();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: StartEntryTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): StartEntryTreeItem[] {
    return buildStartEntryTasks(getStartEntryState(), this.deps.getWorkspaceRoot()).map(
      task => new StartEntryTreeItem(task)
    );
  }
}

// ---- 控制器:识别生命周期 → 状态机 ----

export interface StartEntryControllerDeps {
  getWorkspaceRoot(): string | null;
  /** 完整识别流程(激活期同款:回放记忆选择 → 预热 → 多候选询问) */
  runDiscovery(root: string): Promise<void>;
  /** 结论落地回调(装配层在此落发现报告;失败/陈旧不回调) */
  onDiscoverySettled?(root: string, kind: 'ready' | 'not-found' | 'failed', detail: string): void;
  /** 工作区切换 → 重估(新根走完整识别,旧根在途结果按陈旧弃置) */
  onDidChangeWorkspaceFolders?: vscode.Event<unknown>;
  registerTreeDataProvider?(
    provider: vscode.TreeDataProvider<StartEntryTreeItem>
  ): { dispose(): void };
  subscriptions?: { push(disposable: { dispose(): void }): unknown };
}

export class StartEntryController {
  private generation = 0;

  constructor(private readonly deps: StartEntryControllerDeps) {
    this.deps.onDidChangeWorkspaceFolders?.(() => {
      this.begin();
    });
    const provider = new StartEntryProvider(deps);
    const registration = this.deps.registerTreeDataProvider?.(provider);
    if (registration && this.deps.subscriptions) {
      // 注册 disposable 与 provider 生命周期(状态订阅+事件源)合并拆除断
      this.deps.subscriptions.push({
        dispose: () => {
          registration.dispose();
          provider.dispose();
        }
      });
    }
  }

  /** 激活期入口:无根落 no-workspace,有根走完整识别 */
  begin(): void {
    void this.evaluate();
  }

  /** 侧栏「重新识别」命令入口(失败/缺锚点后的重试路径) */
  async retry(): Promise<void> {
    await this.evaluate();
  }

  private async evaluate(): Promise<void> {
    const root = this.deps.getWorkspaceRoot();
    if (!root) {
      this.generation += 1;
      setStartEntryState({ kind: 'no-workspace', workspaceRoot: null, detail: '' });
      return;
    }
    const existing = getStartEntryState();
    if (existing.kind === 'scanning' && existing.workspaceRoot === root) {
      return; // 同根识别在途,重入直接忽略(重试连点不叠扫)
    }
    const generation = ++this.generation;
    setStartEntryState({ kind: 'scanning', workspaceRoot: root, detail: '' });
    try {
      await this.deps.runDiscovery(root);
    } catch (err) {
      if (generation !== this.generation || this.deps.getWorkspaceRoot() !== root) {
        return; // 已被新根识别取代:旧结论一律弃置,不覆盖新状态
      }
      const detail = err instanceof Error ? err.message : String(err);
      setStartEntryState({ kind: 'failed', workspaceRoot: root, detail });
      this.deps.onDiscoverySettled?.(root, 'failed', detail);
      return;
    }
    if (generation !== this.generation || this.deps.getWorkspaceRoot() !== root) {
      return; // 陈旧弃置(002d 的显示面前置:后台旧扫描不得覆盖新工作区状态)
    }
    const outcome = deriveStartEntryOutcome(root);
    setStartEntryState({ ...outcome, workspaceRoot: root });
    this.deps.onDiscoverySettled?.(root, outcome.kind, outcome.detail);
  }
}
