/**
 * KB-GC-001 guiconsole 期一·组件状态面板:kbengine-explorer 容器新视图。
 *
 * 数据源 = ConsoleHub 组件台账(machine 发现回包即携带 uid/type/id/pid/cpu/
 * mem/usedmem/state 负载快照,machine.cpp:219-228;guiconsole StatusWindow
 * 直消费同一广播,设计文档 §1.1)——面板不另起查询链。异常态(进程消失/
 * state≠RUN/CPU 或内存超阈)红色标记;刷新间隔可配,手动刷新走同一轮询。
 */

import * as vscode from 'vscode';
import { l10nText } from './nlsRuntime';
import type { KBEngineComponentInfo } from './backend/kbengineProtocol';
import type { ConsoleHub } from './kbengineConsoleHub';

export interface PanelThresholds {
  cpuPercent: number;
  memMb: number;
}

/** COMPONENT_STATE(common.h:53-70):0=INIT、1=RUN 是常态运行值(真机实测
 * machine/bots 恒为 INIT);2/3/4=关停中/正在关停/已停止 才是异常态 */
const COMPONENT_STATES_NORMAL = new Set([0, 1]);
const DEFAULT_CPU_THRESHOLD = 90;
const DEFAULT_MEM_THRESHOLD_MB = 1024;

export function resolveThresholds(
  get: (key: 'cpu' | 'mem') => number | undefined
): PanelThresholds {
  const cpuRaw = get('cpu');
  const memRaw = get('mem');
  return {
    cpuPercent: typeof cpuRaw === 'number' && Number.isFinite(cpuRaw) && cpuRaw > 0 ? cpuRaw : DEFAULT_CPU_THRESHOLD,
    memMb: typeof memRaw === 'number' && Number.isFinite(memRaw) && memRaw > 0 ? memRaw : DEFAULT_MEM_THRESHOLD_MB
  };
}

export interface ComponentRow {
  component: KBEngineComponentInfo;
  label: string;
  description: string;
  abnormal: boolean;
  reasons: string[];
  /** 进程消失墓碑行:上一轮可见、本轮缺席 */
  vanished: boolean;
}

/** usedmem 广播字段单位 MB(引擎 webconsole/StatusWindow 同口径展示) */
export function describeComponentRow(
  component: KBEngineComponentInfo,
  thresholds: PanelThresholds
): ComponentRow {
  const reasons: string[] = [];
  if (!COMPONENT_STATES_NORMAL.has(component.state)) {
    reasons.push(l10nText('state={state} (not COMPONENT_STATE_RUN)', { state: component.state }));
  }
  if (component.cpu > thresholds.cpuPercent) {
    reasons.push(l10nText('CPU {value}% over threshold {threshold}%', {
      value: component.cpu.toFixed(1),
      threshold: thresholds.cpuPercent
    }));
  }
  // usedmem 广播字段实为字节数(真机实测 machine≈14.5MB/dbmgr≈32.8MB,KB-GC-001)
  const usedmemMb = component.usedmem / 1024 / 1024;
  if (usedmemMb > thresholds.memMb) {
    reasons.push(l10nText('memory {value}MB over threshold {threshold}MB', {
      value: usedmemMb.toFixed(1),
      threshold: thresholds.memMb
    }));
  }
  const instance = component.fullName || component.componentName;
  const description = l10nText(
    'pid={pid} cpu={cpu}% mem={mem}MB {address}',
    {
      pid: component.pid,
      cpu: component.cpu.toFixed(1),
      mem: usedmemMb.toFixed(1),
      address: `${component.intaddr}:${component.intport}`
    }
  );
  return {
    component,
    label: instance,
    description,
    abnormal: reasons.length > 0,
    reasons,
    vanished: false
  };
}

export type AutoRefreshRegistrar = (intervalMs: number, fire: () => void) => () => void;

