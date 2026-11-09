import * as vscode from 'vscode';
import { l10nText } from './nlsRuntime';
import { baseNameOf } from './backend/quickActionConfig';

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
  constructor(entry?: QuickActionTreeEntry | { group: 'registered' | 'scripts' | 'httpRequests'; count: number } | { empty: 'http' }) {
    if (entry && 'empty' in entry) {
      super(l10nText('Configure HTTP requests'), vscode.TreeItemCollapsibleState.None);
      this.description = l10nText('Open HTTP request settings');
      this.command = { command: 'workbench.action.openSettings', title: l10nText('Configure HTTP requests'), arguments: ['kbengine.httpRequests'] };
      this.contextValue = 'quickActionEmptyHttp';
      return;
    }
    if (entry && 'group' in entry) {
      // 分类分组标题走 vscode.l10n:调用期求值,默认英文源串,zh-cn bundle 出中文
      const groupName = entry.group === 'registered'
        ? vscode.l10n.t('Registered')
        : entry.group === 'scripts'
          ? vscode.l10n.t('All Scripts')
          : vscode.l10n.t('HTTP Requests');
      super(`${groupName} ${entry.count}`, vscode.TreeItemCollapsibleState.Expanded);
      this.contextValue = entry.group === 'registered' ? 'quickActionGroupRegistered' : entry.group === 'scripts' ? 'quickActionGroupScripts' : 'quickActionGroupHttp';
      return;
    }
    if (!entry) {
      super(l10nText('Scan workspace scripts'), vscode.TreeItemCollapsibleState.None);
      this.description = l10nText('Choose scripts to add as quick actions');
      // UX-REVIEW-003c:tooltip 必须与实际行为一致——此条目在工作区已开但
      // 无脚本时同样出现,不能谎称「要先打开工作区」;点击即跑扫描,无工作区
      // 时由 scanScriptsAndRefresh 给出打开指引。
      this.tooltip = l10nText('Runs the script scan; you will be guided to open a workspace when none is open');
      this.command = { command: 'kbengine.quickActions.scanScripts', title: l10nText('Rescan scripts') };
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
    // UX-REVIEW-003c:配置来源行——registered 动作(非 runDirect 直达面)
    // 来自 .kbengine/debug.json,与 HTTP 行同键同口径点名;扫描直达脚本的
    // 来源就是自身路径(description/tooltip 已示),不再重复标注。
    const source = entry.type === 'http'
      ? (entry.requestSource === 'settings' ? 'kbengine.httpRequests' : '.kbengine/debug.json')
      : entry.runDirect
        ? undefined
        : '.kbengine/debug.json';
    const sourceLine = source ? `\n${l10nText('Source: {source}', { source })}` : '';
    this.tooltip = `${entry.name}${sourceLine}\n${entry.target}\n${l10nText('Click to run')}`;
    this.contextValue = 'quickAction';
    this.command = { command: 'kbengine.quickActions.runByName', title: l10nText('Run quick action'), arguments: [entry.requestIndex !== undefined ? `@http:${entry.requestSource ?? 'debug'}:${entry.requestIndex}` : entry.runDirect ? `@script:${entry.target}` : entry.name] };
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
    if (data.registered.length === 0 && data.scripts.length === 0 && data.httpRequests.length === 0) return [new QuickActionTreeItem(), new QuickActionTreeItem({ empty: 'http' })];
    return [new QuickActionTreeItem({ group: 'registered', count: data.registered.length }), new QuickActionTreeItem({ group: 'scripts', count: data.scripts.length }), new QuickActionTreeItem({ group: 'httpRequests', count: data.httpRequests.length })];
  }
}
