// KODE-I18N-001/003:manifest 国际化契约(用户令 2026-11-06)。
// package.nls.json(默认英文包)+ package.nls.zh-cn.json(中文包):
// ①contributes 全量标题/描述走 %key% 占位 —— 命令 title、配置 markdownDescription、
//   markdownEnumDescriptions(含 items 层)、视图 name(视图已有 categoryI18n 锁,不重复);
// ②两语言文件 key 全等、值非空;
// ③manifest 里每个 %key% 引用与语言包键同名同数:恰好一引用一键,无死键、无缺键;
// ④{N} 占位符同名同数(package.nls 无参数替换机制,出现即须两包一致);
// ⑤缺 key 回退:locale 包缺键时回落默认包(VS Code 实际行为),测试以合成删键断言;
// ⑥命令标题真翻译:zh-cn 与默认包逐键不同文(同文=假翻译,一律红)。
// 分类标签(configuration.title 等)专有名词(如 KBEngine)允许保留字面量,不入占位。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');

const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  contributes: {
    commands: Array<{ command: string; title: string }>;
    viewsContainers?: Record<string, Array<{ id: string; title: string }>>;
    views?: Record<string, Array<{ id: string; name: string }>>;
    configuration: { properties: Record<string, ConfigProperty> };
  };
};

interface ConfigProperty {
  markdownDescription?: string;
  markdownEnumDescriptions?: string[];
  items?: { markdownEnumDescriptions?: string[] };
}

const nlsDefault = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.nls.json'), 'utf8')) as Record<string, string>;
const nlsZhCn = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.nls.zh-cn.json'), 'utf8')) as Record<string, string>;

const NLS_TOKEN = /^%([^%]+)%$/;

const commands = manifest.contributes.commands;
const properties = manifest.contributes.configuration.properties;

/** 全量收集 %key% 引用:直接扫 package.json 原文,覆盖任意嵌套路径
 * (displayName/description、命令、视图、配置含 items.properties 字段说明) */
const collectManifestRefs = (): string[] => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  return [...raw.matchAll(/%([a-zA-Z0-9._-]+)%/g)].map(m => m[1]);
};

/** 递归校验配置子树无残留裸描述(description/markdownDescription 字面量) */
const collectBareNestedDescriptions = (): string[] => {
  const bare: string[] = [];
  const walk = (node: unknown, pathStr: string): void => {
    if (!node || typeof node !== 'object') return;
    for (const [field, value] of Object.entries(node as Record<string, unknown>)) {
      if ((field === 'description' || field === 'markdownDescription') && typeof value === 'string' && !NLS_TOKEN.test(value)) {
        bare.push(`${pathStr}.${field}=${value.slice(0, 40)}`);
      } else if (value && typeof value === 'object') {
        walk(value, `${pathStr}.${field}`);
      }
    }
  };
  for (const [propKey, prop] of Object.entries(properties)) {
    walk(prop, propKey);
  }
  return bare;
};

describe('manifest 全量 nls 占位(KODE-I18N-001)', () => {
  it('every command title is a %key% nls reference', () => {
    const literals = commands
      .filter(cmd => !NLS_TOKEN.test(cmd.title))
      .map(cmd => `${cmd.command}: ${cmd.title}`);
    expect(literals).toEqual([]);
  });

  it('every configuration markdownDescription is a %key% nls reference', () => {
    const literals = Object.entries(properties)
      .filter(([, prop]) => !NLS_TOKEN.test(prop.markdownDescription ?? ''))
      .map(([key]) => key);
    expect(literals).toEqual([]);
  });

  it('every markdownEnumDescriptions item (prop-level and items-level) is a %key% nls reference', () => {
    const literals: string[] = [];
    for (const [propKey, prop] of Object.entries(properties)) {
      (prop.markdownEnumDescriptions ?? []).forEach((doc, i) => {
        if (!NLS_TOKEN.test(doc)) {
          literals.push(`${propKey}[${i}]`);
        }
      });
      (prop.items?.markdownEnumDescriptions ?? []).forEach((doc, i) => {
        if (!NLS_TOKEN.test(doc)) {
          literals.push(`${propKey}.items[${i}]`);
        }
      });
    }
    expect(literals).toEqual([]);
  });
  it('configuration 子树无残留裸描述(含嵌套 items.properties 字段说明)', () => {
    expect(collectBareNestedDescriptions()).toEqual([]);
  });

  it('displayName 与 description 走 %key% nls 占位', () => {
    const pkg = manifest as unknown as { displayName: string; description: string };
    expect(pkg.displayName).toMatch(NLS_TOKEN);
    expect(pkg.description).toMatch(NLS_TOKEN);
  });
});

