import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  computeDefRenameEdits,
  renameInputsDrifted,
  resolveRenameSymbolAtOffset
} from '../src/defRenamer';
import type { RenameInputVersionRef } from '../src/defRenamer';
import { KBEngineRenameProvider } from '../src/languageProviders';
import { makeTextDocument, Position, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-NAV-010:重命名应用前校验输入版本。验收口径:预览期间文档变化时
// 重新计算或拒绝,不能套用旧范围——跨文件缓冲区漂移→重算(编辑范围按当前
// 文本),目标文档自身版本漂移→拒绝(抛错,符号可能已不在原位);输入版本
// 集合由 provider 记录,纯函数 renameInputsDrifted 按文件比对 {source,version}。

/** 磁盘版:注释行把偏移撑开,hp 在 0 基第 4 行 */
const MONSTER_DEF_DISK = [
  '<root>',
  '  <Parent> Hero </Parent>',
  '  <!-- stale comment line on disk -->',
  '  <Properties>',
  '    <hp> <Type> UINT16 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

/** 缓冲版 v2:无注释行,hp 在 0 基第 3 行 */
const MONSTER_DEF_V2 = [
  '<root>',
  '  <Parent> Hero </Parent>',
  '  <Properties>',
  '    <hp> <Type> UINT16 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

/** 缓冲版 v3:预览期间再插两行注释,hp 被推到 0 基第 5 行 */
const MONSTER_DEF_V3 = [
  '<root>',
  '  <Parent> Hero </Parent>',
  '  <!-- line added during preview -->',
  '  <!-- another line added during preview -->',
  '  <Properties>',
  '    <hp> <Type> UINT16 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const HERO_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp> <Type> UINT32 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

let root: string;
let heroPath: string;
let monsterPath: string;

const write = (relative: string, content: string): string => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  return file;
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav010-'));
  write('scripts/entities.xml', '<root>\n  <Hero/>\n  <Monster/>\n</root>\n');
  heroPath = write('scripts/entity_defs/Hero.def', HERO_DEF);
  monsterPath = write('scripts/entity_defs/Monster.def', MONSTER_DEF_DISK);
});

/** 打开(未保存)的 Monster.def 缓冲区替身 */
const openMonsterBuffer = (version: number, content: string): void => {
  stubWorkspace.textDocuments = [
    {
      uri: { toString: () => `file://${monsterPath}`, fsPath: monsterPath },
      version,
      getText: () => content
    }
  ];
};

const heroDoc = (version: number): ReturnType<typeof makeTextDocument> =>
  makeTextDocument(HERO_DEF, { fileName: heroPath, version });

const heroCursor = (): Position => {
  const offset = HERO_DEF.indexOf('<hp>') + 1;
  const before = HERO_DEF.slice(0, offset);
  return new Position(before.split('\n').length - 1, offset - (before.lastIndexOf('\n') + 1));
};

/** WorkspaceEdit 的 Map 按 Uri 对象身份键——按 fsPath 索引(与 defRenamer.test 同款) */
const editsForFile = (
  workspaceEdit: { entries(): Array<[{ fsPath: string }, Array<{ range: { start: Position } }>]> },
  filePath: string
): Array<{ range: { start: Position } }> => {
  const byPath = new Map(
    workspaceEdit.entries().map(([uri, edits]) => [uri.fsPath, edits] as const)
  );
  return byPath.get(filePath) ?? [];
};

describe('重命名输入版本校验(IDE-NAV-010)', () => {
  it('renameInputsDrifted 按文件比对 source+version:漂移/来源变/文件集变即 true,同版 false', () => {
    const v1: RenameInputVersionRef[] = [
      { filePath: '/a.def', source: 'document', version: 1 },
      { filePath: '/b.def', source: 'disk', version: 10 }
    ];
    expect(renameInputsDrifted(v1, [...v1])).toBe(false);
    expect(renameInputsDrifted(
      v1,
      [{ filePath: '/a.def', source: 'document', version: 2 }, v1[1]]
    )).toBe(true);
    expect(renameInputsDrifted(
      v1,
      [{ filePath: '/a.def', source: 'disk', version: 1 }, v1[1]]
    )).toBe(true);
    expect(renameInputsDrifted(
      v1,
      [{ filePath: '/a.def', source: 'document', version: 1 }]
    )).toBe(true);
    expect(renameInputsDrifted(v1, [])).toBe(true);
  });

  it('目标文档自身版本漂移→拒绝抛错,不套旧范围(跨重名手势不误伤)', async () => {
    const provider = new KBEngineRenameProvider();
    const cursor = heroCursor();

    // 第一次计算:记录输入版本
    const first = await provider.provideRenameEdits(heroDoc(1), cursor, 'vigor');
    expect(first).not.toBeNull();
    expect(editsForFile(first!, heroPath).length).toBeGreaterThan(0);

    // 目标文档被编辑(版本 1→2)→拒绝,不能返回旧范围
    await expect(
      provider.provideRenameEdits(heroDoc(2), cursor, 'vigor')
    ).rejects.toThrow(/target document|modified|changed/i);

    // 新手势:prepareRename 重置记录(真实 VS Code 每次手势起点都调 prepareRename)
    // → 不因旧版本记录误伤,新目标 v3 正常计算
    provider.prepareRename(heroDoc(3), cursor);
    const third = await provider.provideRenameEdits(heroDoc(3), cursor, 'vigor');
    expect(third).not.toBeNull();
    expect(editsForFile(third!, heroPath).length).toBeGreaterThan(0);
  });

  it('跨文件缓冲区漂移→重算(编辑范围按当前文本),不套预览时旧行', async () => {
    const provider = new KBEngineRenameProvider();
    const cursor = heroCursor();

    // 预览:Monster 缓冲版 v2,hp 在 0 基第 3 行
    openMonsterBuffer(2, MONSTER_DEF_V2);
    const first = await provider.provideRenameEdits(heroDoc(5), cursor, 'vigor');
    const firstMonster = editsForFile(first!, monsterPath);
    expect(firstMonster).toHaveLength(2);
    expect(firstMonster[0].range.start).toEqual(new Position(3, 5));

    // 预览期间 Monster 缓冲区变化(v2→v3,hp 移到第 5 行)→重算,不套旧行 3
    openMonsterBuffer(3, MONSTER_DEF_V3);
    const second = await provider.provideRenameEdits(heroDoc(5), cursor, 'vigor');
    const secondMonster = editsForFile(second!, monsterPath);
    expect(secondMonster).toHaveLength(2);
    expect(secondMonster[0].range.start, '跨文件漂移→重算为新行').toEqual(new Position(5, 5));
  });
});
