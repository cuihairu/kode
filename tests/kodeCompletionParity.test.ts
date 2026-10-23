// kode2 PR-011 对拍门禁:用 TS 现有 defParser/defChain 原语复算 Rust 侧生成的
// completion golden(crates/kode-server/tests/golden/completion-parity.json),
// 逐文件逐场景比对(判面上下文 + 六面条目集;本文件只读 fixture 与 golden,
// 不改 src/,对拍语义 = 双实现同输入同补全面)。
// 与 kodeHoverParity/kodeIndexParity 同构。切流不在本单:TS provider 链路原样。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DefElementNode,
  getDirectChildElement,
  getDirectChildElements,
  getElementText,
  isElementNode,
  parseDefDocument
} from '../src/defParser';
import { buildDefChain } from '../src/defChain';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/completion-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;

// ---- 语料收集(与 Rust collect_corpus 同序:排序遍历,rel 路径字典序) ----

interface CorpusFile {
  file: string;
  kind: 'def' | 'entities' | 'types' | 'alias';
  text: string;
}

const collectCorpus = (): CorpusFile[] => {
  const out: CorpusFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childPath = path.join(dir, entry.name);
      const relChild = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childPath, relChild);
        continue;
      }
      const kind = entry.name.endsWith('.def')
        ? 'def'
        : entry.name === 'entities.xml'
          ? 'entities'
          : entry.name === 'types.xml'
            ? 'types'
            : entry.name === 'alias.xml'
              ? 'alias'
              : null;
      if (kind) {
        out.push({ file: relChild, kind, text: fs.readFileSync(childPath, 'utf8') });
      }
    }
  };
  for (const corpus of CORPORA) {
    walk(path.join(REPO_ROOT, corpus), corpus);
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

// ---- defParser 原语上的小助手(与 Rust 判面原语逐条对应) ----

const defEntityName = (file: string): string => path.basename(file).replace(/\.def$/i, '');

const firstTextToken = (node: DefElementNode): string | undefined => {
  const token = getElementText(node).trim().split(/\s+/)[0];
  return token ? token : undefined;
};

const sectionEntries = (root: DefElementNode, canon: string): DefElementNode[] => {
  const lower = (name: string): string => name.toLowerCase().replace(/[\s_-]/g, '');
  const section = getDirectChildElements(root).find(n => lower(n.name) === canon);
  return section ? getDirectChildElements(section) : [];
};

const typeKindOf = (item: DefElementNode): 'fixedDict' | 'array' | 'builtin' => {
  const directive = firstTextToken(item);
  return directive === 'FIXED_DICT' ? 'fixedDict' : directive === 'ARRAY' ? 'array' : 'builtin';
};

// 与 Rust parse_alias/TS buildAliasXmlCustomTypeInfo 同口径(hover 对拍同款)。
const aliasDeclOf = (node: DefElementNode): { name: string; aliasType: string } | null => {
  const typeChild = getDirectChildElement(node, 'Type');
  const otherChild = getDirectChildElements(node).find(n => n.name !== 'Type');
  const texts = node.children
    .filter(c => !isElementNode(c))
    .map(c => ('text' in c ? c.text.trim() : ''))
    .filter(Boolean);
  if (!typeChild && !otherChild && texts.length === 0) {
    return null; // 属性式跳过
  }
  const aliasType = typeChild
    ? (texts.length > 0 && getElementText(typeChild).trim() === '' ? texts[0] : firstTextToken(typeChild) ?? 'ALIAS')
    : otherChild
      ? otherChild.name
      : texts[0] ?? 'ALIAS';
  return { name: node.name, aliasType };
};

// ---- 判面原语(与 kode_server::completion 同规则) ----

interface Split {
  head: string;
  fragment: string;
  openTag: boolean;
}

const splitFragment = (prefix: string): Split => {
  const match = prefix.match(/[A-Za-z0-9_]*$/);
  const fragment = match ? match[0] : '';
  const head = prefix.slice(0, prefix.length - fragment.length);
  return { head, fragment, openTag: head.endsWith('<') };
};

const scanLineTags = (line: string, stack: string[]): void => {
  const trimmed = line.replace(/^\s+/, '');
  if (trimmed.startsWith('<!--') && !trimmed.slice(4).includes('-->')) {
    return;
  }
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '<') {
      i += 1;
      continue;
    }
    const rel = line.indexOf('>', i + 1);
    if (rel === -1) {
      break; // 未闭合尾标:忽略
    }
    const inner = line.slice(i + 1, rel);
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      if (stack[stack.length - 1] === name) {
        stack.pop();
      }
    } else if (!inner.startsWith('!--') && !inner.endsWith('/')) {
      const m = inner.match(/^[A-Za-z0-9_-]+/);
      if (m) {
        stack.push(m[0]);
      }
    }
    i = rel + 1;
  }
};

