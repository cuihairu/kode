import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DETAIL_LEVELS, KBENGINE_FLAGS, KBENGINE_TYPES } from '../src/kbengineMetadata';
import { DefElementNode, getDirectChildElement, getElementText, parseDefDocument } from '../src/defParser';
import { expandSnippetBody } from './helpers/snippetExpansion';

interface SnippetEntry {
  prefix: string;
  description: string;
  body: string[];
}

const snippetsDir = path.resolve(__dirname, '..', 'snippets');
const defSnippets: Record<string, SnippetEntry> = JSON.parse(
  fs.readFileSync(path.join(snippetsDir, 'kbengine.json'), 'utf8')
);
const typesXmlSnippets: Record<string, SnippetEntry> = JSON.parse(
  fs.readFileSync(path.join(snippetsDir, 'kbengine-types-xml.json'), 'utf8')
);

const typeNames = new Set(KBENGINE_TYPES.map(item => item.name));
const flagNames = new Set(KBENGINE_FLAGS.map(item => item.name));

function firstRootElement(text: string): DefElementNode {
  const document = parseDefDocument(text);
  const root = document.root;
  expect(root, text).not.toBeNull();
  return root!;
}

function parsePlaceholderChoices(text: string): string[][] {
  return [...text.matchAll(/\$\{\d+\|([^|]+)\|\}/g)].map(match => match[1].split(','));
}

const ALL_SNIPPETS: Record<string, SnippetEntry> = { ...defSnippets, ...typesXmlSnippets };

describe('def snippets (kbengine.json)', () => {
  it('declares unique kbe-* prefixes with non-empty bodies', () => {
    const prefixes = Object.values(defSnippets).map(entry => entry.prefix);

    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const [title, entry] of Object.entries(defSnippets)) {
      expect(entry.prefix, title).toMatch(/^kbe-/);
      expect(entry.description.length, entry.prefix).toBeGreaterThan(0);
      expect(entry.body.length, entry.prefix).toBeGreaterThan(0);
    }
  });

  it('never offers engine-unregistered types as choices', () => {
    // 只校验类型选择行(<Type>/<Arg>/<of>),Flags 行的选择项由 flagNames 校验。
    for (const [title, entry] of Object.entries(ALL_SNIPPETS)) {
      for (const line of entry.body) {
        if (!/<(Type|Arg|of)>/.test(line)) {
          continue;
        }
        for (const choices of parsePlaceholderChoices(line)) {
          for (const choice of choices) {
            expect(
              typeNames.has(choice),
              `${title} offers ${choice}, which is not registered by the engine`
            ).toBe(true);
          }
        }
      }
    }
  });

  it('never offers unknown flags as choices', () => {
    for (const [title, entry] of Object.entries(ALL_SNIPPETS)) {
      for (const line of entry.body) {
        if (!/<Flags>/.test(line)) {
          continue;
        }
        for (const choices of parsePlaceholderChoices(line)) {
          for (const choice of choices) {
            expect(
              flagNames.has(choice),
              `${title} offers flag ${choice}, which the engine does not define`
            ).toBe(true);
          }
        }
      }
    }
  });

  it('expands kbe-prop into a parseable def property', () => {
    const entry = defSnippets['KBEngine Property Basic'];
    expect(entry).toBeDefined();

    const property = firstRootElement(expandSnippetBody(entry.body));
    expect(property.name).toBe('PropertyName');
    expect(getElementText(getDirectChildElement(property, 'Type')!).trim()).toBe('UINT8');
    expect(getElementText(getDirectChildElement(property, 'Flags')!).trim()).toBe('BASE_AND_CLIENT');
    expect(getElementText(getDirectChildElement(property, 'Default')!).trim()).toBe('0');
  });

  it('expands kbe-array into engine ARRAY/<of> syntax', () => {
    const expanded = expandSnippetBody(defSnippets['KBEngine Array Property'].body);
    const property = firstRootElement(expanded);
    const typeNode = getDirectChildElement(property, 'Type')!;

    expect(getElementText(typeNode).trim()).toBe('ARRAY');
    // FixedArrayType::initialize 强制读取 <of> 子节点;禁止引擎不解析的内联 ARRAY<x> 写法
    expect(expanded).not.toMatch(/ARRAY\s*<(?!of[ >])/);
    expect(getElementText(getDirectChildElement(typeNode, 'of')!).trim()).toBe('UINT8');
  });

  it('offers fixed-dict only as a types.xml alias snippet, never inline in defs', () => {
    const prefixes = Object.values(defSnippets).map(entry => entry.prefix);

    expect(prefixes).not.toContain('kbe-fixed-dict');
    expect(prefixes).not.toContain('kbe-tuple');

    const fixedDict = typesXmlSnippets['KBEngine FIXED_DICT Type Alias'];
    expect(fixedDict).toBeDefined();

    const alias = firstRootElement(expandSnippetBody(fixedDict.body));
    const fixedDictNode = getDirectChildElement(alias, 'FIXED_DICT');
    expect(fixedDictNode).toBeDefined();
    expect(getDirectChildElement(fixedDictNode!, 'Properties')).toBeDefined();

    const arrayAlias = firstRootElement(expandSnippetBody(typesXmlSnippets['KBEngine ARRAY Type Alias'].body));
    const arrayNode = getDirectChildElement(arrayAlias, 'ARRAY');
    expect(arrayNode).toBeDefined();
    expect(getElementText(getDirectChildElement(arrayNode!, 'of')!).trim()).toBe('UINT8');
  });

  it('expands kbe-prop-detail with aligned detail levels', () => {
    const body = defSnippets['KBEngine Property with DetailLevel'].body.join('\n');

    for (const choices of parsePlaceholderChoices(body)) {
      for (const choice of choices) {
        if (DETAIL_LEVELS.includes(choice)) {
          expect(DETAIL_LEVELS).toContain(choice);
        } else {
          expect(typeNames.has(choice), choice).toBe(true);
        }
      }
    }

    const property = firstRootElement(expandSnippetBody(defSnippets['KBEngine Property with DetailLevel'].body));
    expect(getElementText(getDirectChildElement(property, 'DetailLevel')!).trim()).toBe('NEAR');
  });

  it('references real reload entry points in hot-reload snippets', () => {
    const allBodies = Object.values(defSnippets).map(entry => entry.body.join('\n')).join('\n');

    expect(allBodies).toContain('KBEngine.reloadScript');
    expect(allBodies).toContain('importlib.reload');
    // 已被源码审计剔除的虚构回调不得在示例代码中出现
    expect(allBodies).not.toContain('onCreate');
  });
});

describe('types.xml snippets (kbengine-types-xml.json)', () => {
  it('declares xml-language snippets with kbe-* prefixes', () => {
    expect(Object.keys(typesXmlSnippets).length).toBeGreaterThanOrEqual(2);
    for (const [title, entry] of Object.entries(typesXmlSnippets)) {
      expect(entry.prefix, title).toMatch(/^kbe-/);
      expect(entry.description, title).toContain('types.xml');
    }
  });
});
