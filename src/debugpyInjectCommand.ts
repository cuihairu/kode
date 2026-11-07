/**
 * KODE-DBG-001 方案②一键注入命令(docs/design/debugpy-attach.md 提案的
 * 首选项「Console injection command」):一条命令完成「telnet :python 层
 * 发 debugpy.listen + debugpy connect 附加」,不改引擎、零文件改动。
 *
 * 编排只复用既有面,不起第二条注入通路(与 IDE-AUD/复用约束同口径):
 * - 起监听 = extension.ts 的 startDebugpyListenerNow(同步资产树 debugpy 包
 *   + 等 telnet 就绪 + injectDebugpyListen,即 autoDebugpy 注入本体的单发形态,
 *   也是 IDE-PDBG-002 端口模式「起监听并附加」下一步控件同一条路);
 * - 附加 = DebugConfigManager.attachViaDebugpyPort(探端口→connect,含隧道/分诊)。
 * - 端口 = DEBUGPY_PORT_TABLE 逐组件表,表外回落 5678(与 IDE-PDBG-001
 *   端口模式回落同口径)。
 *
 * 开关 kbengine.debug.debugpyInject(缺省 true,KODE-DBG-001 批次口径):
 * 关闭时命令只提示不动作——注入是显式用户行为,闸的意义是给不想要该命令
 * 的工作区一个干净的关闭位。早期启动期断点(方案①)由
 * kbengine.debug.waitAtStartup 覆盖,不在本命令职责内。
 */

import * as vscode from 'vscode';
import { debugpyPortFor } from './autoDebugpy';

/** 命令 id(package.json contributes 同名锁定) */
export const DEBUGPY_INJECT_COMMAND = 'kbengine.debug.debugpyInject';

/** 开关缺省值(KODE-DBG-001:默认开启) */
export const DEBUGPY_INJECT_ENABLED_DEFAULT = true;

/** 表外组件回落口(与 debugConfig 端口模式回落同口径) */
export const DEFAULT_DEBUGPY_INJECT_PORT = 5678;

export function debugpyInjectEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('debug.debugpyInject', DEBUGPY_INJECT_ENABLED_DEFAULT);
}

export interface DebugpyInjectChoice {
  readonly component: string;
  readonly label: string;
}

export interface DebugpyInjectListenerResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface DebugpyInjectCommandDeps {
  isEnabled(): boolean;
  listRunningComponents(): DebugpyInjectChoice[];
  portFor(component: string): number | undefined;
  ensureListener(component: string, port: number): Promise<DebugpyInjectListenerResult>;
  attachViaDebugpyPort(component: string): Promise<boolean>;
  pickComponent(choices: DebugpyInjectChoice[]): Promise<DebugpyInjectChoice | undefined>;
  showInformationMessage(message: string): unknown;
  showErrorMessage(message: string): unknown;
}

export async function runDebugpyInjectCommand(deps: DebugpyInjectCommandDeps): Promise<void> {
  if (!deps.isEnabled()) {
    deps.showInformationMessage(
      'debugpy 一键注入已关闭(kbengine.debug.debugpyInject=false)——可在设置中重新开启'
    );
    return;
  }
  const choices = deps.listRunningComponents();
  if (choices.length === 0) {
    deps.showInformationMessage('没有运行中的 KBEngine 组件——先启动服务,再一键注入 debugpy');
    return;
  }
  const picked = await deps.pickComponent(choices);
  if (picked === undefined) {
    return;
  }
  const port = deps.portFor(picked.component);
  if (port === undefined) {
    deps.showErrorMessage(`${picked.component} 没有可用的 debugpy 端口`);
    return;
  }
  const ensured = await deps.ensureListener(picked.component, port);
  if (!ensured.ok) {
    deps.showErrorMessage(`${picked.component} 起监听失败——${ensured.detail}`);
    return;
  }
  const attached = await deps.attachViaDebugpyPort(picked.component);
  if (attached) {
    deps.showInformationMessage(
      `${picked.component} debugpy 已在 127.0.0.1:${port} 监听,调试器已附加——可以下断点`
    );
  } else {
    deps.showErrorMessage(
      `${picked.component} 监听已就绪(127.0.0.1:${port})但附加未完成——可用 Attach to Component 重试`
    );
  }
}

/** extension.ts 装配面:真 vscode 输入面 + 注入/附加闭包注入 */
export interface DebugpyInjectWiringDeps {
  listRunningComponents(): DebugpyInjectChoice[];
  ensureListener(component: string, port: number): Promise<DebugpyInjectListenerResult>;
  attachViaDebugpyPort(component: string): Promise<boolean>;
}

export function registerDebugpyInjectCommand(context: vscode.ExtensionContext, deps: DebugpyInjectWiringDeps): void {
  const command = vscode.commands.registerCommand(DEBUGPY_INJECT_COMMAND, () =>
    runDebugpyInjectCommand({
      isEnabled: debugpyInjectEnabled,
      listRunningComponents: deps.listRunningComponents,
      portFor: component => debugpyPortFor(component) ?? DEFAULT_DEBUGPY_INJECT_PORT,
      ensureListener: deps.ensureListener,
      attachViaDebugpyPort: deps.attachViaDebugpyPort,
      pickComponent: async choices => {
        const picked = await vscode.window.showQuickPick(
          choices.map(choice => ({ label: choice.label, choice })),
          { placeHolder: '选择要注入 debugpy 的运行中组件' }
        );
        return picked?.choice;
      },
      showInformationMessage: message => {
        void vscode.window.showInformationMessage(message);
      },
      showErrorMessage: message => {
        void vscode.window.showErrorMessage(message);
      }
    })
  );
  context.subscriptions.push(command);
}
