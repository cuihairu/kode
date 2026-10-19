import * as vscode from 'vscode';
import { baseNameOf } from './quickActionConfig';

export interface QuickActionTreeEntry {
  name: string;
  type: 'command' | 'script' | 'http';
  target: string;
  runDirect?: boolean;
  method?: string;
  requestIndex?: number;
  requestSource?: 'debug' | 'settings';
}

export interface QuickActionTreeData {
  registered: QuickActionTreeEntry[];
  scripts: QuickActionTreeEntry[];
  httpRequests: QuickActionTreeEntry[];
}

export interface QuickActionTreeDeps {
  getActions(): Promise<QuickActionTreeData>;
}

export class QuickActionTreeItem extends vscode.TreeItem {
  constructor(entry?: QuickActionTreeEntry | { group: 'registered' | 'scripts' | 'httpRequests'; count: number }) {
    if (entry && 'group' in entry) {
      const groupName = entry.group === 'registered' ? '已登记' : entry.group === 'scripts' ? '全部脚本' : 'HTTP 请求';
      super(`${groupName} ${entry.count}`, vscode.TreeItemCollapsibleState.Expanded);
      this.contextValue = entry.group === 'registered' ? 'quickActionGroupRegistered' : entry.group === 'scripts' ? 'quickActionGroupScripts' : 'quickActionGroupHttp';
      return;
    }
    if (!entry) {
      super('配置 .kbengine/debug.json 的 quickActions 或 httpRequests', vscode.TreeItemCollapsibleState.None);
      this.description = 'HTTP 请求也可在设置 kbengine.httpRequests 中配置';
      this.tooltip = '脚本配置 quickActions；HTTP 请求可配置在 debug.json 或 kbengine.httpRequests 设置';
      this.command = { command: 'kbengine.quickActions.scanScripts', title: '重新扫描脚本' };
      this.contextValue = 'quickActionEmpty';
      return;
    }
    const scriptName = entry.type === 'script' ? baseNameOf(entry.target) : '';
    const httpLabel = entry.type === 'http' ? `${entry.method}  ${shortUrl(entry.target)}` : '';
    const label = httpLabel || scriptName || entry.name;
    super(label, vscode.TreeItemCollapsibleState.None);
    const scriptTarget = entry.type === 'script' && entry.target.length > 120
      ? `${entry.target.slice(0, Math.max(12, 120 - baseNameOf(entry.target).length - 5))}...${baseNameOf(entry.target)}`
      : entry.target;
    this.description = scriptTarget;
    this.tooltip = `${entry.name}${entry.type === 'http' ? `\n来源：${entry.requestSource === 'settings' ? 'kbengine.httpRequests 设置' : '.kbengine/debug.json'}` : ''}\n${entry.target}\n点击执行`;
    this.contextValue = 'quickAction';
    this.command = { command: 'kbengine.quickActions.runByName', title: '执行快速动作', arguments: [entry.requestIndex !== undefined ? `@http:${entry.requestSource ?? 'debug'}:${entry.requestIndex}` : entry.runDirect ? `@script:${entry.target}` : entry.name] };
  }
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${pathname}`;
  } catch { return url; }
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
    if (element?.contextValue === 'quickActionGroupHttp') return data.httpRequests.map(action => new QuickActionTreeItem(action));
    if (data.registered.length === 0 && data.scripts.length === 0 && data.httpRequests.length === 0) return [new QuickActionTreeItem()];
    return [new QuickActionTreeItem({ group: 'registered', count: data.registered.length }), new QuickActionTreeItem({ group: 'scripts', count: data.scripts.length }), new QuickActionTreeItem({ group: 'httpRequests', count: data.httpRequests.length })];
  }
}