const tagStack = (above: string): string[] => {
  const stack: string[] = [];
  for (const line of above.split('\n')) {
    scanLineTags(line, stack);
  }
  return stack;
};

const leadingWord = (value: string): string => {
  const m = value.match(/^[A-Za-z0-9_]+/);
  return m ? m[0] : '';
};

const openTagName = (trimmed: string): string | null => {
  if (!trimmed.startsWith('<')) {
    return null;
  }
  const m = trimmed.slice(1).match(/^[A-Za-z0-9_-]+/);
  if (!m) {
    return null;
  }
  const after = trimmed.slice(1 + m[0].length);
  return after.startsWith('>') || after.startsWith(' ') || after.startsWith('\t') ? m[0] : null;
};

// ---- 复算面(与 kode_server::completion 同形) ----

interface ItemFace {
  label: string;
  kind: 'entity' | 'property' | 'method' | 'type' | 'alias';
  facet: 'base' | 'cell' | 'client' | null;
  detail: string | null;
  inheritedFrom: string | null;
}

interface ContextFace {
  kind: 'openTag' | 'value';
  section: string;
  facet: 'base' | 'cell' | 'client' | null;
  entity: string | null;
  fragment: string;
}

interface ResponseFace {
  context: ContextFace;
  items: ItemFace[];
}

interface CorpusMaps {
  defsByStem: Map<string, string>;
  typeItems: ItemFace[]; // 预去重(同名首见,路径序)
  aliasItems: ItemFace[];
}

const buildCorpusMaps = (corpus: CorpusFile[]): CorpusMaps => {
  const defsByStem = new Map<string, string>();
  const typeItems: ItemFace[] = [];
  const aliasItems: ItemFace[] = [];
  const seenTypes = new Set<string>();
  const seenAliases = new Set<string>();
  for (const { file, kind, text } of corpus) {
    if (kind === 'def' && !defsByStem.has(defEntityName(file))) {
      defsByStem.set(defEntityName(file), file);
    }
    if (kind === 'types') {
      const document = parseDefDocument(text);
      if (document.root) {
        for (const item of getDirectChildElements(document.root)) {
          if (!firstTextToken(item)) {
            continue; // 空条目不产出(与 parseTypesXml 同口径)
          }
          if (!seenTypes.has(item.name)) {
            seenTypes.add(item.name);
            typeItems.push({ label: item.name, kind: 'type', facet: null, detail: typeKindOf(item), inheritedFrom: null });
          }
        }
      }
    }
    if (kind === 'alias') {
      const document = parseDefDocument(text);
      if (document.root) {
        for (const node of getDirectChildElements(document.root)) {
          const decl = aliasDeclOf(node);
          if (decl && !seenAliases.has(decl.name)) {
            seenAliases.add(decl.name);
            aliasItems.push({ label: decl.name, kind: 'alias', facet: null, detail: decl.aliasType, inheritedFrom: null });
          }
        }
      }
    }
  }
  return { defsByStem, typeItems, aliasItems };
};

