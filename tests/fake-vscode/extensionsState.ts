// vscode.extensions 状态替身:all 暴露同一可变数组,测试按需注入/清空
// (IDE-REL-001 共激活检测与 IDE-MET-001 身份报告的采集面)。仅提供检测
// 所需最小字段;命令面用到的 version/extensionPath 等按需在条目上补。
// 2026-11-10 venv/Pylance 去重接线需要 getExtension(按 id 查条目)与
// onDidChange(扩展安装/激活/失活事件;fireExtensionsChanged 供测试触发)。
import { EventEmitter } from './core';

export interface FakeExtensionEntry {
  id: string;
  isActive: boolean;
}

export const fakeExtensionList: FakeExtensionEntry[] = [];

const extensionsChanged = new EventEmitter<void>();

export function fireExtensionsChanged(): void {
  extensionsChanged.fire(undefined);
}

export const extensions = {
  all: fakeExtensionList,
  getExtension(id: string): FakeExtensionEntry | undefined {
    return fakeExtensionList.find(entry => entry.id === id);
  },
  onDidChange(listener: () => void): { dispose(): void } {
    return extensionsChanged.event(listener);
  }
};
