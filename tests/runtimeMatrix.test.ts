import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// IDE-REL-005 最低 VS Code 运行时矩阵:engines.vscode 不是拍脑袋沿用,
// 而是两面推导+互锁——
// ① API 面:src 在用的 stable API 底线=1.66(languages.registerInlayHints
//   Provider,extension.ts 类型桩注册);测试面 1.59(vscode.tests.
//   createTestController)+1.61(TestRun appendOutput,IDE-TSK-005);这些
//   在 @types/vscode 钉 1.82.0 后 tsc 全绿=在用 API 全部 ≤1.82 的机器
//   验证。
// ② Node 面:bundle 产物 esbuild --target=node18(out/extension.js 与
//   out/pythonParserWorker.js 同靶),宿主扩展进程 Node≥18 → 按
//   vscode-versions 数据(ewanharris/vscode-versions)VS Code 1.82 起
//   Electron 内嵌 Node 18.15 → 运行时底线=1.82(高于 API 底线,取 1.82)。
// 本文件锁三处不回退:engines.vscode ≥1.82、@types/vscode 主次版本与
// engines 一致(防 types 漂到未来版本掩盖越界 API)、bundle 的
// --target=nodeN 与 engines 联动(N=18→1.82,N=20→1.90)。

const repoRoot = path.resolve(__dirname, '..');

function readPackageJson(): {
  engines: { node: string; vscode: string };
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
} {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
}

/** 解析 ^1.82.0 形态为 [major, minor, patch] */
function parseCaretVersion(value: string): [number, number, number] {
  const match = /^\^?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  expect(match, `无法解析版本声明: ${value}`).toBeTruthy();
  return [Number(match![1]), Number(match![2]), Number(match![3])];
}

/** bundle --target=nodeN → 所需最低 VS Code(vscode-versions 数据) */
const NODE_TARGET_TO_VSCODE: Record<number, [number, number]> = {
  16: [1, 80],
  18: [1, 82],
  20: [1, 90]
};

describe('VS Code 运行时矩阵守卫(IDE-REL-005)', () => {
  it('engines.vscode ≥1.82(API 底线 1.66 与 bundle node18 宿主要求取严)', () => {
    const pkg = readPackageJson();
    const [major, minor] = parseCaretVersion(pkg.engines.vscode);
    expect(major).toBe(1);
    expect(minor).toBeGreaterThanOrEqual(82);
  });

  it('@types/vscode 主次版本与 engines.vscode 一致(防 types 漂移掩盖越界 API)', () => {
    const pkg = readPackageJson();
    const types = parseCaretVersion(pkg.devDependencies['@types/vscode']);
    const engine = parseCaretVersion(pkg.engines.vscode);
    expect(`${types[0]}.${types[1]}`).toBe(`${engine[0]}.${engine[1]}`);
  });

  it('bundle --target=nodeN 与 engines.vscode 联动(N=18→≥1.82,N=20→≥1.90)', () => {
    const pkg = readPackageJson();
    const targets = [...pkg.scripts.bundle.matchAll(/--target=node(\d+)/g)].map(
      match => Number(match[1])
    );
    expect(targets.length).toBeGreaterThanOrEqual(2);
    for (const nodeTarget of targets) {
      const [wantMajor, wantMinor] = NODE_TARGET_TO_VSCODE[nodeTarget];
      const [major, minor] = parseCaretVersion(pkg.engines.vscode);
      expect(
        major > wantMajor || (major === wantMajor && minor >= wantMinor),
        `bundle --target=node${nodeTarget} 要求 VS Code ≥${wantMajor}.${wantMinor},但 engines=${pkg.engines.vscode}`
      ).toBe(true);
    }
  });
});
