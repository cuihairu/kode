import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  computeDefRenameEdits,
  resolveRenameSymbolAtOffset
} from '../src/defRenamer';
import { KBEngineRenameProvider } from '../src/languageProviders';
import { makeTextDocument, Position, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-NAV-009:重命名计算读取其他脏 def 缓冲区。验收口径:跨文件编辑范围
// 按各文件当前文本(打开文档缓冲区优先)计算,不用过期磁盘偏移——跨文件
// 链接文件在位打开时,computeDefRenameEdits 经注入读口取缓冲区文本,
// provider 面复现同一条(目标文件本就走 document.getText)。

/** 磁盘版(陈旧):hp 声明在第 4 行(0 基);一行注释把偏移撑开 */
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

/** 缓冲区版(当前):无注释行,hp 声明在第 3 行(0 基)——与磁盘偏移不同 */
const MONSTER_DEF_DIRTY = [
  '<root>',
  '  <Parent> Hero </Parent>',
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav009-'));
  // defs 根定位依赖 entities.xml 在位(与 defRenamer.test 固定装置同款)
  write('scripts/entities.xml', '<root>\n  <Hero/>\n  <Monster/>\n</root>\n');
  heroPath = write('scripts/entity_defs/Hero.def', HERO_DEF);
  monsterPath = write('scripts/entity_defs/Monster.def', MONSTER_DEF_DISK);
});

/** 打开(未保存)的 Monster.def 缓冲区替身 */
const openDirtyMonster = (): void => {
  stubWorkspace.textDocuments = [
    {
      uri: { toString: () => `file://${monsterPath}`, fsPath: monsterPath },
      version: 2,
      getText: () => MONSTER_DEF_DIRTY
    }
  ];
};

/** 测试侧独立换算:文本内 offset → 位置(不经被测接口) */
const positionIn = (text: string, offset: number): { line: number; character: number } => {
  const before = text.slice(0, offset);
  return {
    line: before.split('\n').length - 1,
    character: offset - (before.lastIndexOf('\n') + 1)
  };
};

/** WorkspaceEdit 的 Map 按 Uri 对象身份键——按 fsPath 索引(与 defRenamer.test 同款) */
const monsterEditsFrom = (workspaceEdit: {
  entries(): Array<[{ fsPath: string }, Array<{ range: { start: Position } }>]>
}): Array<{ range: { start: Position } }> => {
  const byPath = new Map(
    workspaceEdit.entries().map(([uri, edits]) => [uri.fsPath, edits] as const)
  );
  return byPath.get(monsterPath) ?? [];
};

describe('跨文件重命名读脏 def 缓冲区(IDE-NAV-009)', () => {
  it('注入读口在位时用缓冲区文本:Monster 编辑区间落缓冲版位置(0 基行 3)', () => {
    const offset = resolveRenameSymbolAtOffset(HERO_DEF, HERO_DEF.indexOf('<hp>') + 1)!;
    openDirtyMonster();
    const edits = computeDefRenameEdits({
      targetFilePath: heroPath,
      targetText: HERO_DEF,
      symbol: offset,
      newName: 'vigor',
      readCrossFileContent: filePath => {
        const open = stubWorkspace.textDocuments.find(doc =>
          (doc as { uri: { fsPath: string } }).uri.fsPath === filePath) as
          { getText(): string } | undefined;
        return open ? open.getText() : fs.readFileSync(filePath, 'utf-8');
      }
    });
    const monsterEdit = edits.find(edit => edit.filePath === path.resolve(monsterPath))!;
    expect(monsterEdit, 'Monster 是 Parent=Hero 的链接文件,应被收进跨文件编辑').toBeTruthy();
    // 缓冲版 hp 名字位在 0 基第 3 行(磁盘版在第 4 行)——错用磁盘偏移即红
    expect(positionIn(monsterEdit.text, monsterEdit.edits[0].start).line).toBe(3);
    expect(monsterEdit.text, 'text 面=缓冲区当前文本').toBe(MONSTER_DEF_DIRTY);
  });

  it('provider 面跨文件编辑按 Monster 当前文本换算;未打开回落磁盘版', async () => {
    const heroDoc = makeTextDocument(HERO_DEF, { fileName: heroPath }) as never;
    const offset = resolveRenameSymbolAtOffset(HERO_DEF, HERO_DEF.indexOf('<hp>') + 1)!;
    const cursor = new Position(
      positionIn(HERO_DEF, offset.wordStart).line,
      positionIn(HERO_DEF, offset.wordStart).character);
    const provider = new KBEngineRenameProvider();

    openDirtyMonster();
    const dirtyEdit = await provider.provideRenameEdits(heroDoc, cursor, 'vigor');
    const dirtyMonsterEdits = monsterEditsFrom(dirtyEdit!);
    // 开/闭标签名各一处(<hp>+</hp>)
    expect(dirtyMonsterEdits).toHaveLength(2);
    // 缓冲版第 3 行(0 基)开标签,名字列 5 起(缩进 4+`<`)
    expect(dirtyMonsterEdits[0].range.start).toEqual(new Position(3, 5));

    // 关闭脏文档 → 回落磁盘版:第 4 行(0 基)
    stubWorkspace.textDocuments = [];
    const diskEdit = await provider.provideRenameEdits(heroDoc, cursor, 'vigor');
    const diskMonsterEdits = monsterEditsFrom(diskEdit!);
    expect(diskMonsterEdits).toHaveLength(2);
    expect(diskMonsterEdits[0].range.start).toEqual(new Position(4, 5));
  });
});
