// kode2 PR-010 对拍门禁:用 TS 现有 defParser/compositionRoots/defChain 原语
// 复算 Rust 侧生成的 hover 响应链 golden(crates/kode-server/tests/golden/
// hover-parity.json),逐文件逐悬停比对(定位 + 签名 + 继承成员面;本文件只读
// fixture 与 golden,不改 src/,对拍语义 = 双实现同输入同 hover 面)。
// 与 kodeIndexParity/kodeTypesParity 同构。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DefElementNode,
  getDirectChildElement,
  getDirectChildElements,
  getElementText,
  getLineNumberAt,
  hasTruthyChildTag,
  isElementNode,
  parseDefDocument
} from '../src/backend/defParser';
import { buildDefChain } from '../src/backend/defChain';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/hover-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;

// 语料工程根归属(KBUG-ROOT):文件所属 CORPORA 前缀即其资源根(与生产
// root_for 同口径,跨工程同名实体不再首见借路径)。
const corpusRootOf = (file: string): string =>
  CORPORA.find(corpus => file.startsWith(`${corpus}/`)) ?? '';

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

// ---- defParser 原语上的小助手(与 Rust 抽取口径逐条对应) ----

const canonicalTagOf = (name: string): string =>
  name.toLowerCase().replace(/[\s_-]/g, '');

const firstTextToken = (node: DefElementNode): string | undefined => {
  const token = getElementText(node).trim().split(/\s+/)[0];
  return token ? token : undefined;
};

const rawChildByCanon = (node: DefElementNode, canon: string): string | null => {
  const child = getDirectChildElements(node).find(n => canonicalTagOf(n.name) === canon);
  if (!child) {
    return null;
  }
  const raw = getElementText(child).trim();
  return raw || null;
};

// 与 Rust extract_property 同口径:Flags 与遗留 ClientFlags 双标签合并('|' 连接)。
const flagsRawOf = (node: DefElementNode): string | null => {
  const parts: string[] = [];
  for (const child of getDirectChildElements(node)) {
    const canon = canonicalTagOf(child.name);
    if (canon === 'flags' || canon === 'clientflags') {
      const raw = getElementText(child).trim();
      if (raw) {
        parts.push(raw);
      }
    }
  }
  return parts.length > 0 ? parts.join('|') : null;
};

// 与 Rust persistent: Option<bool> 同口径:无标签为 null,有标签走 truthy 语义。
const persistentOptOf = (node: DefElementNode, tag: string): boolean | null => {
  const child = getDirectChildElements(node).find(n => canonicalTagOf(n.name) === canonicalTagOf(tag));
  return child ? hasTruthyChildTag(node, tag) : null;
};

const defEntityName = (file: string): string =>
  path.basename(file).replace(/\.def$/i, '');

const sectionEntries = (root: DefElementNode, canon: string): DefElementNode[] => {
  const section = getDirectChildElements(root).find(n => canonicalTagOf(n.name) === canon);
  return section ? getDirectChildElements(section) : [];
};

// ---- hover 面(与 kode_server::hover 同形) ----

interface ChainNodeFace {
  name: string;
  exists: boolean;
}

interface MemberFace {
  entity: string;
  exists: boolean;
  properties: { name: string; type: string | null }[];
  methods: { name: string; facet: 'base' | 'cell' | 'client' }[];
}

interface InheritedFace {
  parentChain: ChainNodeFace[];
  interfaces: ChainNodeFace[];
  components: ChainNodeFace[];
  cycleTruncated: boolean;
  members: MemberFace[];
}

interface HoverFace {
  face: string;
  symbol: { name: string; kind: string; facet: string | null; section: string };
  source: { file: string; line: number };
  signature: Record<string, unknown>;
  inherited?: InheritedFace;
}

interface ExpectedHover {
  line: number;
  word: string;
  hover: HoverFace;
}

const emptySignature = (): Record<string, unknown> => ({
  type: null,
  flags: null,
  defaultValue: null,
  detailLevel: null,
  databaseLength: null,
  identifier: null,
  persistent: null,
  argCount: null,
  args: null,
  exposed: null,
  componentType: null,
  typeKind: null,
  aliasTarget: null,
  aliasType: null,
  defFile: null,
  defExists: null,
  parent: null,
  comment: null,
  facets: []
});

// ---- RUST-136 三面(TS 复算镜像,与 kode_server::hover 同算法) ----