// 继承成员条目(逐祖先读 def;同名被先出项遮蔽)。
const collectInherited = (
  face: string,
  facet: 'base' | 'cell' | 'client' | null,
  fragment: string,
  seen: Set<string>,
  relFile: string
): ItemFace[] => {
  const items: ItemFace[] = [];
  const info = buildDefChain(path.join(REPO_ROOT, relFile));
  for (const node of info.parentChain) {
    if (!node.defPath) {
      continue; // 缺父如实空,绝不虚构
    }
    let text: string | null = null;
    try {
      text = fs.readFileSync(node.defPath, 'utf8');
    } catch {
      text = null;
    }
    if (text === null) {
      continue;
    }
    const document = parseDefDocument(text);
    if (!document.root) {
      continue;
    }
    if (face === 'Properties') {
      for (const prop of sectionEntries(document.root, 'properties')) {
        if (!prop.name.startsWith(fragment) || seen.has(prop.name)) {
          continue;
        }
        const typeNode = getDirectChildElement(prop, 'Type');
        seen.add(prop.name);
        items.push({
          label: prop.name,
          kind: 'property',
          facet: null,
          detail: typeNode ? firstTextToken(typeNode) ?? null : null,
          inheritedFrom: node.name
        });
      }
    } else if (facet) {
      const canon = facet === 'base' ? 'basemethods' : facet === 'cell' ? 'cellmethods' : 'clientmethods';
      for (const method of sectionEntries(document.root, canon)) {
        if (!method.name.startsWith(fragment) || seen.has(method.name)) {
          continue;
        }
        seen.add(method.name);
        items.push({ label: method.name, kind: 'method', facet, detail: null, inheritedFrom: node.name });
      }
    }
  }
  return items;
};

const computeResponse = (
  corpusFile: CorpusFile,
  line0: number,
  character: number,
  maps: CorpusMaps
): ResponseFace | null => {
  const { file, kind, text } = corpusFile;
  const lines = text.split('\n');
  const line = lines[line0] ?? '';
  const prefix = line.slice(0, character);
  const { head, fragment, openTag } = splitFragment(prefix);
  if (openTag) {
    const stack = tagStack(lines.slice(0, line0).join('\n'));
    const top = stack[stack.length - 1];
    if (!top) {
      return null;
    }
    if (kind === 'def') {
      if (top === 'Properties' || top === 'BaseMethods' || top === 'CellMethods' || top === 'ClientMethods') {
        const entity = defEntityName(file);
        const seen = new Set<string>();
        const items: ItemFace[] = [];
        const push = (item: ItemFace): void => {
          if (item.label.startsWith(fragment) && !seen.has(item.label)) {
            seen.add(item.label);
            items.push(item);
          }
        };
        const document = parseDefDocument(text);
        if (document.root) {
          if (top === 'Properties') {
            for (const prop of sectionEntries(document.root, 'properties')) {
              const typeNode = getDirectChildElement(prop, 'Type');
              push({ label: prop.name, kind: 'property', facet: null, detail: typeNode ? firstTextToken(typeNode) ?? null : null, inheritedFrom: null });
            }
          } else {
            const facet = top === 'BaseMethods' ? 'base' : top === 'CellMethods' ? 'cell' : 'client';
            const canon = facet === 'base' ? 'basemethods' : facet === 'cell' ? 'cellmethods' : 'clientmethods';
            for (const method of sectionEntries(document.root, canon)) {
              push({ label: method.name, kind: 'method', facet, detail: null, inheritedFrom: null });
            }
          }
        }
        items.push(...collectInherited(top, top === 'Properties' ? null : (top === 'BaseMethods' ? 'base' : top === 'CellMethods' ? 'cell' : 'client'), fragment, seen, file));
        return {
          context: {
            kind: 'openTag',
            section: top,
            facet: top === 'Properties' ? null : (top === 'BaseMethods' ? 'base' : top === 'CellMethods' ? 'cell' : 'client'),
            entity,
            fragment
          },
          items
        };
      }
      if (top === 'Components') {
        return entitiesFace('openTag', 'Components', fragment, maps);
      }
      return null;
    }
    if (kind === 'entities' && top === 'root') {
      return entitiesFace('openTag', 'Entities', fragment, maps);
    }
    return null;
  }
  // 取值上下文。
  const trimmed = head.replace(/^\s+/, '');
  let section: 'Entity' | 'Types' | null = null;
  if (trimmed.startsWith('<Parent>')) {
    if (!/^\s*$/.test(trimmed.slice('<Parent>'.length))) {
      return null;
    }
    section = 'Entity';
  } else {
    for (const tag of ['<Type>', '<Arg>', '<of>'] as const) {
      if (trimmed.startsWith(tag)) {
        if (!/^\s*$/.test(trimmed.slice(tag.length))) {
          return null;
        }
        section = 'Types';
        break;
      }
    }
  }
  if (!section) {
    return null;
  }
  const items: ItemFace[] = [];
  if (section === 'Entity') {
    for (const name of [...maps.defsByStem.keys()].sort()) {
      if (name.startsWith(fragment)) {
        items.push({ label: name, kind: 'entity', facet: null, detail: maps.defsByStem.get(name) ?? null, inheritedFrom: null });
      }
    }
  } else {
    items.push(...maps.typeItems.filter(i => i.label.startsWith(fragment)));
    items.push(...maps.aliasItems.filter(i => i.label.startsWith(fragment)));
  }
  return {
    context: {
      kind: 'value',
      section,
      facet: null,
      entity: kind === 'def' ? defEntityName(file) : null,
      fragment
    },
    items
  };
};