describe('两语言包一致性(KODE-I18N-003)', () => {
  it('en 与 zh-cn 键集全等且值非空', () => {
    expect(Object.keys(nlsZhCn).sort()).toEqual(Object.keys(nlsDefault).sort());
    expect(Object.keys(nlsDefault).length).toBeGreaterThanOrEqual(230);
    for (const [key, value] of Object.entries(nlsDefault)) {
      expect(value, `默认包空值: ${key}`).toBeTruthy();
    }
    for (const [key, value] of Object.entries(nlsZhCn)) {
      expect(value, `zh-cn 空值: ${key}`).toBeTruthy();
    }
  });

  it('manifest %key% 引用与语言包键同名同数:一键一引用,无死键无缺键', () => {
    const refs = collectManifestRefs();
    const refCounts = new Map<string, number>();
    for (const ref of refs) {
      refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
    }
    const enKeys = Object.keys(nlsDefault).sort();
    const zhKeys = Object.keys(nlsZhCn).sort();
    expect(zhKeys).toEqual(enKeys);
    expect([...refCounts.keys()].sort()).toEqual(enKeys);
    const drifted = [...refCounts.entries()].filter(([, n]) => n !== 1);
    expect(drifted).toEqual([]);
  });

  it('{N} 占位符逐键同名同数(两包一致)', () => {
    const tokensOf = (value: string): string[] => value.match(/\{\d+\}/g) ?? [];
    const drifted: string[] = [];
    for (const key of Object.keys(nlsDefault)) {
      const en = tokensOf(nlsDefault[key]).sort();
      const zh = tokensOf(nlsZhCn[key] ?? '').sort();
      if (JSON.stringify(en) !== JSON.stringify(zh)) {
        drifted.push(`${key}: en=${JSON.stringify(en)} zh=${JSON.stringify(zh)}`);
      }
    }
    expect(drifted).toEqual([]);
  });

  it('locale 包缺 key 回落默认包(模拟 VS Code 回退语义:locale 缺键取默认包)', () => {
    // VS Code 对 package.json %key% 的回退:locale 包缺键时用默认包文案。
    // 单测无法起真机 locale 解析,这里按同一语义建模,断言到值级(不是只断言"不是占位符")。
    const resolve = (value: string, locale: Record<string, string>): string =>
      value.replace(NLS_TOKEN, (_m, key: string) => locale[key] ?? nlsDefault[key] ?? key);

    // 合成删键:zh-cn 包缺键时解析结果必须逐字等于默认包文案
    const victim = 'kbengine.view.quickActions';
    const zhMissing = { ...nlsZhCn };
    delete zhMissing[victim];
    expect(resolve('%kbengine.view.quickActions%', zhMissing)).toBe(nlsDefault[victim]);

    // 键在两包都不存在:落裸 key(退化路径,显式锁定该行为)
    expect(resolve('%kbengine.synthetic.missing%', {})).toBe('kbengine.synthetic.missing');

    // 真实键:两包解析结果都等于各自包内文案(不落裸 key、不误回默认)
    for (const cmd of commands) {
      const match = NLS_TOKEN.exec(cmd.title);
      if (!match) {
        continue;
      }
      const key = match[1];
      expect(resolve(cmd.title, nlsDefault)).toBe(nlsDefault[key]);
      expect(resolve(cmd.title, nlsZhCn)).toBe(nlsZhCn[key]);
    }
  });

  it('命令标题真翻译:zh-cn 逐键与默认包不同文(同文=假翻译)', () => {
    const sameText: string[] = [];
    for (const cmd of commands) {
      const match = NLS_TOKEN.exec(cmd.title);
      if (!match) {
        continue;
      }
      const key = match[1];
      if (nlsDefault[key] === nlsZhCn[key]) {
        sameText.push(key);
      }
    }
    expect(sameText).toEqual([]);
  });
});