// 声明行(1 基)紧邻上方的 `<!-- -->` 注释块:自上一行向上扫,空白行可间隔,
// 遇首个非注释内容行即停;跨行注释向上续;逐行去标记 trim,块首尾空行丢,
// 多行 '\n' 连接;畸形未闭合到顶按已收内容返回。
const precedingComment = (text: string, declLine1: number): string | null => {
  if (declLine1 <= 1) {
    return null;
  }
  const lines = text.split('\n');
  const pieces: string[] = [];
  let inComment = false;
  let idx = declLine1 - 2;
  for (;;) {
    const line = lines[idx];
    if (line === undefined) {
      break;
    }
    const trimmed = line.trim();
    if (trimmed === '') {
      if (inComment) {
        break;
      }
    } else {
      const opens = trimmed.includes('<!--');
      const closes = trimmed.includes('-->');
      if (!opens && !closes) {
        break;
      }
      if (closes) {
        const markerPos = trimmed.lastIndexOf('<!--');
        const start = markerPos === -1 ? 0 : markerPos + 4;
        const closeRel = trimmed.indexOf('-->', start);
        const end = closeRel === -1 ? trimmed.length : closeRel;
        const content = trimmed.slice(start, end).trim();
        if (content !== '') {
          pieces.push(content);
        }
        if (opens) {
          break;
        }
        inComment = true;
      } else {
        if (!inComment) {
          break;
        }
        const content = trimmed.slice(trimmed.lastIndexOf('<!--') + 4).trim();
        if (content !== '') {
          pieces.push(content);
        }
        break;
      }
    }
    if (idx === 0) {
      break;
    }
    idx -= 1;
  }
  if (pieces.length === 0) {
    return null;
  }
  pieces.reverse();
  return pieces.join('\n');
};

// 实体本体面可用分面:本 def 方法三段非空段(base→cell→client 固定序)。
const entityFacets = (root: DefElementNode): string[] => {
  const facets: string[] = [];
  if (sectionEntries(root, 'basemethods').length > 0) {
    facets.push('base');
  }
  if (sectionEntries(root, 'cellmethods').length > 0) {
    facets.push('cell');
  }
  if (sectionEntries(root, 'clientmethods').length > 0) {
    facets.push('client');
  }
  return facets;
};

// 继承成员面:与 TS buildDefChain 同链,成员展开逐祖先读 def。
const inheritedFaceOf = (absPath: string): InheritedFace => {
  const info = buildDefChain(absPath);
  const toNode = (node: { name: string; defPath: string | null }): ChainNodeFace => ({
    name: node.name,
    exists: node.defPath !== null
  });
  const members: MemberFace[] = info.parentChain.map(node => {
    if (!node.defPath) {
      return { entity: node.name, exists: false, properties: [], methods: [] };
    }
    let text: string | null = null;
    try {
      text = fs.readFileSync(node.defPath, 'utf8');
    } catch {
      text = null;
    }
    if (text === null) {
      return { entity: node.name, exists: false, properties: [], methods: [] };
    }
    const document = parseDefDocument(text);
    const properties: MemberFace['properties'] = [];
    const methods: MemberFace['methods'] = [];
    if (document.root) {
      for (const prop of sectionEntries(document.root, 'properties')) {
        const typeNode = getDirectChildElement(prop, 'Type');
        properties.push({ name: prop.name, type: typeNode ? firstTextToken(typeNode) ?? null : null });
      }
      const facetSections: [('base' | 'cell' | 'client'), string][] = [
        ['base', 'basemethods'],
        ['cell', 'cellmethods'],
        ['client', 'clientmethods']
      ];
      for (const [facet, canon] of facetSections) {
        for (const method of sectionEntries(document.root, canon)) {
          methods.push({ name: method.name, facet });
        }
      }
    }
    return { entity: node.name, exists: true, properties, methods };
  });
  return {
    parentChain: info.parentChain.map(toNode),
    interfaces: info.interfaces.map(toNode),
    components: info.components.map(toNode),
    cycleTruncated: info.cycleTruncated,
    members
  };
};

