import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDefCallChain } from '../src/backend/defCallChain';
import type { EntityMappingIndex } from '../src/entityMapping';
import { workspace } from './helpers/vscodeStub';

/**
 * RUST-003 判据②「打开文件内存优先」——def 调用链读面的钉。
 *
 * 靶子是 buildDefCallChain 的**缺省** python 读实现（既有 4 个 defCallChain
 * 测试全经 options.readPythonFile 注入替身，缺省路径零覆盖）。钉法：不注入
 * 读面，逼出真默认实现，让它去读磁盘上已存在的 .py。
 *
 * 断言落点选「调用链边来自缓冲区内容」而非直接断言函数返回值——这样若回归成
 * 读盘，链形会不同（读到盘的版本），不是靠假想接口形状自证的绿。
 */

const definition = (name: string, section: string, line: number) => ({
  defFile: '/proj/scripts/entity_defs/Hero.def',
  line,
  section,
  exposed: false,
  owner: { kind: 'entity', name: 'Hero', filePath: '/proj/scripts/entity_defs/Hero.def', line: 1 },
  declaredArgs: ['UINT32'],
  identity: {
    ownerKind: 'entity',
    ownerName: 'Hero',
    sourceKind: 'local',
    sourceChain: ['Hero'],
    section,
    symbolName: name
  }
});

const pythonMethod = (
  filePath: string,
  methodName: string,
  line: number,
  endLine: number,
  bindingSection: string,
  bindingName: string
) => ({
  filePath,
  methodName,
  line,
  character: 4,
  endLine,
  calls: [],
  binding: {
    pythonFile: filePath,
    identity: {
      ownerKind: 'entity',
      ownerName: 'Hero',
      sourceKind: 'local',
      sourceChain: ['Hero'],
      section: bindingSection,
      symbolName: bindingName
    }
  }
});

const ORIGINAL_DOCS = workspace.textDocuments as unknown[];
afterEach(() => {
  workspace.textDocuments = ORIGINAL_DOCS;
});

describe('def 调用链读面:打开文件内存优先(RUST-003)', () => {
  let temporaryRoot = '';
  // 磁盘上的 base/Hero.py 绝对路径(每次 beforeEach 重建)
  let baseFile = '';

  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'def-chain-open-'));
    mkdirSync(join(temporaryRoot, 'base'), { recursive: true });
    baseFile = join(temporaryRoot, 'base', 'Hero.py');
  });

  afterEach(() => {
    if (temporaryRoot) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  /** 不注入 readPythonFile —— 走缺省真实现 */
  const build = (): EntityMappingIndex => ({
    rootName: 'Hero',
    rootCategory: 'entity',
    rootDefFile: '/proj/scripts/entity_defs/Hero.def',
    semantics: {} as EntityMappingIndex['semantics'],
    propertyDefinitions: [],
    methodDefinitions: [
      definition('start', 'BaseMethods', 2),
      definition('diskTarget', 'CellMethods', 2),
      definition('bufferTarget', 'CellMethods', 2)
    ],
    pythonOwnerFiles: [],
    pythonMethods: [pythonMethod(baseFile, 'start', 1, 3, 'BaseMethods', 'start')]
  });

  it('打开中的 .py 取缓冲区,不读盘(盘上文件内容与缓冲区不同)', () => {
    // 盘上文件:调用 diskTarget
    writeFileSync(baseFile, ['class Hero:', '    def start(self, amount):', '        self.cell.diskTarget(1)'].join('\n'));
    // 编辑器里未保存的内容:改调 bufferTarget
    workspace.textDocuments = [
      {
        uri: { toString: () => `file://${baseFile}`, fsPath: baseFile },
        version: 7,
        getText: () => ['class Hero:', '    def start(self, amount):', '        self.cell.bufferTarget(1)'].join('\n')
      }
    ];

    const chain = buildDefCallChain(build(), {
      filePath: baseFile,
      methodName: 'start',
      line: 2
    });

    // 边按 receiver 分:若真读了盘,会出现 diskTarget;出现 bufferTarget 即证明
    // 读的是缓冲区(未保存内容优先)。
    const targets = (chain?.edges ?? []).map(edge => edge.to);
    expect(targets.some(id => id.includes('bufferTarget'))).toBe(true);
    expect(targets.some(id => id.includes('diskTarget'))).toBe(false);
  });
});