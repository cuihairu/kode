// KODE-CFG-016 ①意外写检测:配置数据(Excel 生成的 py 配置类/dict)字段在
// 非「热更新接口 ∪ mutationExclude 白名单」处的全部写点 → 诊断
// kbengine.configDataMutation。纯逻辑层单测——computeConfigDataMutationFindings
// 不 import vscode,源码文本全部注入。
//
// 验收(todo 原文口径):
//   - 配置字段在非重载处写 → 诊断;
//   - 在 reload* / hotUpdate* 函数内写 → 不报;
//   - mutationExclude 内写 → 不报;
//   - 三种写形态(属性 / 下标 / 变异方法)测试绿;另覆盖 del、增强赋值、
//     from-import 别名、字符串/注释掩码、开关关闭零产出、干净工作区零产出。

import { describe, expect, it } from 'vitest';
import {
  computeConfigDataMutationFindings,
  collectConfigSchema,
  CONFIG_DATA_SETTINGS_DEFAULT,
  type ConfigDataSettings,
  type ConfigSourceInput
} from '../src/configDataMutation';

/** 配置源:Excel 生成面(scriptsd/data/config/items.py)——dict 表 + 类 */
const itemsPy = `# generated from excel, do not edit
ITEMS = {
    1: {'name': 'sword', 'hp': 10},
    2: {'name': 'shield', 'hp': 20},
}

class ItemsConfig:
    maxHp: int = 100
    name: str = 'items'
`;

/** 消费面:业务脚本里意外改配置 */
const avatarPy = `from data.config.items import ITEMS, ItemsConfig

def onTick(timerID):
    ITEMS[1]['hp'] = 999
    ItemsConfig.maxHp = 50

def reloadItems():
    ITEMS[1]['hp'] = 999

def hotUpdateItems():
    ITEMS[2]['name'] = 'sword2'
`;

const src = (file: string, text: string): ConfigSourceInput => ({ file, text });

const settings = (overrides: Partial<ConfigDataSettings> = {}): ConfigDataSettings => ({
  ...CONFIG_DATA_SETTINGS_DEFAULT,
  ...overrides
});