export class ComponentStatusTreeProvider implements vscode.TreeDataProvider<ComponentRow> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ComponentRow | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private lastSeen = new Map<string, KBEngineComponentInfo>();
  private vanished = new Map<string, KBEngineComponentInfo>();

  constructor(
    private readonly hub: Pick<ConsoleHub, 'getComponents' | 'getMachinedState' | 'pollOnce' | 'onDidChange'>,
    private readonly getThresholds: () => PanelThresholds
  ) {
    hub.onDidChange(() => {
      this.reconcileVanished();
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  /**
   * 上一轮可见、本轮缺席的进程 → 墓碑行(红色「进程消失」),保留到它重新
   * 出现或下一轮仍缺席为止——机器发现回包缺席 = machined 已看不到该进程。
   */
  private reconcileVanished(): void {
    const current = this.hub.getComponents();
    const currentKeys = new Set(
      current.map(c => `${c.componentType}:${c.componentID.toString()}:${c.pid}`)
    );
    const nextVanished = new Map<string, KBEngineComponentInfo>();
    for (const [key, component] of this.lastSeen) {
      if (!currentKeys.has(key)) {
        nextVanished.set(key, component);
      }
    }
    this.vanished = nextVanished;
    this.lastSeen = new Map(
      current.map(c => [`${c.componentType}:${c.componentID.toString()}:${c.pid}`, c])
    );
  }

  async getChildren(): Promise<ComponentRow[]> {
    const thresholds = this.getThresholds();
    const current = this.hub.getComponents();
    const unreachable = this.hub.getMachinedState() === 'unreachable';
    // 本轮快照入账:下一次 hub 变更时对账缺席(consume-only 的树读也入账)
    this.lastSeen = new Map(
      current.map(c => [`${c.componentType}:${c.componentID.toString()}:${c.pid}`, c])
    );
    const rows = current.map(component => describeComponentRow(component, thresholds));
    // machined 不可达:发现回包无应答,台账保留上一轮快照——如实标注为
    // 「快照过期」而非冒充实时(面板顶部插一条不可达说明行,逐行加过期标记)
    if (unreachable) {
      // 说明行不冒充真实组件:type/id/pid 全 -1 作哨兵;类型断言而非构造完整
      // 回包(该行永不参与台账对账,vanished 键按 sentinel 自身唯一)
      rows.unshift({
        component: {
          uid: 0,
          username: '',
          componentType: -1,
          componentID: BigInt(-1),
          componentIDEx: BigInt(0),
          globalOrderID: 0,
          groupOrderID: 0,
          genuuidSections: 0,
          intaddr: '',
          intport: 0,
          extaddr: '',
          extport: 0,
          extaddrEx: '',
          pid: -1,
          cpu: 0,
          mem: 0,
          usedmem: 0,
          state: 0,
          machineID: 0,
          extradata: BigInt(0),
          extradata1: BigInt(0),
          extradata2: BigInt(0),
          extradata3: BigInt(0),
          backaddr: 0,
          backport: 0,
          componentName: '',
          fullName: '',
          gus: 0
        } as KBEngineComponentInfo,
        label: l10nText('machined unreachable — showing the previous snapshot'),
        description: l10nText(
          'machined unreachable: discovery UDP 20086 has no answer; polling continues, data is a stale snapshot'
        ),
        abnormal: true,
        reasons: [l10nText('machined unreachable: discovery UDP 20086 has no answer; polling continues, data is a stale snapshot')],
        vanished: false
      });
    }
    for (const [, component] of this.vanished) {
      rows.push({
        component,
        label: component.fullName || component.componentName,
        description: l10nText('process vanished from machined discovery'),
        abnormal: true,
        reasons: [l10nText('process vanished from machined discovery')],
        vanished: true
      });
    }
    return rows;
  }

  getTreeItem(row: ComponentRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.description = row.abnormal
      ? `${row.description} ⚠ ${row.reasons.join('; ')}`
      : row.description;
    item.contextValue = row.abnormal ? 'abnormal' : 'normal';
    if (row.abnormal) {
      item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('errorForeground'));
      item.tooltip = row.reasons.join('\n');
    }
    return item;
  }

  /** 手动刷新:与自动轮询同一轮(不另起链);hub 完成轮询即经 onDidChange 通知树 */
  async refresh(): Promise<void> {
    await this.hub.pollOnce();
  }

  /** 自动刷新:注入式定时面(生产=setInterval,测试记录间隔);间隔生产传配置值 */
  startAutoRefresh(registrar: AutoRefreshRegistrar, intervalMs = 2000): () => void {
    return registrar(intervalMs, () => {
      void this.refresh();
    });
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
