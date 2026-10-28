import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  formatBuiltinPropertyHover,
  formatEntityDefMethodHover,
  formatEventStatsHover,
  formatInferredReturnHover
} from '../src/hoverMarkdown';

// IDE-ARC-003 hover Markdown 格式化抽离:五处 render 位(返回类型推导/def 声明
// 方法/接收者调用/内建属性/事件统计)的字符串拼装只住 hoverMarkdown.ts——
// 纯格式化模块,不读文件、不读配置、不 import vscode;languageProviders 的
// render 位只调用本模块,既有 hover 文本逐字保持一致(用例字符串从抽取前
// 实现逐字拷贝锁定)。

const root = join(__dirname, '..');

describe('hover 文本格式化(IDE-ARC-003)', () => {
  it('def 声明方法标注:标题+签名+声明行,逐字与抽离前一致', () => {
    const text = formatEntityDefMethodHover({
      methodName: 'login',
      section: 'BaseMethods',
      signature: 'login(hp: UINT8)',
      defFile: '/ws/entities/Avatar.def',
      defLine: 4,
      exposed: false
    });
    expect(text).toBe(
      '**login** — 此函数是实体 def 声明的 BaseMethods 方法\n\n' +
      '签名: `login(hp: UINT8)`\n\n' +
      '声明: `Avatar.def:4`'
    );
  });

  it('def 声明方法标注:Exposed 位追加可远程调用说明', () => {
    const text = formatEntityDefMethodHover({
      methodName: 'login',
      section: 'BaseMethods',
      signature: 'login()',
      defFile: '/ws/entities/Avatar.def',
      defLine: 4,
      exposed: true
    });
    expect(text.endsWith('\n\n**Exposed**: 该方法可被客户端远程调用。')).toBe(true);
  });

  it('接收者调用标注:标题带接收者段,尾部与声明面同构', () => {
    const text = formatEntityDefMethodHover({
      methodName: 'fire',
      section: 'CellMethods',
      signature: 'fire()',
      defFile: '/ws/entities/Avatar.def',
      defLine: 12,
      exposed: false,
      receiver: 'cell'
    });
    expect(text).toBe(
      '**fire** — 此调用是实体 def 声明的 CellMethods 方法(接收者 self.cell)\n\n' +
      '签名: `fire()`\n\n' +
      '声明: `Avatar.def:12`'
    );
  });

  it('返回类型推导标注:目标+注解一行,来源段指方法返回注解', () => {
    expect(formatInferredReturnHover('data', 'Dict[str, int]', 'get_data')).toBe(
      '**data: Dict[str, int]**\n\n推导自 get_data() 返回注解'
    );
  });

  it('事件统计标注:注册/触发计数一行', () => {
    expect(formatEventStatsHover('ev_ready', 2, 1)).toBe(
      '**ev_ready**\n\n当前文件统计：2 处注册 · 1 处触发'
    );
  });

  it('内建属性标注:首行 headline + 引擎注册面来源段', () => {
    const text = formatBuiltinPropertyHover({
      face: 'baseapp',
      property: { name: 'databaseID', readonly: true, type: 'int', source: 'DBInterface' }
    });
    expect(text).toBe('**self.databaseID: int** — baseapp面 · 只读\n\n引擎注册面: `DBInterface`');
  });

  it('纯格式化模块:不 import vscode,不读文件,不读配置', () => {
    const source = readFileSync(join(root, 'src/hoverMarkdown.ts'), 'utf8');
    expect(source.includes("from 'vscode'"), '不得依赖 vscode').toBe(false);
    expect(source.includes('getConfiguration'), '不得读配置').toBe(false);
    expect(source.includes("from 'fs'"), '不得读文件').toBe(false);
    expect(source.includes('readFile')).toBe(false);
  });

  it('languageProviders 的 hover render 位改用格式化模块(五处调用齐,拼装文案单一家)', () => {
    const source = readFileSync(join(root, 'src/languageProviders.ts'), 'utf8');
    expect(source.includes("from './hoverMarkdown'")).toBe(true);
    // 五个 hover render 位全部走格式化模块(声明面+接收者面共用 def 方法格式化)
    const callCounts: Array<[string, number]> = [
      ['formatEntityDefMethodHover', 2],
      ['formatInferredReturnHover', 1],
      ['formatEventStatsHover', 1],
      ['formatBuiltinPropertyHover', 1]
    ];
    for (const [name, count] of callCounts) {
      expect((source.match(new RegExp(`\\b${name}\\(`, 'g')) ?? []).length, `${name} 调用面应有 ${count} 处`).toBe(count);
    }
    // hover 独有文案已全部迁走(补全/签名帮助文档面的同词句不属本抽取范围)
    for (const literal of ['推导自 ', '当前文件统计']) {
      expect(source.includes(literal), `hover render 位仍内联拼装「${literal}」`).toBe(false);
    }
    const home = readFileSync(join(root, 'src/hoverMarkdown.ts'), 'utf8');
    for (const literal of ['此函数是实体 def 声明的', '此调用是实体 def 声明的', '推导自', '当前文件统计', '引擎注册面']) {
      expect(home.includes(literal), `格式化模块应拥有「${literal}」`).toBe(true);
    }
  });
});
