import * as vscode from 'vscode';
import { baseNameOf } from './quickActionConfig';

export interface QuickActionTreeEntry {
  name: string;
  type: 'command' | 'script' | 'http';
  target: string;
  runDirect?: boolean;
}

export interface QuickActionTreeData {
  registered: QuickActionTreeEntry[];
  scripts: QuickActionTreeEntry[];
}

export interface QuickActionTreeDeps {
  getActions(): Promise<QuickActionTreeData>;
}

export class QuickActionTreeItem extends vscode.TreeItem {
  constructor(entry?: QuickActionTreeEntry | { group: 'registered' | 'scripts'; count: number }) {
    if (entry && 'group' in entry) {
      const registered = entry.group === 'registered';
      super(`${registered ? '已登记' : '全部脚本'} ${entry.count}`, vscode.TreeItemCollapsibleState.Expanded);
      this.contextValue = registered ? 'quickActionGroupRegistered' : 'quickActionGroupScripts';
      return;
    }
    if (!entry) {
      super('未配置快速执行动作：在 .kbengine/debug.json 的 quickActions 数组中添加，或点击重新扫描', vscode.TreeItemCollapsibleState.None);
      this.description = '点击扫描脚本';
      this.tooltip = '配置位置：.kbengine/debug.json → quickActions';
      this.command = { command: 'kbengine.quickActions.scanScripts', title: '重新扫描脚本' };
      this.contextValue = 'quickActionEmpty';
      return;
    }
    const scriptName = entry.type === 'script' ? baseNameOf(entry.target) : '';
    const label = scriptName || entry.name;
    super(label, vscode.TreeItemCollapsibleState.None);
    const scriptTarget = entry.type === 'script' && entry.target.length > 120
      ? `${entry.target.slice(0, Math.max(12, 120 - baseNameOf(entry.target).length - 5))}...${baseNameOf(entry.target)}`
      : entry.target;
    this.description = scriptTarget;
    this.tooltip = `${entry.name}\n${entry.target}\n点击执行`;
    this.contextValue = 'quickAction';
    this.command = { command: 'kbengine.quickActions.runByName', title: '执行快速动作', arguments: [entry.runDirect ? `@script:${entry.target}` : entry.name] };
  }
}

export class QuickActionTreeProvider implements vscode.TreeDataProvider<QuickActionTreeItem> {
  private readonly emitter = new vscode.EventEmitter<QuickActionTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: QuickActionTreeDeps) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: QuickActionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: QuickActionTreeItem): Promise<QuickActionTreeItem[]> {
    const data = await this.deps.getActions();
    if (element?.contextValue === 'quickActionGroupRegistered') return data.registered.map(action => new QuickActionTreeItem(action));
    if (element?.contextValue === 'quickActionGroupScripts') return data.scripts.map(action => new QuickActionTreeItem(action));
    if (data.registered.length === 0 && data.scripts.length === 0) return [new QuickActionTreeItem()];
    return [new QuickActionTreeItem({ group: 'registered', count: data.registered.length }), new QuickActionTreeItem({ group: 'scripts', count: data.scripts.length })];
  }
}