const computeHovers = (
  corpus: CorpusFile[],
  defsByStem: Map<string, Map<string, string[]>>
): ExpectedHover[] => {
  // 逐文件产出(顺序 = Rust extract_records / parse 顺序)。
  const all: ExpectedHover[] = [];
  for (const { file, kind, text } of corpus) {
    const document = parseDefDocument(text);
    const root = document.root;
    const hovers: ExpectedHover[] = [];
    if (kind === 'def') {
      if (root) {
        // 实体本体(行 1,file stem)。
        const parentNode = getDirectChildElements(root).find(n => canonicalTagOf(n.name) === 'parent');
        const parentName = parentNode ? firstTextToken(parentNode) ?? null : null;
        hovers.push({
          line: 1,
          word: defEntityName(file),
          hover: {
            face: 'defEntity',
            symbol: { name: defEntityName(file), kind: 'entity', facet: null, section: 'Entity' },
            source: { file, line: 1 },
            signature: {
              ...emptySignature(),
              parent: parentName,
              comment: precedingComment(text, 1),
              facets: entityFacets(root)
            },
            inherited: inheritedFaceOf(path.join(REPO_ROOT, file))
          }
        });
        for (const prop of sectionEntries(root, 'properties')) {
          const typeNode = getDirectChildElement(prop, 'Type');
          const propLine = getLineNumberAt(document, prop.tagStart);
          hovers.push({
            line: propLine,
            word: prop.name,
            hover: {
              face: 'defProperty',
              symbol: { name: prop.name, kind: 'property', facet: null, section: 'Properties' },
              source: { file, line: propLine },
              signature: {
                ...emptySignature(),
                type: typeNode ? firstTextToken(typeNode) ?? null : null,
                flags: flagsRawOf(prop),
                defaultValue: rawChildByCanon(prop, 'default'),
                detailLevel: rawChildByCanon(prop, 'detaillevel'),
                databaseLength: rawChildByCanon(prop, 'databaselength'),
                identifier: rawChildByCanon(prop, 'identifier'),
                persistent: persistentOptOf(prop, 'Persistent'),
                comment: precedingComment(text, propLine)
              }
            }
          });
        }
        for (const comp of sectionEntries(root, 'components')) {
          const compLine = getLineNumberAt(document, comp.tagStart);
          hovers.push({
            line: compLine,
            word: comp.name,
            hover: {
              face: 'defComponent',
              symbol: { name: comp.name, kind: 'component', facet: null, section: 'Components' },
              source: { file, line: compLine },
              signature: {
                ...emptySignature(),
                componentType: rawChildByCanon(comp, 'type'),
                persistent: persistentOptOf(comp, 'Persistent'),
                comment: precedingComment(text, compLine)
              }
            }
          });
        }
        const methodSections: [('base' | 'cell' | 'client'), string, string][] = [
          ['base', 'basemethods', 'BaseMethods'],
          ['cell', 'cellmethods', 'CellMethods'],
          ['client', 'clientmethods', 'ClientMethods']
        ];
        for (const [facet, canon, section] of methodSections) {
          for (const method of sectionEntries(root, canon)) {
            const args: string[] = [];
            let exposed = false;
            for (const child of getDirectChildElements(method)) {
              const childCanon = canonicalTagOf(child.name);
              if (childCanon === 'arg') {
                const raw = getElementText(child).trim();
                if (raw) {
                  args.push(raw);
                }
              } else if (childCanon === 'exposed') {
                exposed = hasTruthyChildTag(method, child.name);
              }
            }
            const methodLine = getLineNumberAt(document, method.tagStart);
            hovers.push({
              line: methodLine,
              word: method.name,
              hover: {
                face: 'defMethod',
                symbol: { name: method.name, kind: 'method', facet, section },
                source: { file, line: methodLine },
                signature: {
                  ...emptySignature(),
                  argCount: args.length,
                  args,
                  exposed,
                  comment: precedingComment(text, methodLine)
                }
              }
            });
          }
        }
      }
    } else if (kind === 'entities') {
      if (root) {
        for (const node of getDirectChildElements(root)) {
          if (node.name === 'root') {
            continue; // root 伪条目排除(与 Rust parse_entities 同口径)
          }
          // KBUG-ROOT:候选按查询方语料工程根定域(defFile 报根内首候选)。
          const defPath = defsByStem.get(corpusRootOf(file))?.get(node.name)?.[0];
          const entryLine = getLineNumberAt(document, node.tagStart);
          hovers.push({
            line: entryLine,
            word: node.name,
            hover: {
              face: 'entitiesXml',
              symbol: { name: node.name, kind: 'entity', facet: null, section: 'Entities' },
              source: { file, line: entryLine },
              signature: {
                ...emptySignature(),
                defFile: defPath ?? `${node.name}.def`,
                defExists: defPath !== undefined,
                comment: precedingComment(text, entryLine)
              }
            }
          });
        }
      }
    } else if (kind === 'types') {
      if (root) {
        for (const item of getDirectChildElements(root)) {
          // 属性式回落 `type` 属性(与 Rust parse_types 同口径;PR-012 门 §1.3-①)。
          const directive = firstTextToken(item) ?? ((item.attributes['type'] ?? '').trim() || undefined);
          if (!directive) {
            continue; // 空条目不产声明(与 parseTypesXml 同口径)
          }
          const typeKind = directive === 'FIXED_DICT' ? 'fixedDict' : directive === 'ARRAY' ? 'array' : 'builtin';
          const aliasTarget = directive !== 'FIXED_DICT' && directive !== 'ARRAY' ? directive : null;
          const itemLine = getLineNumberAt(document, item.tagStart);
          hovers.push({
            line: itemLine,
            word: item.name,
            hover: {
              face: 'typesXml',
              symbol: { name: item.name, kind: 'type', facet: null, section: 'Types' },
              source: { file, line: itemLine },
              signature: {
                ...emptySignature(),
                typeKind,
                aliasTarget,
                comment: precedingComment(text, itemLine)
              }
            }
          });
        }
      }
    } else {
      // alias.xml:与 Rust parse_alias/TS buildAliasXmlCustomTypeInfo 同口径。
      if (root) {
        for (const node of getDirectChildElements(root)) {
          const typeChild = getDirectChildElement(node, 'Type');
          const otherChild = getDirectChildElements(node).find(n => n.name !== 'Type');
          const texts = node.children
            .filter(c => !isElementNode(c))
            .map(c => ('text' in c ? c.text.trim() : ''))
            .filter(Boolean);
          if (!typeChild && !otherChild && texts.length === 0) {
            continue; // 属性式跳过
          }
          const aliasType = typeChild
            ? (texts.length > 0 && getElementText(typeChild).trim() === '' ? texts[0] : firstTextToken(typeChild) ?? 'ALIAS')
            : otherChild
              ? otherChild.name
              : texts[0] ?? 'ALIAS';
          const aliasLine = getLineNumberAt(document, node.tagStart);
          hovers.push({
            line: aliasLine,
            word: node.name,
            hover: {
              face: 'aliasXml',
              symbol: { name: node.name, kind: 'alias', facet: null, section: 'Aliases' },
              source: { file, line: aliasLine },
              signature: {
                ...emptySignature(),
                aliasType,
                comment: precedingComment(text, aliasLine)
              }
            }
          });
        }
      }
    }

    all.push(...hovers);
  }
  return all;
};

