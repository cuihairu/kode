import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeDefRenameEdits,
  DefRenameSymbol
} from '../src/defRenamer';

// defRenamer 批68 分支补测:listDefFilesRecursive 的非 .def 文件假臂、
// parseDefFileSemantics 的无名 <Interface/> 跳过臂、闭包行走 seen 去重守卫
// 的假臂(父链成环 + 共享接口各触发一次)、以及 loadSemantics 对不可读
// 后代(Ghosty.def chmod 000,经父链入队绕过外层 null 守卫)的 null 臂。
// 批96 引擎对齐:接口引用夹具改为 wrapper 形态(直取形态引擎不装载,由
// defRenamer.test.ts 的 DirectIface 负向锁覆盖)。
// `if (open)` 的开标签假臂契约性不可达,已以精确单行区间 ignore 定案,
// 理由见源码注记与 TESTING.md 批68 段。

const SOLO_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp> <Type> UINT32 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// 无名自闭合 <Interface/> 与实名 wrapper 引用并存:无名者取不到接口名跳过
// (引擎 getKey 得空串),实名者照常入闭包
const NAMELESS_DEF = [
  '<root>',
  '  <Interfaces>',
  '    <Interface/>',
  '    <Interface><SharedI/></Interface>',
  '  </Interfaces>',
  '  <Properties>',
  '    <hp> <Type> UINT8 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

// 父链成环且共享接口:闭包行走第二次命中 CycleA/SharedI 时 seen 去重
const CYCLE_A_DEF = [
  '<root>',
  '  <Parent> CycleB </Parent>',
  '  <Interfaces>',
  '    <Interface><SharedI/></Interface>',
  '  </Interfaces>',
  '</root>',
  ''
].join('\n');

// <Parent> 只有换行缩进(tinyxml 丢弃纯空白文本节点,引擎 enterNode 首子节点
// 为空 → 无父类):getReferenceTargetName 跳过空白文本后无剩余子节点,取空名
const BLANK_PARENT_DEF = [
  '<root>',
  '  <Parent>',
  '  </Parent>',
  '  <Properties>',
  '    <hp> <Type> UINT8 </Type> </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');
const CYCLE_B_DEF = [
  '<root>',
  '  <Parent> CycleA </Parent>',
  '  <Interfaces>',
  '    <Interface><SharedI/></Interface>',
  '  </Interfaces>',
  '</root>',
  ''
].join('\n');

// 两级父链通往不可读的 Ghosty.def
const MID_DEF = [
  '<root>',
  '  <Parent> Ghosty </Parent>',
  '</root>',
  ''
].join('\n');
const DISTANT_DEF = [
  '<root>',
  '  <Parent> Mid </Parent>',
  '</root>',
  ''
].join('\n');
const GHOSTY_DEF = [
  '<root>',
  '  <Parent> Nowhere </Parent>',
  '</root>',
  ''
].join('\n');

let root = '';
let soloPath = '';
let ghostyPath = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-renamer-branch-'));
  const write = (relative: string, content: string): string => {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return target;
  };

  write('scripts/entities.xml', '<root>\n  <Solo> <hasBase/> </Solo>\n</root>\n');
  soloPath = write('scripts/entity_defs/Solo.def', SOLO_DEF);
  write('scripts/entity_defs/Nameless.def', NAMELESS_DEF);
  write('scripts/entity_defs/CycleA.def', CYCLE_A_DEF);
  write('scripts/entity_defs/CycleB.def', CYCLE_B_DEF);
  write('scripts/entity_defs/BlankParent.def', BLANK_PARENT_DEF);
  write('scripts/entity_defs/Distant.def', DISTANT_DEF);
  write('scripts/entity_defs/Mid.def', MID_DEF);
  ghostyPath = write('scripts/entity_defs/Ghosty.def', GHOSTY_DEF);
  write('scripts/entity_defs/interfaces/SharedI.def', '<root>\n</root>\n');
  // 非 .def 文件混入定义树:walk 的后缀过滤假臂
  write('scripts/entity_defs/interfaces/notes.txt', 'not a def\n');
});

afterAll(() => {
  // 先恢复权限再清理,避免 rm 受限
  try {
    fs.chmodSync(ghostyPath, 0o644);
  } catch {
    // 清理尽力而为
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const hpSymbol = (): DefRenameSymbol => ({
  kind: 'property',
  name: 'hp',
  section: null,
  wordStart: 0,
  wordEnd: 2
});

describe('computeDefRenameEdits branch gaps (批68)', () => {
  it('skips non-def files, nameless interface refs and dedupes cyclic ancestors', () => {
    // 目标文件重命名照常;循环里顺带走过 Nameless/CycleA/CycleB 等条目,
    // 触发后缀过滤、无名 Interface 跳过与 seen 去重假臂
    const results = computeDefRenameEdits({
      targetFilePath: soloPath,
      targetText: SOLO_DEF,
      symbol: hpSymbol(),
      newName: 'vigor'
    });

    expect(results).toHaveLength(1);
    expect(path.basename(results[0].filePath)).toBe('Solo.def');
    expect(results[0].edits).toHaveLength(2);
    expect(results[0].text).toBe(SOLO_DEF);

    // BlankParent 的 <Parent> 只含换行缩进:跳过空白文本后无剩余子节点,
    // 取空名(与引擎 enterNode 取到空首子节点同口径),闭包不含它
    expect(computeDefRenameEdits({
      targetFilePath: path.join(root, 'scripts', 'entity_defs', 'BlankParent.def'),
      targetText: BLANK_PARENT_DEF,
      symbol: hpSymbol(),
      newName: 'vigor'
    })).toHaveLength(1);
  });

  it('survives an unreadable ancestor queued through a readable parent chain', () => {
    // Ghosty.def 不可读:外层循环按 null 内容跳过它,但 Distant→Mid→Ghosty
    // 的闭包行走把 Ghosty 从 fileIndex 入队,loadSemantics 拿到 null
    fs.chmodSync(ghostyPath, 0o000);
    try {
      const results = computeDefRenameEdits({
        targetFilePath: soloPath,
        targetText: SOLO_DEF,
        symbol: hpSymbol(),
        newName: 'vigor'
      });

      expect(results).toHaveLength(1);
      expect(path.basename(results[0].filePath)).toBe('Solo.def');
    } finally {
      fs.chmodSync(ghostyPath, 0o644);
    }
  });
});
