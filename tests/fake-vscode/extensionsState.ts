// vscode.extensions 状态替身:all 暴露同一可变数组,测试按需注入/清空
// (IDE-REL-001 共激活检测与 IDE-MET-001 身份报告的采集面)。仅提供检测
// 所需最小字段;命令面用到的 version/extensionPath 等按需在条目上补。
export interface FakeExtensionEntry {
  id: string;
  isActive: boolean;
}

export const fakeExtensionList: FakeExtensionEntry[] = [];

export const extensions = { all: fakeExtensionList };
