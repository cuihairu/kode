// kode2 PR-005 对拍门禁:用 TS 现有 defParser 实现复算 Rust 侧生成的
// golden(crates/kode-parser/tests/golden/def-parity.json),逐文件逐字段比对。
// 本文件只读 fixture 与 golden,不改 src/(对拍语义 = 双实现同输入同输出)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DefDocument,
  DefElementNode,
  getDirectChildElement,
  getDirectChildElements,
  getElementText,
  getLineNumberAt,
  isElementNode,
  parseDefDocument
} from '../src/defParser';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-parser/tests/golden/def-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;

type GoldenRecord = Record<string, unknown>;

interface GoldenFile {
  file: string;
  kind: 'def' | 'entities' | 'types' | 'alias';
  record: GoldenRecord;
}

const loadGolden = (): GoldenFile[] => {
  const raw = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as { files: GoldenFile[] };
  return raw.files;
};

// 与 Rust model::canonical_tag 同口径:小写 + 去空格/下划线/连字符
const canonicalTag = (name: string): string =>
  name.toLowerCase().replace(/[\s_-]/g, '');

// 与 Rust model::normalize_flag_tokens 同口径(遗留拼写折叠)
const KNOWN_FLAGS = [
  'BASE',
  'BASE_AND_CLIENT',
  'CELL_PUBLIC',
  'CELL_PRIVATE',
  'ALL_CLIENTS',
  'CELL_PUBLIC_AND_OWN',
  'OWN_CLIENT',
  'OTHER_CLIENTS'
];
const normalizeFlagTokens = (raw: string): string[] => {
  const out: string[] = [];
  for (const token of raw.split('|')) {
    const upper = token.trim().toUpperCase();
    if (!upper) {
      continue;
    }
    let canonical: string;
    if (upper === 'CELL') {
      canonical = 'CELL_PUBLIC';
    } else if (KNOWN_FLAGS.includes(upper)) {
      canonical = upper;
    } else {
      const compact = upper.replace(/[\s_-]/g, '');
      const known = KNOWN_FLAGS.find(k => k.replace(/_/g, '') === compact);
      canonical = known ?? upper;
    }
    if (!out.includes(canonical)) {
      out.push(canonical);
    }
  }
  return out;
};

const firstTextToken = (node: DefElementNode): string | undefined => {
  const token = getElementText(node).trim().split(/\s+/)[0];
  return token ? token : undefined;
};