const entitiesFace = (kind: 'openTag', section: string, fragment: string, maps: CorpusMaps): ResponseFace => {
  const items: ItemFace[] = [];
  for (const name of [...maps.defsByStem.keys()].sort()) {
    if (name.startsWith(fragment)) {
      items.push({ label: name, kind: 'entity', facet: null, detail: maps.defsByStem.get(name) ?? null, inheritedFrom: null });
    }
  }
  return {
    context: { kind, section, facet: null, entity: null, fragment },
    items
  };
};

// ---- 场景枚举(与 Rust enumerate_scenarios 同规则) ----

interface ScenarioPos {
  line: number; // 1 起
  character: number; // UTF-16 列
}

const enumerateScenarios = (kind: string, text: string): ScenarioPos[] => {
  const out: ScenarioPos[] = [];
  const stack: string[] = [];
  const lines = text.split('\n');
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const line1 = idx + 1;
    const trimmed = line.replace(/^\s+/, '');
    const ws16 = line.length - trimmed.length;
    const top = stack[stack.length - 1];
    if (kind === 'def') {
      if (
        top === 'Properties' ||
        top === 'BaseMethods' ||
        top === 'CellMethods' ||
        top === 'ClientMethods' ||
        top === 'Components'
      ) {
        const name = openTagName(trimmed);
        if (name) {
          const frag16 = Math.min(2, name.length);
          out.push({ line: line1, character: ws16 + 1 });
          out.push({ line: line1, character: ws16 + 1 + frag16 });
        }
      }
      const valuePoint = (tag: string, rest: string): void => {
        out.push({ line: line1, character: ws16 + tag.length });
        const value = rest.replace(/^\s+/, '');
        if (!value) {
          return;
        }
        const pad = rest.length - value.length;
        const token = leadingWord(value);
        out.push({ line: line1, character: ws16 + tag.length + pad + token.length });
      };
      if (trimmed.startsWith('<Parent>')) {
        valuePoint('<Parent>', trimmed.slice('<Parent>'.length));
      } else {
        for (const tag of ['<Type>', '<Arg>', '<of>'] as const) {
          if (trimmed.startsWith(tag)) {
            valuePoint(tag, trimmed.slice(tag.length));
            break;
          }
        }
      }
    } else if (kind === 'entities' && top === 'root') {
      const name = openTagName(trimmed);
      if (name) {
        const frag16 = Math.min(2, name.length);
        out.push({ line: line1, character: ws16 + 1 });
        out.push({ line: line1, character: ws16 + 1 + frag16 });
      }
    }
    scanLineTags(line, stack);
  }
  return out;
};

