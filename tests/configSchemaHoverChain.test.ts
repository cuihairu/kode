// CFG-HOVER-FIX-002 provider 命中面放宽+空 schema 引导(接线面):
//   - 成员链 hover:`Config.MOBILES[0].hp`/`TABLE['k']['hp']` 悬停成员出直读类型
//   - 模块级别名一跳(`TBL = MOBILES` 后 `TBL[0].hp`)
//   - 容器方法名零产出(不与其他 hover 面抢位)
//   - 空 schema notice:开关开+零条目+词形似配置类才出,引导 dirGlobs/classPatterns
// 位置全部 indexOf 定位(手数列号两次翻车判例后的固定写法)。
import { describe, expect, it } from 'vitest';
import { ConfigSchemaHoverProvider } from '../src/configSchemaHover';
import {
  collectConfigSchema,
  CONFIG_DATA_SETTINGS_DEFAULT,
  type ConfigDataSettings,
  type ConfigSchemaEntry
} from '../src/configDataMutation';
import { makeTextDocument } from './fake-vscode/core';
import type * as vscode from 'vscode';

const CFG_PY = `MOBILES = [{'id': 1, 'hp': 100}]

TABLE = {'warrior': {'hp': 100}, 'mage': {'hp': 80}}
`;

const schema = collectConfigSchema(
  [{ file: 'scripts/config/Config.py', text: CFG_PY }],
  CONFIG_DATA_SETTINGS_DEFAULT
);

const settings = (overrides: Partial<ConfigDataSettings> = {}): ConfigDataSettings => ({
  ...CONFIG_DATA_SETTINGS_DEFAULT,
  ...overrides
});

describe('ConfigSchemaHoverProvider 成员链与空 schema 引导(CFG-HOVER-FIX-002)', () => {
  const hoverOn = (
    source: string,
    word: string,
    entries: readonly ConfigSchemaEntry[] = schema,
    getSettings: () => ConfigDataSettings = () => settings()
  ): string | undefined => {
    const doc = makeTextDocument(source, { fileName: '/proj/scripts/avatar.py', languageId: 'python' }) as unknown as vscode.TextDocument;
    // 词在 hover 源码中的第 0 次出现(词首列)
    const idx = source.indexOf(word);
    const line = source.slice(0, idx).split('\n').length - 1;
    const character = idx - (source.lastIndexOf('\n', idx - 1) + 1);
    const provider = new ConfigSchemaHoverProvider(() => entries, getSettings);
    const hover = provider.provideHover(doc, { line, character } as vscode.Position);
    if (!hover) {
      return undefined;
    }
    const raw = hover.contents;
    const parts = Array.isArray(raw) ? raw : [raw];
    return parts.map(p => typeof p === 'string' ? p : p.value).join('\n');
  };

  it('模块根链:Config.MOBILES[0].hp 悬停 hp → 链成员直读类型+源条目位置', () => {
    const text = hoverOn('def onTick(tid):\n    v = Config.MOBILES[0].hp\n', 'hp');
    expect(text).toContain('Config');
    expect(text).toContain('hp');
    expect(text).toContain('int');
    expect(text).toContain('scripts/config/Config.py');
  });

  it('dict 键悬停:TABLE["warrior"]["hp"] 悬停 hp 键 → 值类型', () => {
    const text = hoverOn('def onTick(tid):\n    v = TABLE["warrior"]["hp"]\n', 'hp');
    expect(text).toContain('TABLE');
    expect(text).toContain('int');
  });

  it('模块级别名一跳:TBL = MOBILES 后 TBL[0].hp 照出', () => {
    const text = hoverOn('TBL = MOBILES\n\n\ndef onTick(tid):\n    v = TBL[0].hp\n', 'hp');
    expect(text).toContain('MOBILES');
    expect(text).toContain('scripts/config/Config.py');
  });

  it('容器方法名零产出:MOBILES[0].get 不假命中', () => {
    expect(hoverOn('def onTick(tid):\n    v = MOBILES[0].get\n', 'get')).toBeUndefined();
  });

  it('空 schema 引导:开关开+零条目+词形似配置类 → notice 带当前 globs/patterns;其余词零噪声', () => {
    const text = hoverOn('cfg = HeroConfig()\n', 'HeroConfig', [], () => settings());
    expect(text).toContain('schema 为空');
    expect(text).toContain('kbengine.configData.dirGlobs');
    expect(text).toContain('scripts/config/**');
    expect(text).toContain('kbengine.configData.classPatterns');
    // 词不匹配类名模式:零产出(不逐词骚扰)
    expect(hoverOn('x = hero\n', 'hero', [], () => settings())).toBeUndefined();
    // 开关关:零产出
    expect(hoverOn('cfg = HeroConfig()\n', 'HeroConfig', [], () => settings({ enabled: false }))).toBeUndefined();
    // schema 非空:notice 面关闭
    expect(hoverOn('def onTick(tid):\n    log(plain)\n', 'plain')).toBeUndefined();
  });
});
