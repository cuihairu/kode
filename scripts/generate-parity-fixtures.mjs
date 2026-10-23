#!/usr/bin/env node
// PH0-02 parity fixture 生成器(docs/kode2/ph0-gate.md 门 2:正确性 fixture)。
//
// 用法:
//   node scripts/generate-parity-fixtures.mjs            # 生成/重写 parity 项目
//   node scripts/generate-parity-fixtures.mjs --check    # 只校验内容一致(CI 防漂移)
//
// 设计(docs/kode2/legacy-todo-audit.md §AUDIT-014 / docs/kode2/ph0-gate.md):
//   确定性小资产树(hover/definition/completion/diagnostics 四主请求的
//   golden 输入),风格与 scripts/generate-perf-assets.mjs 的 small 场景一致,
//   输出目录已存在时先删后建,同参数重复生成结果逐字节一致。
//   golden 输出由 tests/parityGolden.test.ts 对真实 provider 采集:
//   KODE_PARITY_UPDATE=1 npx vitest run tests/parityGolden.test.ts
//
// 覆盖面:实体继承(Monster→Avatar)、组件(Inventory)、同名实体无、
// Base/Cell 分面方法、Exposed、<Arg> 形参闸、types.xml/alias.xml 自定义类型、
// Python 类跨文件定义跳转、self. 属性/方法补全、.def Type 补全、
// 未知 Flags 诊断、entities.xml 重复条目诊断。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const projectRoot = path.resolve(path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'tests',
  'fixtures',
  'parity-project'
));

const FILES = new Map([
  ['scripts/entities.xml', [
    '<root>',
    '  <Avatar config="kbengine_avatar_defaults"/>',
    '  <Monster config="kbengine_monster_defaults"/>',
    '</root>',
    ''
  ].join('\n')],

  ['scripts/types.xml', [
    '<root>',
    '  <JSONDATA type="UINT32"/>',
    '  <PARITY_ID type="UINT32"/>',
    '</root>',
    ''
  ].join('\n')],

  ['scripts/entity_defs/alias.xml', [
    '<root>',
    '  <PARITY_LIST type="ARRAY" of="UINT32"/>',
    '</root>',
    ''
  ].join('\n')],

  ['scripts/entity_defs/Avatar.def', [
    '<root>',
    '  <Components>',
    '    <inventory>',
    '      <Type>Inventory</Type>',
    '    </inventory>',
    '  </Components>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE_AND_CLIENT</Flags>',
    '      <Default>100</Default>',
    '    </hp>',
    '    <bag>',
    '      <Type>',
    '        ARRAY',
    '        <of>UINT32</of>',
    '      </Type>',
    '      <Flags>CELL_PUBLIC</Flags>',
    '    </bag>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <onRpc>',
    '      <Arg>UINT32</Arg>',
    '      <Exposed/>',
    '    </onRpc>',
    '    <doAttack>',
    '      <Arg>UINT32</Arg>',
    '    </doAttack>',
    '  </BaseMethods>',
    '  <CellMethods>',
    '    <onCellRpc>',
    '      <Arg>UINT32</Arg>',
    '      <Exposed/>',
    '    </onCellRpc>',
    '  </CellMethods>',
    '</root>',
    ''
  ].join('\n')],

  ['scripts/entity_defs/Monster.def', [
    '<root>',
    '  <Parent>Avatar</Parent>',
    '  <Properties>',
    '    <ferocity>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '    </ferocity>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <onSpawned>',
    '      <Arg>UINT32</Arg>',
    '    </onSpawned>',
    '  </BaseMethods>',
    '</root>',
    ''
  ].join('\n')],

  ['scripts/entity_defs/components/Inventory.def', [
    '<root>',
    '  <Properties>',
    '    <slots>',
    '      <Type>UINT16</Type>',
    '      <Flags>BASE</Flags>',
    '    </slots>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <add>',
    '      <Arg>UINT32</Arg>',
    '    </add>',
    '    <onSlotsChanged>',
    '      <Exposed/>',
    '    </onSlotsChanged>',
    '  </BaseMethods>',
    '</root>',
    ''
  ].join('\n')],

  ['scripts/base/Avatar.py', [
    'from scripts.common.Inventory import Inventory',
    '',
    '',
    'class Avatar:',
    '',
    '    def __init__(self):',
    '        self.hp = 100',
    '        self.bag = []',
    '        self.inventory = Inventory()',
    '',
    '    def onRpc(self, argOne):',
    '        self.base.onRpc(argOne)',
    '',
    '    def doAttack(self, targetId):',
    '        self.cell.onCellRpc(targetId)',
    '        self.',
    '',
    '    def give(self, itemId):',
    '        self.inventory.add(itemId)',
    '        print(self.databaseID)',
    ''
  ].join('\n')],

  ['scripts/cell/Monster.py', [
    'from scripts.base.Avatar import Avatar',
    '',
    '',
    'class Monster(Avatar):',
    '',
    '    def onSpawned(self, spawnAt):',
    '        self.ferocity = 3',
    ''
  ].join('\n')],

  ['scripts/common/Inventory.py', [
    'class Inventory:',
    '',
    '    def add(self, itemId):',
    '        self.slots = self.slots + 1',
    '',
    '    def count(self, itemId):',
    '        return itemId',
    ''
  ].join('\n')]
]);

function fileSha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12);
}

function main() {
  const report = [];
  let drifted = false;
  for (const [relative, content] of FILES) {
    const target = path.join(projectRoot, relative);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (existing === content) {
      report.push(`ok       ${relative} (${fileSha256(content)})`);
      continue;
    }
    drifted = true;
    if (checkOnly) {
      report.push(`DRIFT    ${relative}`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    report.push(`written  ${relative} (${fileSha256(content)})`);
  }
  if (!checkOnly) {
    // 项目目录只承载生成物;逐字节核对无多余文件
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          const relative = path.relative(projectRoot, full).split(path.sep).join('/');
          if (!FILES.has(relative)) report.push(`EXTRA    ${relative}(未在生成清单中,请人工确认)`);
        }
      }
    };
    if (fs.existsSync(projectRoot)) walk(projectRoot);
  }
  console.log(report.join('\n'));
  if (checkOnly && drifted) {
    console.error('parity fixture 与生成器不一致:运行 node scripts/generate-parity-fixtures.mjs 后复查 golden');
    process.exit(1);
  }
}

main();
