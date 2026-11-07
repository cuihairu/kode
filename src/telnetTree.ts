import * as vscode from 'vscode';
import { l10nText } from './nlsRuntime';
import { TelnetProbeState, TelnetTarget } from './telnetService';

/**
 * telnet 独立树视图(批112 用户令:telnet 不要和 server 进程混在一起):
 * 独立视图 kbengine.telnetStatus(manifest when = kbengine.telnetConfigured,
 * 配置未开 telnet 时整视图隐藏),与 Servers 进程树彻底分开。
 */

export class TelnetTreeItem extends vscode.TreeItem {
  constructor(
    public readonly target: TelnetTarget,
    public readonly state: TelnetProbeState
  ) {
    super(l10nText('Telnet: {label}', { label: target.label }), vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(getTelnetStatusIcon(state));
    this.contextValue = `telnet_${target.key}`;
    this.description = `${target.host}:${target.port} · ${getTelnetStateLabel(state)}`;
    this.tooltip = [
      `telnet ${target.label}`,
      `${target.host}:${target.port}`,
      l10nText('Status: {state}', { state: getTelnetStateLabel(state) }),
      l10nText('Click to open the Telnet panel')
    ].join('\n');
    this.command = {
      command: 'kbengine.telnet.showPanel',
      title: l10nText('Show Telnet Panel')
    };
  }
}

export interface TelnetTreeDeps {
  getTargets(): TelnetTarget[];
  getState(key: string): TelnetProbeState;
}

export class TelnetTreeProvider implements vscode.TreeDataProvider<TelnetTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TelnetTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly deps: TelnetTreeDeps) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TelnetTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): TelnetTreeItem[] {
    return this.deps.getTargets().map(target => new TelnetTreeItem(target, this.deps.getState(target.key)));
  }
}

function getTelnetStatusIcon(state: TelnetProbeState): string {
  switch (state) {
    case 'connected':
      return 'circle-filled';
    case 'open':
      return 'circle-large-outline';
    case 'auth-required':
      return 'warning';
    case 'auth-rejected':
    case 'closed':
      return 'circle-slash';
    case 'unconfigured':
    default:
      return 'circle-large-outline';
  }
}

function getTelnetStateLabel(state: TelnetProbeState): string {
  switch (state) {
    case 'connected':
      return l10nText('Connected');
    case 'open':
      return l10nText('Open');
    case 'auth-required':
      return l10nText('Port open, auth not configured');
    case 'auth-rejected':
      return l10nText('Auth rejected');
    case 'unconfigured':
      return l10nText('Not configured');
    case 'closed':
    default:
      return l10nText('Not open');
  }
}
