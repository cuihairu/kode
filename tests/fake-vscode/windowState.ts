// fake-vscode 窗口状态层(docs/redesign.md 阶段 3):window 对象的状态化
// 实现——消息三通道入账、输出通道/状态栏/树视图登记、WebviewPanel 工厂
// 默认走 panelRegistry。tests/helpers/vscodeStub.ts re-export 本模块的
// `window`,既有用例对它的 monkey-patch 语义不变(共享同一可变对象)。

import { StatusBarAlignment } from './core';
import { panelRegistry, type FakeWebviewPanel } from './panelRegistry';

/** showInformationMessage / showWarningMessage / showErrorMessage 的入账 */
export const messages = {
  info: [] as string[],
  warning: [] as string[],
  error: [] as string[]
};

const showTextDocumentCalls: Array<{ document: unknown; options?: unknown }> = [];

/** createOutputChannel 的入账:每个通道记录 name 与追加的行 */
export interface RecordedOutputChannel {
  name: string;
  lines: string[];
  disposed: boolean;
}

const channels: RecordedOutputChannel[] = [];

/** createStatusBarItem 的入账 */
export interface RecordedStatusBarItem {
  alignment: StatusBarAlignment;
  priority: number;
  text: string;
  command: string | undefined;
  visible: boolean;
  disposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

const statusBars: RecordedStatusBarItem[] = [];

/** registerTreeDataProvider 的入账(viewId → provider) */
export const treeRegistrations: Array<{ viewId: string; provider: unknown }> = [];

export const window = {
  showErrorMessage: async (message: string): Promise<undefined> => {
    messages.error.push(message);
    return undefined;
  },
  showInformationMessage: async (message: string): Promise<undefined> => {
    messages.info.push(message);
    return undefined;
  },
  showWarningMessage: async (message: string): Promise<undefined> => {
    messages.warning.push(message);
    return undefined;
  },
  // 真实 vscode 返回 editor;openMethodTarget 断言 editor !== undefined,
  // 默认给真值对象,测试可临时覆盖为 undefined 模拟拒开。
  showTextDocument: async (document: unknown, options?: unknown): Promise<unknown> => {
    showTextDocumentCalls.push({ document, options });
    return {};
  },
  // codeGenerator 向导/模板与 debugConfig 组件选择消费;默认全部取消
  // (undefined),测试按用例 monkey-patch 为脚本化应答。
  showInputBox: async (): Promise<undefined> => undefined,
  showQuickPick: async (): Promise<undefined> => undefined,
  // logWebView 的 exportLogs 走保存对话框;默认取消(不落盘)。
  showSaveDialog: async (): Promise<undefined> => undefined,
  createOutputChannel: (name: string) => {
    const channel: RecordedOutputChannel = { name, lines: [], disposed: false };
    channels.push(channel);
    return {
      append: (value: string): void => {
        channel.lines.push(value);
      },
      appendLine: (value: string): void => {
        channel.lines.push(`${value}\n`);
      },
      show: (): void => undefined,
      dispose: (): void => {
        channel.disposed = true;
      }
    };
  },
  createStatusBarItem: (alignment: StatusBarAlignment, priority?: number): RecordedStatusBarItem => {
    const item: RecordedStatusBarItem = {
      alignment,
      priority: priority ?? 0,
      text: '',
      command: undefined,
      visible: false,
      disposed: false,
      show(): void {
        item.visible = true;
      },
      hide(): void {
        item.visible = false;
      },
      dispose(): void {
        item.disposed = true;
        item.visible = false;
      }
    };
    statusBars.push(item);
    return item;
  },
  registerTreeDataProvider: (viewId: string, provider: unknown): { dispose(): void } => {
    treeRegistrations.push({ viewId, provider });
    return {
      dispose: (): void => {
        const index = treeRegistrations.findIndex(item => item.viewId === viewId && item.provider === provider);
        if (index >= 0) {
          treeRegistrations.splice(index, 1);
        }
      }
    };
  },
  createWebviewPanel: (
    viewType: string,
    title: string,
    showOptions: unknown,
    options: unknown
  ): FakeWebviewPanel => panelRegistry.create(viewType, title, showOptions, options)
};

export const windowState = {
  showTextDocumentCalls,
  channels,
  statusBars,
  reset: (): void => {
    messages.info.length = 0;
    messages.warning.length = 0;
    messages.error.length = 0;
    showTextDocumentCalls.length = 0;
    channels.length = 0;
    statusBars.length = 0;
    treeRegistrations.length = 0;
  }
};
