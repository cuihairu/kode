// fake-vscode 面板登记层(docs/redesign.md 阶段 3):WebviewPanel 工厂的
// 默认实现——window.createWebviewPanel 默认走 panelRegistry.create,生成
// 可编程假面板(记录创建参数、捕获 onDidReceiveMessage/onDidDispose、
// 可 fire)。阶段 4 WebView 面板测试迁移到此;需要完全自定义面板的测试
// 仍可整体替换 window.createWebviewPanel。

/** 记录型假 WebviewPanel:webview.html 可读写,postMessage 入账,
 *  onDidReceiveMessage/onDidDispose 的监听器被捕获并可经 fireXxx 触发。 */
export interface FakeWebviewPanel {
  readonly viewType: string;
  readonly title: string;
  readonly showOptions: unknown;
  readonly options: unknown;
  webview: {
    html: string;
    options: unknown;
    postedMessages: Array<{ message: unknown }>;
    postMessage(message: unknown): Promise<boolean>;
    onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void };
  };
  visible: boolean;
  revealed: boolean;
  disposed: boolean;
  /** 测试驱动面:被捕获的消息监听器(fireMessage 逐个调用) */
  readonly messageListeners: Array<(message: unknown) => void>;
  readonly disposeListeners: Array<() => void>;
  onDidDispose(listener: () => void): { dispose(): void };
  reveal(): void;
  dispose(): void;
}

function createPanel(viewType: string, title: string, showOptions: unknown, options: unknown): FakeWebviewPanel {
  const panel: FakeWebviewPanel = {
    viewType,
    title,
    showOptions,
    options,
    webview: {
      html: '',
      options: undefined,
      postedMessages: [],
      postMessage: async (message: unknown): Promise<boolean> => {
        panel.webview.postedMessages.push({ message });
        return true;
      },
      onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void } {
        panel.messageListeners.push(listener);
        return {
          dispose: (): void => {
            const index = panel.messageListeners.indexOf(listener);
            if (index >= 0) {
              panel.messageListeners.splice(index, 1);
            }
          }
        };
      }
    },
    visible: true,
    revealed: false,
    disposed: false,
    messageListeners: [],
    disposeListeners: [],
    onDidDispose(listener: () => void): { dispose(): void } {
      panel.disposeListeners.push(listener);
      return {
        dispose: (): void => {
          const index = panel.disposeListeners.indexOf(listener);
          if (index >= 0) {
            panel.disposeListeners.splice(index, 1);
          }
        }
      };
    },
    reveal(): void {
      panel.revealed = true;
    },
    dispose(): void {
      if (panel.disposed) {
        return;
      }
      panel.disposed = true;
      panel.visible = false;
      for (const listener of [...panel.disposeListeners]) {
        listener();
      }
      panel.disposeListeners.length = 0;
      panel.messageListeners.length = 0;
    }
  };
  return panel;
}

const panels: FakeWebviewPanel[] = [];

export const panelRegistry = {
  panels,
  create(viewType: string, title: string, showOptions: unknown, options: unknown): FakeWebviewPanel {
    const panel = createPanel(viewType, title, showOptions, options);
    panels.push(panel);
    return panel;
  },
  /** 向面板 webview 派发一条消息(触发被捕获的 onDidReceiveMessage 监听) */
  fireMessage(panel: FakeWebviewPanel, message: unknown): void {
    for (const listener of [...panel.messageListeners]) {
      listener(message);
    }
  },
  /** 触发面板销毁监听(与 panel.dispose() 等价,额外入注册表核对) */
  fireDispose(panel: FakeWebviewPanel): void {
    panel.dispose();
  },
  reset: (): void => {
    panels.length = 0;
  }
};
