// mocha 烟测层共用工具(docs/redesign.md 阶段 4)。旧 Fake* 值类型已退役:
// 统一复用 tests/fake-vscode 的编译副本(out/tests/helpers/vscodeStub.js,
// 由 tsconfig.mocha.json 产出,与 vitest 层同一份替身实现——消除 P12 的
// 双替身分叉)。模块加载仍走 module._load 补丁注入,目标是被测的编译产物
// (out/*.js)而非 TS 源,这是本层区别于 vitest 层的价值:验证 tsc 产物与
// 完整模块图在打包形态下可装配。

import { createRequire } from 'module';

const moduleLoader = createRequire(__filename)('module') as typeof import('module') & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  createRequire(filename: string): NodeRequire;
};

/** fake-vscode 编译副本的最小消费面(完整导出见 tests/helpers/vscodeStub.ts) */
export interface CompiledVscodeStub {
  window: Record<string, unknown>;
  workspace: { workspaceFolders: unknown } & Record<string, unknown>;
  commands: Record<string, unknown>;
  Uri: { file(path: string): unknown };
  Position: new (line: number, character: number) => unknown;
  StatusBarAlignment: Record<string, number>;
  makeTextDocument(
    text: string,
    options?: { fileName?: string; languageId?: string }
  ): unknown;
  commandRegistry: {
    registeredCommandIds(): string[];
    reset(): void;
  };
  languagesRegistry: { reset(): void };
  windowState: {
    reset(): void;
    statusBars: Array<{
      alignment: number;
      priority: number;
      text: string;
      visible: boolean;
      disposed: boolean;
    }>;
  };
  treeRegistrations: Array<{ viewId: string; provider: unknown }>;
  workspaceState: { reset(): void };
  panelRegistry: { panels: Array<{ viewType: string }>; reset(): void };
}

// require 编译副本:从 out/test/suite 出发解析到 out/tests/helpers/vscodeStub
// (由 package.json test 链中的 `tsc -p tsconfig.mocha.json` 产出;两级 ..
// 到 out/,与产物布局 out/tests 对齐)
const compiledStub = createRequire(__filename)('../../tests/helpers/vscodeStub') as unknown as CompiledVscodeStub;

/** 共享的 fake-vscode 编译副本单例(同一进程内与生产模块图注入同一实例) */
export function loadCompiledVscodeStub(): CompiledVscodeStub {
  return compiledStub;
}

/** 各登记层复位(workspaceFolders 不在此清空,由测试自行管理) */
export function resetCompiledVscodeStub(stub: CompiledVscodeStub): void {
  stub.commandRegistry.reset();
  stub.languagesRegistry.reset();
  stub.windowState.reset();
  stub.workspaceState.reset();
  stub.panelRegistry.reset();
}

export function createModuleLoader(): {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  createRequire(filename: string): NodeRequire;
} {
  return moduleLoader;
}

export function loadModuleWithMocks<T>(
  testFile: string,
  modulePath: string,
  mocks: Record<string, unknown>,
  clearCache = false
): { loadedModule: T; restore: () => void } {
  const moduleLoader = createModuleLoader();
  const originalLoad = moduleLoader._load;

  moduleLoader._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }

    return originalLoad(request, parent, isMain);
  };

  const runtimeRequire = moduleLoader.createRequire(testFile);
  if (clearCache) {
    delete require.cache[runtimeRequire.resolve(modulePath)];
  }

  return {
    loadedModule: runtimeRequire(modulePath) as T,
    restore() {
      moduleLoader._load = originalLoad;
    }
  };
}