const scalarChildByCanon = (
  document: DefDocument,
  node: DefElementNode,
  canon: string
): string | undefined => {
  for (const child of getDirectChildElements(node)) {
    if (canonicalTag(child.name) === canon) {
      const value = getElementText(child).trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
};

const hasTruthyChildByCanon = (
  document: DefDocument,
  node: DefElementNode,
  canon: string
): boolean => {
  for (const child of getDirectChildElements(node)) {
    if (canonicalTag(child.name) !== canon) {
      continue;
    }
    if (child.selfClosing) {
      return true;
    }
    const value = getElementText(child).trim().toLowerCase();
    if (value === '' || value === 'true' || value === '1' || value === 'yes') {
      return true;
    }
  }
  return false;
};

const collectTypeRefs = (document: DefDocument, typeNode: DefElementNode): string[] => {
  const names: string[] = [];
  for (const token of getElementText(typeNode).split(/\s+/)) {
    if (token && token !== 'ARRAY' && token !== 'FIXED_DICT') {
      names.push(token);
    }
  }
  for (const child of getDirectChildElements(typeNode)) {
    if (child.name === 'of') {
      const of = getElementText(child).trim();
      if (of) {
        names.push(of);
      }
    }
  }
  return names;
};

const KNOWN_DEF_SECTIONS = new Set([
  'parent',
  'interfaces',
  'volatile',
  'properties',
  'components',
  'basemethods',
  'cellmethods',
  'clientmethods'
]);

const extractDef = (text: string): GoldenRecord => {
  const document = parseDefDocument(text);
  const root = document.root;
  if (!root) {
    return { root: null, parent: null, interfaces: [], volatile: false, properties: [], components: [], baseMethods: [], cellMethods: [], clientMethods: [], extraSections: [] };
  }
  const parent = scalarChildByCanon(document, root, 'parent') ?? null;
  const interfaces: string[] = [];
  const interfacesNode = getDirectChildElements(root).find(n => canonicalTag(n.name) === 'interfaces');
  if (interfacesNode) {
    for (const iface of getDirectChildElements(interfacesNode)) {
      const name = getElementText(iface).trim();
      if (name) {
        interfaces.push(name);
      }
    }
  }
  const volatile = hasTruthyChildByCanon(document, root, 'volatile');
  const properties: GoldenRecord[] = [];
  const propertiesNode = getDirectChildElements(root).find(n => canonicalTag(n.name) === 'properties');
  if (propertiesNode) {
    for (const prop of getDirectChildElements(propertiesNode)) {
      const typeNode = getDirectChildElements(prop).find(n => canonicalTag(n.name) === 'type');
      const flagsTokens: string[] = [];
      for (const child of getDirectChildElements(prop)) {
        const canon = canonicalTag(child.name);
        if (canon === 'flags' || canon === 'clientflags') {
          const raw = getElementText(child).trim();
          if (raw) {
            for (const t of normalizeFlagTokens(raw)) {
              if (!flagsTokens.includes(t)) {
                flagsTokens.push(t);
              }
            }
          }
        }
      }
      properties.push({
        name: prop.name,
        type: typeNode ? firstTextToken(typeNode) ?? null : null,
        flags: flagsTokens,
        detailLevel: scalarChildByCanon(document, prop, 'detaillevel') ?? null,
        persistent: hasTruthyChildByCanon(document, prop, 'persistent') ? true : (getDirectChildElements(prop).some(n => canonicalTag(n.name) === 'persistent') ? false : null),
        sensitive: hasTruthyChildByCanon(document, prop, 'sensitive'),
        line: getLineNumberAt(document, prop.tagStart)
      });
    }
  }
  const components: GoldenRecord[] = [];
  const componentsNode = getDirectChildElements(root).find(n => canonicalTag(n.name) === 'components');
  if (componentsNode) {
    for (const comp of getDirectChildElements(componentsNode)) {
      const persistentDeclared = getDirectChildElements(comp).some(n => canonicalTag(n.name) === 'persistent');
      components.push({
        name: comp.name,
        type: scalarChildByCanon(document, comp, 'type') ?? null,
        persistent: persistentDeclared ? hasTruthyChildByCanon(document, comp, 'persistent') : null,
        line: getLineNumberAt(document, comp.tagStart)
      });
    }
  }
  const methodsOf = (canon: string): GoldenRecord[] => {
    const section = getDirectChildElements(root).find(n => canonicalTag(n.name) === canon);
    if (!section) {
      return [];
    }
    return getDirectChildElements(section).map(method => ({
      name: method.name,
      args: getDirectChildElements(method)
        .filter(arg => canonicalTag(arg.name) === 'arg')
        .map(arg => getElementText(arg).trim())
        .filter(Boolean),
      exposed: hasTruthyChildByCanon(document, method, 'exposed'),
      line: getLineNumberAt(document, method.tagStart)
    }));
  };
  const extraSections = getDirectChildElements(root)
    .filter(n => !KNOWN_DEF_SECTIONS.has(canonicalTag(n.name)))
    .map(n => n.name);
  return {
    root: root.name,
    parent,
    interfaces,
    volatile,
    properties,
    components,
    baseMethods: methodsOf('basemethods'),
    cellMethods: methodsOf('cellmethods'),
    clientMethods: methodsOf('clientmethods'),
    extraSections
  };
};

const extractEntities = (text: string): GoldenRecord => {
  const document = parseDefDocument(text);
  const root = document.root;
  const entities: GoldenRecord[] = [];
  if (root) {
    for (const node of getDirectChildElements(root)) {
      if (node.name === 'root') {
        continue;
      }
      entities.push({
        name: node.name,
        attrs: { ...node.attributes },
        line: getLineNumberAt(document, node.tagStart)
      });
    }
  }
  return { entities };
};

const extractTypes = (text: string): GoldenRecord => {
  const document = parseDefDocument(text);
  const root = document.root;
  const types: GoldenRecord[] = [];
  if (root) {
    for (const item of getDirectChildElements(root)) {
      const directive = firstTextToken(item);
      if (!directive) {
        continue;
      }
      if (directive === 'FIXED_DICT') {
        const implementedBy = scalarChildByCanon(document, item, 'implementedby');
        const fieldRefs: string[] = [];
        const propertiesNode = getDirectChildElements(item).find(n => n.name === 'Properties');
        if (propertiesNode) {
          for (const prop of getDirectChildElements(propertiesNode)) {
            const typeNode = getDirectChildElement(prop, 'Type');
            if (typeNode) {
              fieldRefs.push(...collectTypeRefs(document, typeNode));
            }
          }
        }
        types.push({
          name: item.name,
          kind: 'fixedDict',
          implementedBySymbol: implementedBy ? (implementedBy.trim().split('.').pop() ?? '').trim() || null : null,
          fieldRefs,
          elementRef: null,
          line: getLineNumberAt(document, item.tagStart)
        });
      } else if (directive === 'ARRAY') {
        const ofNode = getDirectChildElement(item, 'of');
        types.push({
          name: item.name,
          kind: 'array',
          implementedBySymbol: null,
          fieldRefs: [],
          elementRef: ofNode ? getElementText(ofNode).trim() || null : null,
          line: getLineNumberAt(document, item.tagStart)
        });
      } else {
        types.push({
          name: item.name,
          kind: 'builtin',
          implementedBySymbol: null,
          fieldRefs: [],
          elementRef: null,
          line: getLineNumberAt(document, item.tagStart)
        });
      }
    }
  }
  return { types };
};

const extractAlias = (text: string): GoldenRecord => {
  // 与 src/definitionWorkspace.ts buildAliasXmlCustomTypeInfo 的跳过规则同口径:
  // 无 Type 子、无非 Type 子元素、且直接文本全空白 → 不产出条目
  const document = parseDefDocument(text);
  const root = document.root;
  const aliases: GoldenRecord[] = [];
  if (root) {
    for (const node of getDirectChildElements(root)) {
      const typeChild = getDirectChildElement(node, 'Type');
      const otherChild = getDirectChildElements(node).find(n => n.name !== 'Type');
      const directTexts = node.children
        .filter(c => !isElementNode(c))
        .map(c => ('text' in c ? c.text.trim() : ''))
        .filter(Boolean);
      if (!typeChild && !otherChild && directTexts.length === 0) {
        continue;
      }
      let aliasType: string;
      if (typeChild) {
        const t = typeChild.children
          .filter(c => !isElementNode(c))
          .map(c => ('text' in c ? c.text.trim() : ''))
          .filter(Boolean)[0];
        aliasType = t ?? 'ALIAS';
      } else if (otherChild) {
        aliasType = otherChild.name;
      } else {
        aliasType = directTexts[0] ?? 'ALIAS';
      }
      aliases.push({
        name: node.name,
        aliasType,
        line: getLineNumberAt(document, node.tagStart)
      });
    }
  }
  return { aliases };
};

const extract = (kind: GoldenFile['kind'], text: string): GoldenRecord => {
  switch (kind) {
    case 'def':
      return extractDef(text);
    case 'entities':
      return extractEntities(text);
    case 'types':
      return extractTypes(text);
    case 'alias':
      return extractAlias(text);
  }
};

const collectCorpus = (): GoldenFile[] => {
  const out: GoldenFile[] = [];
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
      if (!kind) {
        continue;
      }
      out.push({ file: relChild, kind, record: extract(kind, fs.readFileSync(childPath, 'utf8')) });
    }
  };
  for (const corpus of CORPORA) {
    walk(path.join(REPO_ROOT, corpus), corpus);
  }
  // 与 Rust BTreeMap(全路径字节序)一致的确定性顺序
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

describe('kode-parser 与 TS defParser fixture 对拍(PR-005)', () => {
  const golden = loadGolden();
  const corpus = collectCorpus();

  it('golden 覆盖语料完整(文件集合一致)', () => {
    expect(golden.map(f => f.file)).toEqual(corpus.map(f => f.file));
    expect(golden.length).toBeGreaterThanOrEqual(25);
  });

  const diffRecord = (expected: unknown, actual: unknown, trail: string): string[] => {
    if (Array.isArray(expected) && Array.isArray(actual)) {
      if (expected.length !== actual.length) {
        return [`${trail}: 长度 ${actual.length} ≠ golden ${expected.length}`];
      }
      const out: string[] = [];
      for (let i = 0; i < expected.length; i += 1) {
        out.push(...diffRecord(expected[i], actual[i], `${trail}[${i}]`));
      }
      return out;
    }
    if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
      const out: string[] = [];
      const keys = new Set([
        ...Object.keys(expected as Record<string, unknown>),
        ...Object.keys(actual as Record<string, unknown>)
      ]);
      for (const key of keys) {
        if (key === 'syntaxErrorCount') {
          continue; // TS fxp 侧无对应计数,仅 Rust 侧字段
        }
        out.push(...diffRecord(
          (expected as Record<string, unknown>)[key],
          (actual as Record<string, unknown>)[key],
          `${trail}.${key}`
        ));
      }
      return out;
    }
    return expected === actual ? [] : [`${trail}: ${JSON.stringify(actual)} ≠ golden ${JSON.stringify(expected)}`];
  };

  it('每个语料文件的语义记录与 golden 一致(通过率 100%)', () => {
    const failures: string[] = [];
    let matched = 0;
    for (let i = 0; i < golden.length; i += 1) {
      const diffs = diffRecord(golden[i].record, corpus[i].record, corpus[i].file);
      if (diffs.length === 0) {
        matched += 1;
      } else {
        failures.push(...diffs.slice(0, 8));
      }
    }
    const rate = ((matched / golden.length) * 100).toFixed(1);
    // eslint-disable-next-line no-console
    console.log(`[对拍] ${matched}/${golden.length} 文件一致,通过率 ${rate}%`);
    expect(failures, failures.join('\n')).toEqual([]);
    expect(rate).toBe('100.0');
  });

  it('语料语义抽查:Avatar 属性/Monster 父链与既有 TS 测试认知一致', () => {
    const avatar = corpus.find(f => f.file.endsWith('kbengine-demo-assets/scripts/entity_defs/Avatar.def'));
    expect(avatar).toBeDefined();
    const record = avatar!.record as { properties: Array<{ name: string; type: string | null; flags: string[]; detailLevel: string | null }>; clientMethods: unknown[]; baseMethods: Array<{ name: string; exposed: boolean }> };
    expect(record.properties.map(p => p.name)).toEqual(['name', 'level', 'hp', 'position', 'sight', 'skillSlots']);
    expect(record.properties.find(p => p.name === 'sight')!.detailLevel).toBe('MEDIUM');
    expect(record.properties.find(p => p.name === 'hp')!.flags).toEqual(['ALL_CLIENTS']);
    expect(record.baseMethods.find(m => m.name === 'reqCastSkill')!.exposed).toBe(true);
    const monster = corpus.find(f => f.file.endsWith('kbengine-demo-assets/scripts/entity_defs/Monster.def'));
    expect((monster!.record as { parent: string | null }).parent).toBe('Avatar');
  });
});
