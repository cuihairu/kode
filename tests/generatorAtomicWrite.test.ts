import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KBEngineCodeGenerator } from '../src/codeGenerator';
import { generateGeneratorForm } from '../src/generatorForms';
import { writeFileAtomic } from '../src/atomicFileWrite';
import type * as vscode from 'vscode';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-GEN-005:生成器写盘走原子替换(同目录临时文件+rename 落位)。
// 中断模拟:vi.mock 包一层 fs.writeFileSync,对目标文件与临时文件先写
// 半截再抛错——直写实现会把旧文件截断成半截文本(红),原子实现只在
// 临时文件上留下残迹并清理,旧文件字节原封(绿)。vitest 的 fs 命名空间
// 冻结不可直改,故走 vi.mock(对 src 模块同图生效)。

const interruptState = vi.hoisted(() => ({
  root: '',
  targets: [] as string[]
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realWriteFileSync = actual.writeFileSync;
  return {
    ...actual,
    writeFileSync: ((target: unknown, data: unknown, options: unknown) => {
      const targetPath = typeof target === 'string' ? target : '';
      const isTemp = targetPath.includes('.kode-tmp')
        && interruptState.root !== ''
        && targetPath.startsWith(interruptState.root);
      if (interruptState.targets.includes(targetPath) || isTemp) {
        realWriteFileSync(targetPath, String(data).slice(0, 20), 'utf8');
        throw new Error('simulated interruption');
      }
      return realWriteFileSync(target as never, data as never, options as never);
    }) as typeof realWriteFileSync
  };
});

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-atomic-'));
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
});

afterEach(() => {
  interruptState.root = '';
  interruptState.targets = [];
  fs.rmSync(root, { recursive: true, force: true });
});

describe('generator atomic writes (IDE-GEN-005)', () => {
  it('keeps entities.xml intact when the registration write is interrupted', async () => {
    const entitiesXml = path.join(root, 'scripts', 'entities.xml');
    const original = [
      '<root>',
      '  <BaseThing hasBase="true" hasCell="false" hasClient="false" />',
      '  <OtherThing hasBase="true" hasCell="true" hasClient="false" />',
      '</root>',
      ''
    ].join('\n');
    fs.writeFileSync(entitiesXml, original, 'utf8');

    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const generator = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
    interruptState.root = root;
    interruptState.targets = [entitiesXml];

    await expect(
      generator.registerInEntitiesXml({ name: 'Monster', hasBase: true, hasCell: false, hasClient: false })
    ).rejects.toThrow('simulated interruption');

    // 旧文件保持完整,没有半截文本,也没有临时文件残留
    expect(fs.readFileSync(entitiesXml, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.join(root, 'scripts')).sort()).toEqual(['entities.xml', 'entity_defs']);
  });

  it('keeps types.xml intact when the fixed dict write is interrupted', () => {
    const typesXml = path.join(root, 'scripts', 'entity_defs', 'types.xml');
    const original = [
      '<root>',
      '  <ITEM_ID>',
      '    <Type>UINT32</Type>',
      '  </ITEM_ID>',
      '</root>',
      ''
    ].join('\n');
    fs.writeFileSync(typesXml, original, 'utf8');
    interruptState.root = root;
    interruptState.targets = [typesXml];

    expect(() =>
      generateGeneratorForm(
        { kind: 'fixedDict', value: { name: 'AVATAR_DATA', properties: [{ name: 'value', type: 'UINT32' }] } },
        root
      )
    ).toThrow('simulated interruption');

    expect(fs.readFileSync(typesXml, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.join(root, 'scripts', 'entity_defs')).sort()).toEqual(['types.xml']);
  });

  it('writeFileAtomic creates a new file and fully replaces an existing one', () => {
    const dir = path.join(root, 'unit');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'fresh.txt');
    writeFileAtomic(target, 'first');
    expect(fs.readFileSync(target, 'utf8')).toBe('first');

    writeFileAtomic(target, 'second-complete-content');
    expect(fs.readFileSync(target, 'utf8')).toBe('second-complete-content');
    // 落位后目录里只有目标文件,无临时残留
    expect(fs.readdirSync(dir)).toEqual(['fresh.txt']);
  });

  it('writeFileAtomic leaves the target untouched and cleans the temp file when interrupted', () => {
    const dir = path.join(root, 'unit');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'kept.txt');
    fs.writeFileSync(target, 'original-full-content', 'utf8');
    interruptState.root = root;
    interruptState.targets = [];

    expect(() => writeFileAtomic(target, 'new-content-that-never-lands')).toThrow('simulated interruption');

    expect(fs.readFileSync(target, 'utf8')).toBe('original-full-content');
    expect(fs.readdirSync(dir)).toEqual(['kept.txt']);
  });
});