describe('computeConfigDataMutationFindings(①意外写检测)', () => {
  it('非重载处属性写下标写 → 诊断(三种形态之一/之二)', () => {
    const findings = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', itemsPy), src('scripts/avatar.py', avatarPy)],
      settings()
    );
    const attr = findings.find(f => f.file === 'scripts/avatar.py' && f.line === 3);
    expect(attr).toBeDefined();
    expect(attr!.baseName).toBe('ITEMS');
    expect(attr!.code).toBe('kbengine.configDataMutation');

    const classAttr = findings.find(f => f.file === 'scripts/avatar.py' && f.line === 4);
    expect(classAttr).toBeDefined();
    expect(classAttr!.baseName).toBe('ItemsConfig');
  });

  it('reload* / hotUpdate* 函数内写 → 不报', () => {
    const findings = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', itemsPy), src('scripts/avatar.py', avatarPy)],
      settings()
    );
    // avatar.py 行 3/4 是 onTick 内(报);行 7(reloadItems 内)与行 10(hotUpdateItems 内)不报
    expect(findings.filter(f => f.file === 'scripts/avatar.py').map(f => f.line).sort())
      .toEqual([3, 4]);
  });

  it('mutationExclude 白名单内写 → 不报', () => {
    const findings = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', itemsPy), src('scripts/avatar.py', avatarPy)],
      settings({ mutationExclude: ['scripts/avatar.py'] })
    );
    expect(findings.filter(f => f.file === 'scripts/avatar.py')).toEqual([]);
  });

  it('变异方法形态(append/pop/update/...) → 诊断', () => {
    const text = `from data.config.items import ITEMS

def onTick(timerID):
    ITEMS.append(3)
    ITEMS[1].pop()
    ITEMS[1].update({'hp': 1})
    ITEMS[1]['tags'].clear()
`;
    const findings = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', itemsPy), src('scripts/avatar.py', text)],
      settings()
    );
    expect(findings.filter(f => f.form === 'mutator').map(f => f.line).sort())
      .toEqual([3, 4, 5, 6]);
  });

  it('del 与增强赋值形态 → 诊断', () => {
    const text = `from data.config.items import ITEMS

def onTick(timerID):
    del ITEMS[1]
    del ITEMS[1]['hp']
    ITEMS[1]['hp'] += 5
`;
    const forms = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', itemsPy), src('scripts/avatar.py', text)],
      settings()
    );
    expect(forms.filter(f => f.form === 'delete').map(f => f.line).sort()).toEqual([3, 4]);
    expect(forms.filter(f => f.form === 'augmented').map(f => f.line)).toEqual([5]);
  });

  it('from-import 别名与同名局部定义不误报;配置文件自身定义不报', () => {
    const text = `from data.config.items import ITEMS as CFG

CFG[1] = {}

def onTick(timerID):
    CFG[1] = {}

ITEMS = {}
ITEMS[1] = {}
`;
    const findings = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', itemsPy), src('scripts/avatar.py', text)],
      settings()
    );
    // 行 2(模块级写,报)、行 5(函数内,报);行 8 是本地 ITEMS 定义语句本身
    // (definition 行不报),行 9 的 ITEMS 是本地新绑定(非配置导入)不报
    expect(findings.filter(f => f.file === 'scripts/avatar.py').map(f => f.line).sort())
      .toEqual([2, 5]);
  });

  it('定义语句与配置类类体默认值不报', () => {
    // items.py 自身:模块级 ITEMS = {...} 与类体 maxHp: int = 100 都是定义
    const findings = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', itemsPy)],
      settings()
    );
    expect(findings).toEqual([]);
  });

  it('注释与字符串里的写点形态不报(掩码)', () => {
    const text = `from data.config.items import ITEMS

def onTick(timerID):
    # ITEMS[1] = 2
    s = "ITEMS[1] = 2"
    log(ITEMS)
`;
    const findings = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', itemsPy), src('scripts/avatar.py', text)],
      settings()
    );
    expect(findings).toEqual([]);
  });

  it('读形态(索引/遍历/print)不报', () => {
    const text = `from data.config.items import ITEMS

def onTick(timerID):
    hp = ITEMS[1]['hp']
    for row in ITEMS.values():
        print(row['name'])
    log(ITEMS)
`;
    const findings = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', itemsPy), src('scripts/avatar.py', text)],
      settings()
    );
    expect(findings).toEqual([]);
  });

  it('开关关闭 → 零产出;干净工作区 → 零产出', () => {
    const sources = [src('scripts/data/config/items.py', itemsPy), src('scripts/avatar.py', avatarPy)];
    expect(computeConfigDataMutationFindings(sources, settings({ enabled: false }))).toEqual([]);
    expect(computeConfigDataMutationFindings(
      [src('scripts/entity.py', 'def onTick(timerID):\n    log(1)\n')],
      settings()
    )).toEqual([]);
  });

  it('配置文件自身:模块级再写点与函数内写点 → 诊断(评审二轮 P1 回归)', () => {
    const selfMutation = `${itemsPy}
ITEMS[3] = {'name': 'x', 'hp': 1}

def applyPatch():
    ITEMS[1]['hp'] = 999
`;
    const findings = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', selfMutation)],
      settings()
    );
    // 定义语句(ITEMS = { 与类体默认值)不报;其后模块级再写(行 10)与
    // 函数内写(行 13)都报
    expect(findings.map(f => f.line).sort()).toEqual([10, 13]);
  });

  it('同一行先读后写 → 诊断(评审二轮 P1 回归;首出现非写点不吞后续写点)', () => {
    const text = `from data.config.items import ITEMS

def onTick(timerID):
    log(ITEMS); ITEMS[1]['hp'] = 5
`;
    const findings = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', itemsPy), src('scripts/avatar.py', text)],
      settings()
    );
    expect(findings.map(f => f.line)).toEqual([3]);
  });

  it('缩进行写点:诊断列对齐原始行内 base 名首字符(评审二轮/三轮 P2 回归)', () => {
    const text = `from data.config.items import ITEMS

def onTick(timerID):
    if True:
        ITEMS[1]['hp'] = 5
`;
    const findings = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', itemsPy), src('scripts/avatar.py', text)],
      settings()
    );
    expect(findings).toHaveLength(1);
    const line = text.split('\n')[4];
    expect(findings[0].character).toBe(line.indexOf('ITEMS'));
    expect(line.charAt(findings[0].character)).toBe('I');
  });

  it('Tab/混缩进行写点:列按字符偏移(评审三轮 P2 回归;Tab 计 1 列非 8 列)', () => {
    const text = `from data.config.items import ITEMS

def onTick(timerID):
\tITEMS[1]['hp'] = 5
 \tITEMS[2]['hp'] = 6
`;
    const findings = computeConfigDataMutationFindings(
      [src('scripts/data/config/items.py', itemsPy), src('scripts/avatar.py', text)],
      settings()
    );
    const lines = text.split('\n');
    expect(findings.map(f => f.line)).toEqual([3, 4]);
    expect(findings[0].character).toBe(lines[3].indexOf('ITEMS'));
    expect(lines[3].charAt(findings[0].character)).toBe('I');
    expect(findings[1].character).toBe(lines[4].indexOf('ITEMS'));
    expect(lines[4].charAt(findings[1].character)).toBe('I');
  });
});

describe('collectConfigSchema(②强类型 stub 直读)', () => {
  it('dict 字面量表:key/value 类型直读出类型文本', () => {
    const schema = collectConfigSchema(
      [src('scripts/data/config/items.py', itemsPy)],
      settings()
    );
    const items = schema.find(e => e.name === 'ITEMS');
    expect(items).toBeDefined();
    expect(items!.kind).toBe('binding');
    expect(items!.typeText).toBe("dict[int, dict[str, str | int]]");
  });

  it('配置类注解字段 → 类型化成员', () => {
    const schema = collectConfigSchema(
      [src('scripts/data/config/items.py', itemsPy)],
      settings()
    );
    const cls = schema.find(e => e.name === 'ItemsConfig');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
  });
});
