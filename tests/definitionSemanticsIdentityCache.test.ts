import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspace } from './fake-vscode/workspaceState';
import { createDefinitionSemanticsLoader } from '../src/backend/definitionSemantics';

// RUST-003:语义 loader 缓存身份化——身份集合(消费文件集 {source,version}
// 令牌)漂移即重解析,不依赖失效调用。本套件全部用「同一 loader 实例、
// 消费文件在两次查询之间被改」逼出过期窗口:身份化缺失的旧实现会把缓存
// 里的旧语义原样返回(假新鲜),任一例红即证明身份面被摘。

function writeDef(root: string, relative: string, lines: string[]): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  return target;
}

/** 强制 mtimeMs 前进(stat 粒度秒级/挂钟回拨都要躲开) */
function bumpMtime(filePath: string): void {
  const stat = fs.statSync(filePath);
  fs.utimesSync(filePath, new Date(stat.mtimeMs + 5_000), new Date(stat.mtimeMs + 5_000));
}

describe('DefinitionSemanticsLoader 缓存身份化(RUST-003)', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sem-identity-'));
    writeDef(root, 'scripts/entity_defs/Hero.def', [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ]);
  });

  afterEach(() => {
    workspace.textDocuments = [];
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('loadLocal:入口文件 mtime 漂移后同 loader 再查询吃到新语义', () => {
    const loader = createDefinitionSemanticsLoader(root)!;

    expect(loader.loadLocal('Hero', 'entity')?.properties.map(property => property.name))
      .toEqual(['hp']);

    // 盘上改文件并强推 mtime 前进(mtimeMs 粒度内连续写不产生漂移,身份面
    // 需要可见差异才谈得上检测)
    writeDef(root, 'scripts/entity_defs/Hero.def', [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </hp>',
      '    <mana>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </mana>',
      '  </Properties>',
      '</root>'
    ]);
    bumpMtime(path.join(root, 'scripts/entity_defs/Hero.def'));

    // 同一 loader 实例:身份化前这里是旧缓存(hp 一项,假新鲜)
    expect(loader.loadLocal('Hero', 'entity')?.properties.map(property => property.name))
      .toEqual(['hp', 'mana']);
  });

  it('loadResolved:入口文件未变、父文件变了也重解析(visited 全量重探)', () => {
    const base = writeDef(root, 'scripts/entity_defs/Base.def', [
      '<root>',
      '  <Properties>',
      '    <stamina>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </stamina>',
      '  </Properties>',
      '</root>'
    ]);
    writeDef(root, 'scripts/entity_defs/Hero.def', [
      '<root>',
      '  <Parent>Base</Parent>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ]);

    const loader = createDefinitionSemanticsLoader(root)!;
    expect(loader.loadResolved('Hero', 'entity')?.effectiveProperties.map(property => property.name))
      .toEqual(['hp', 'stamina']);

    // 入口 Hero.def 一字不动,只改父文件:只验入口身份的实现会在这里
    // 返回旧 effective 集(父属性不出现)——身份集合化后必须重解析。
    writeDef(root, 'scripts/entity_defs/Base.def', [
      '<root>',
      '  <Properties>',
      '    <stamina>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </stamina>',
      '    <mana>',
      '      <Type>UINT32</Type>',
      '      <Flags>CELL_PRIVATE</Flags>',
      '    </mana>',
      '  </Properties>',
      '</root>'
    ]);
    bumpMtime(base);

    expect(loader.loadResolved('Hero', 'entity')?.effectiveProperties.map(property => property.name))
      .toEqual(['hp', 'stamina', 'mana']);
  });

  it('loadResolvedAt:入口文件 mtime 漂移后同 loader 再查询吃到新语义', () => {
    const defPath = path.join(root, 'scripts/entity_defs/Hero.def');
    const loader = createDefinitionSemanticsLoader(root)!;

    expect(loader.loadResolvedAt(defPath, 'Hero', 'entity')?.local.properties)
      .toHaveLength(1);

    writeDef(root, 'scripts/entity_defs/Hero.def', [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </hp>',
      '    <speed>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </speed>',
      '  </Properties>',
      '</root>'
    ]);
    bumpMtime(defPath);

    // 同一 loader 实例:身份化前这里是旧 local(单属性)
    expect(loader.loadResolvedAt(defPath, 'Hero', 'entity')?.local.properties)
      .toHaveLength(2);
  });

  it('打开文档 version 前进即漂移:缓冲区新内容同 loader 当轮可见', () => {
    const defPath = path.join(root, 'scripts/entity_defs/Hero.def');
    let buffer = fs.readFileSync(defPath, 'utf8');
    // 文档对象要可变:version 推进必须落在对象属性上(局部变量按值捕获
    // 推不动对象字面量里的 version,身份面看不到前进——上一版测试自己踩的坑)
    const openDoc = {
      uri: { toString: () => `file://${defPath}`, fsPath: defPath },
      version: 1,
      getText: () => buffer
    };
    workspace.textDocuments = [openDoc];

    const loader = createDefinitionSemanticsLoader(root)!;
    expect(loader.loadLocal('Hero', 'entity')?.properties).toHaveLength(1);

    // 编辑器里加属性:document 域身份=编辑序号,version 前进即漂移
    buffer = [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </hp>',
      '    <unsaved>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </unsaved>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    openDoc.version = 2;

    // 同一 loader 实例:身份化前这里吃旧缓冲(单属性)
    expect(loader.loadLocal('Hero', 'entity')?.properties.map(property => property.name))
      .toEqual(['hp', 'unsaved']);
  });

  it('文件删除后不落陈旧 null:消失→null、重建→当轮可见', () => {
    const defPath = path.join(root, 'scripts/entity_defs/Hero.def');
    const loader = createDefinitionSemanticsLoader(root)!;

    expect(loader.loadLocal('Hero', 'entity')).not.toBeNull();

    fs.rmSync(defPath);
    expect(loader.loadLocal('Hero', 'entity')).toBeNull();

    writeDef(root, 'scripts/entity_defs/Hero.def', [
      '<root>',
      '  <Properties>',
      '    <revived>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </revived>',
      '  </Properties>',
      '</root>'
    ]);

    // 同一 loader 实例:身份化前 null 记账让重建文件也吃 null
    expect(loader.loadLocal('Hero', 'entity')?.properties.map(property => property.name))
      .toEqual(['revived']);
  });
});