// ---- 门禁 ----

interface GoldenScenario {
  line: number;
  character: number;
  response: ResponseFace;
}

describe('kode2 PR-011 completion 对拍(Rust completion 请求链 vs TS 补全面)', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as {
    fileCount: number;
    scenarioCount: number;
    files: { file: string; kind: string; scenarios: GoldenScenario[] }[];
  };

  const corpus = collectCorpus();
  const maps = buildCorpusMaps(corpus);
  const computedFiles = corpus.map(({ file, kind }) => ({ file, kind: kind as string }));
  const computed = new Map<string, GoldenScenario[]>();
  let computedScenarioCount = 0;
  for (const corpusFile of corpus) {
    const scenarios: GoldenScenario[] = [];
    for (const pos of enumerateScenarios(corpusFile.kind, corpusFile.text)) {
      const response = computeResponse(corpusFile, pos.line - 1, pos.character, maps);
      if (response) {
        scenarios.push({ line: pos.line, character: pos.character, response });
      }
    }
    computed.set(corpusFile.file, scenarios);
    computedScenarioCount += scenarios.length;
  }

  it('语料文件数与 golden 一致(文件面 N/N)', () => {
    expect(computedFiles.length).toBe(golden.fileCount);
    expect(computedFiles.map(f => f.file)).toEqual(golden.files.map(f => f.file));
  });

  it('场景总数与 golden 一致(场景面 M/M)', () => {
    expect(computedScenarioCount).toBe(golden.scenarioCount);
    const goldenCount = golden.files.reduce((sum, f) => sum + f.scenarios.length, 0);
    expect(computedScenarioCount).toBe(goldenCount);
  });

  it('逐文件逐场景判面+条目集逐字段一致(六面:实体/属性/方法分面/类型/别名/继承成员)', () => {
    let matched = 0;
    let total = 0;
    const mismatches: string[] = [];
    for (const goldenFile of golden.files) {
      const expected = computed.get(goldenFile.file);
      expect(expected, goldenFile.file).toBeDefined();
      total += goldenFile.scenarios.length;
      const sameLength =
        expected !== undefined && expected.length === goldenFile.scenarios.length;
      if (sameLength && expected !== undefined) {
        const allEqual = goldenFile.scenarios.every((s, i) =>
          JSON.stringify(s) === JSON.stringify(expected[i])
        );
        if (allEqual) {
          matched += goldenFile.scenarios.length;
          continue;
        }
      }
      mismatches.push(goldenFile.file);
    }
    expect(mismatches, `不一致文件: ${mismatches.join(', ')}`).toEqual([]);
    expect(matched).toBe(total);
  });

  it('六面条目集在语料上非空(实体/属性/方法分面/类型;别名面随属性式语料为 0)', () => {
    const all = golden.files.flatMap(f => f.scenarios).flatMap(s => s.response.items);
    const counts: Record<string, number> = {};
    for (const item of all) {
      counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    }
    expect(counts.entity).toBeGreaterThan(0);
    expect(counts.property).toBeGreaterThan(0);
    expect(counts.method).toBeGreaterThan(0);
    expect(counts.type).toBeGreaterThan(0);
    const inherited = all.filter(i => i.inheritedFrom !== null);
    expect(inherited.length).toBeGreaterThan(0);
  });
});