// ---- 门禁 ----

describe('kode2 PR-010 hover 对拍(Rust hover 响应链 vs TS hover 面)', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as {
    fileCount: number;
    hoverCount: number;
    files: { file: string; kind: string; hovers: ExpectedHover[] }[];
  };

  const corpus = collectCorpus();
  // 实体名 → def 候选(按语料工程根隔离,根内入库序;KBUG-ROOT)。
  const defsByStem = new Map<string, Map<string, string[]>>();
  for (const { file, kind } of corpus) {
    if (kind === 'def') {
      const root = corpusRootOf(file);
      const byStem = defsByStem.get(root) ?? new Map<string, string[]>();
      const candidates = byStem.get(defEntityName(file)) ?? [];
      if (!candidates.includes(file)) {
        candidates.push(file);
      }
      byStem.set(defEntityName(file), candidates);
      defsByStem.set(root, byStem);
    }
  }
  const computedFiles = corpus.map(({ file, kind }) => ({ file, kind: kind as string }));
  const computed = computeHovers(corpus, defsByStem);

  it('语料文件数与 golden 一致(文件面 N/N)', () => {
    expect(computedFiles.length).toBe(golden.fileCount);
    expect(computedFiles.map(f => f.file)).toEqual(golden.files.map(f => f.file));
  });

  it('悬停总数与 golden 一致(悬停面 M/M)', () => {
    const computedCount = computed.length;
    const goldenCount = golden.files.reduce((sum, f) => sum + f.hovers.length, 0);
    expect(computedCount).toBe(goldenCount);
    expect(computedCount).toBe(golden.hoverCount);
  });

  it('逐文件逐悬停 hover 响应链逐字段一致(定位+签名+继承成员)', () => {
    // 按文件分组比对,失败信息落在具体文件上。
    const computedByFile = new Map(computedFiles.map(f => [f.file, f]));
    for (const goldenFile of golden.files) {
      expect(computedByFile.has(goldenFile.file), goldenFile.file).toBe(true);
      const expected = computeHovers(
        corpus.filter(c => c.file === goldenFile.file),
        defsByStem
      );
      expect(expected, goldenFile.file).toEqual(goldenFile.hovers);
    }
  });

  it('继承链面在语料上非空(demo-assets 三级链 + 成员展开)', () => {
    const chains = golden.files
      .flatMap(f => f.hovers)
      .map(h => h.hover.inherited)
      .filter((c): c is InheritedFace => c !== undefined);
    expect(chains.length).toBeGreaterThan(0);
    const nonEmpty = chains.filter(c => c.parentChain.length > 0);
    expect(nonEmpty.length).toBeGreaterThan(0);
    const withMembers = chains.filter(c => c.members.some(m => m.exists && m.properties.length > 0));
    expect(withMembers.length).toBeGreaterThan(0);
  });
});
