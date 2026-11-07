/**
 * KB-GC-001 guiconsole 期一·共享连接面:machined UDP 发现轮询 + 组件台账。
 *
 * 日志 tail(65501 长连)与组件状态面板共用这一个 hub——发现/连接台账只有
 * 一份,不建两套链(设计文档 docs/design/kbengine-guiconsole-integration.md
 * §4:负载快照本就随发现回包 Args25 携带,machine.cpp:219-228)。
 *
 * machined 不可达如实记账(state=unreachable + 错误文案),不硬试:
 * machined 是发现广播的唯一应答者(设计文档 §2),它不在时 UDP 轮询只会
 * 超时,任何「照常出数据」的呈现都是伪造。
 *
 * 真机口径:生产 discoverLocalComponents 默认 127.0.0.1:20086(保持链路
 * localhost-only,设计文档 §5 安全边界);跨机联验用 KODE_LIV_DISCOVERY_HOST
 * 显式注入(与 IDE-LIV-003 同款)。
 */

import * as vscode from 'vscode';
import {
  discoverLocalComponents,
  MachineDiscoveryOptions,
  type KBEngineComponentInfo
} from './kbengineProtocol';

export type MachinedState = 'idle' | 'reachable' | 'unreachable';

export interface ConsoleHubOptions {
  discovery?: MachineDiscoveryOptions;
  pollIntervalMs?: number;
  /** 测试注入;生产=discoverLocalComponents */
  discoverFn?: (options: MachineDiscoveryOptions) => Promise<KBEngineComponentInfo[]>;
}

export interface ConsoleHubDepsLike {
  getComponents(): KBEngineComponentInfo[];
  getMachinedState(): MachinedState;
  getLogger(): KBEngineComponentInfo | undefined;
  onDidChange(listener: () => void): vscode.Disposable;
}

export class ConsoleHub implements ConsoleHubDepsLike {
  private readonly pollIntervalMs: number;
  private readonly discoverFn: (options: MachineDiscoveryOptions) => Promise<KBEngineComponentInfo[]>;
  private readonly discoveryOptions: MachineDiscoveryOptions;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private components: KBEngineComponentInfo[] = [];
  private machinedState: MachinedState = 'idle';
  private lastError: string | null = null;
  private lastAttemptAtMs = 0;
  private lastSucceededAtMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private disposed = false;

  constructor(options: ConsoleHubOptions = {}) {
    this.discoveryOptions = options.discovery ?? {};
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.discoverFn = options.discoverFn ?? discoverLocalComponents;
  }

  start(): void {
    if (this.disposed || this.timer) {
      return;
    }
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this._onDidChange.dispose();
  }

  /** 一轮发现(公开给测试与手动刷新;重入被并入进行中的一轮) */
  async pollOnce(): Promise<void> {
    if (this.disposed || this.polling) {
      return;
    }
    this.polling = true;
    this.lastAttemptAtMs = Date.now();
    try {
      const found = await this.discoverFn(this.discoveryOptions);
      if (found.length === 0) {
        this.machinedState = 'unreachable';
        this.lastError = 'machined 未发现任何 KBEngine 组件:请确认 machine 进程与引擎已启动(发现广播 UDP 20086 无应答)。';
      } else {
        this.components = found;
        this.machinedState = 'reachable';
        this.lastError = null;
        this.lastSucceededAtMs = Date.now();
      }
    } catch (error) {
      this.machinedState = 'unreachable';
      this.lastError = `machined 不可达:${error instanceof Error ? error.message : String(error)}。发现广播 UDP 20086 无应答,轮询保持但不硬试其他通道。`;
    } finally {
      this.polling = false;
      this._onDidChange.fire();
    }
  }

  getComponents(): KBEngineComponentInfo[] {
    return [...this.components];
  }

  getComponent(componentType: number, componentID: bigint): KBEngineComponentInfo | undefined {
    return this.components.find(
      component => component.componentType === componentType && component.componentID === componentID
    );
  }

  getLogger(): KBEngineComponentInfo | undefined {
    return this.components.find(component => component.componentType === 10);
  }

  getMachinedState(): MachinedState {
    return this.machinedState;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getLastAttemptAtMs(): number {
    return this.lastAttemptAtMs;
  }

  getLastSucceededAtMs(): number {
    return this.lastSucceededAtMs;
  }
}
