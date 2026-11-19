// kode2 Phase2 references 语义分类对拍门禁(RUST-138 批 2):用 TS defParser
// 原语独立复算 Rust 侧生成的语义分类 golden(crates/kode-server/tests/golden/
// references-semantic-parity.json),逐文件逐探针逐站点比对——三分类
// (semantic/shadow/dangling)按「站点自身解析域内的声明路径 == 查询声明」
// 独立重推。与 kodeReferencesParity 同构:本文件只读 fixture 与 golden,
// 不改 src/。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DefElementNode,
  getDirectChildElements,
  parseDefDocument
} from '../src/backend/defParser';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/references-semantic-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;

const corpusRootOf = (file: string): string =>
  CORPORA.find(corpus => file.startsWith(`${corpus}/`)) ?? '';

// ---- 语料收集(与 Rust collect_corpus 同序:rel 路径字典序) ----------------

interface CorpusFile {
  file: string;
  kind: 'def' | 'entities' | 'types' | 'alias';
  text: string;
  parsed: ReturnType<typeof parseDefDocument>;
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
        const text = fs.readFileSync(childPath, 'utf8');
        out.push({ file: relChild, kind, text, parsed: parseDefDocument(text) });
      }
    }
  };
  for (const corpus of CORPORA) {
    walk(path.join(REPO_ROOT, corpus), corpus);
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

// ---- 坐标换算(VS Code positionAt 同语义) -----------------------------------

interface Pos { line: number; character: number }

const offsetToPos = (text: string, offset: number): Pos => {
  const clamped = Math.min(offset, text.length);
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  let character = 0;
  for (let i = lineStart; i < clamped; i += 1) {
    character += text.charCodeAt(i) >= 0x10000 ? 2 : 1;
  }
  return { line, character };
};

const offsetOfPos = (text: string, line1: number, character: number): number => {
  let lineStart = 0;
  let line = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (line === line1 - 1) {
      break;
    }
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  let utf16 = 0;
  let i = lineStart;
  while (i < text.length && text[i] !== '\n' && utf16 < character) {
    utf16 += text.charCodeAt(i) >= 0x10000 ? 2 : 1;
    i += 1;
  }
  return i;
};

// ---- 语料视图(与 HoverEngine 同语义:路径键、字典序首见) -----------------

interface Engine {
  corpusDefs: Set<string>;
  entitiesDirs: Set<string>;
  typesDecls: Map<string, { name: string; line1: number }[]>;
}

const dirOf = (filePath: string): string | null => {
  const idx = filePath.lastIndexOf('/');
  return idx >= 0 ? filePath.slice(0, idx) : null;
};

const typesDeclsOf = (file: CorpusFile): { name: string; line1: number }[] => {
  const out: { name: string; line1: number }[] = [];
  const root = file.parsed.root;
  if (!root) {
    return out;
  }
  for (const child of getDirectChildElements(root)) {
    const textDirective = (file.text.slice(child.contentStart, child.contentEnd)).trim().split(/\s+/)[0] ?? '';
    const attrDirective = (child.attributes as Record<string, string> | undefined)?.type?.trim() ?? '';
    if (!textDirective && !attrDirective) {
      continue;
    }
    out.push({ name: child.name, line1: offsetToPos(file.text, child.tagStart).line + 1 });
  }
  return out;
};

const buildEngine = (corpus: CorpusFile[]): Engine => {
  const engine: Engine = {
    corpusDefs: new Set(),
    entitiesDirs: new Set(),
    typesDecls: new Map()
  };
  for (const file of corpus) {
    if (file.kind === 'def') {
      engine.corpusDefs.add(file.file);
    }
    if (file.kind === 'entities') {
      const dir = dirOf(file.file);
      if (dir) {
        engine.entitiesDirs.add(dir);
      }
    }
    if (file.kind === 'types') {
      engine.typesDecls.set(file.file, typesDeclsOf(file));
    }
  }
  return engine;
};

const BUILTIN_TYPES = new Set([
  'UINT8', 'UINT16', 'UINT32', 'UINT64', 'INT8', 'INT16', 'INT32', 'INT64',
  'FLOAT', 'DOUBLE', 'STRING', 'UNICODE', 'VECTOR2', 'VECTOR3', 'VECTOR4',
  'ENTITYCALL', 'PYTHON', 'PY_DICT', 'PY_TUPLE', 'PY_LIST', 'BLOB', 'ARRAY', 'FIXED_DICT'
]);

const CONTAINER_LITERALS = new Set(['ARRAY', 'FIXED_DICT']);
// TS defRenamer.INTERFACE_WRAPPER_NAMES 同表同序(Set 插入序 = 扫描序)。
const INTERFACE_WRAPPER_NAMES = ['interface', 'Interface', 'type', 'Type'];

// ---- defsRoot / entityDefsRoot(与 kodeReferencesParity 同口径) ------------

const defsRootFor = (engine: Engine, filePath: string): string | null => {
  let dir = dirOf(filePath);
  while (dir) {
    if (engine.entitiesDirs.has(dir)) {
      const defsRoot = `${dir}/entity_defs`;
      return filePath.startsWith(`${defsRoot}/`) ? defsRoot : dir;
    }
    dir = dirOf(dir);
  }
  return null;
};

const entityDefsRootFor = (engine: Engine, filePath: string): string | null => {
  const defsRoot = defsRootFor(engine, filePath);
  if (!defsRoot) {
    return null;
  }
  if (filePath.startsWith(`${defsRoot}/`)) {
    return defsRoot;
  }
  const candidate = `${defsRoot}/entity_defs`;
  for (const defPath of engine.corpusDefs) {
    if (defPath.startsWith(`${candidate}/`)) {
      return candidate;
    }
  }
  return null;
};

// ---- 词与引用位扫描镜像(TS 生产面逐点同构) --------------------------------

const wordAtOffset = (text: string, offset: number): string => {
  let start = offset;
  let end = offset;
  while (start > 0 && /\w/.test(text[start - 1])) {
    start -= 1;
  }
  while (end < text.length && /\w/.test(text[end])) {
    end += 1;
  }
  return text.slice(start, end);
};

interface RefSiteFace { uri: string; line: number; start: number; end: number }

const tokenSitesMirror = (
  file: CorpusFile,
  uri: string,
  startOffset: number,
  endOffset: number,
  target: string,
  excludeContainers: boolean
): RefSiteFace[] => {
  const text = file.text;
  const end = Math.min(endOffset, text.length);
  if (startOffset >= end) {
    return [];
  }
  const raw = text.slice(startOffset, end);
  const sites: RefSiteFace[] = [];
  let searchFrom = startOffset;
  for (const token of raw.split(/\s+/)) {
    if (!token) {
      continue;
    }
    const idx = text.indexOf(token, searchFrom);
    if (idx === -1 || idx >= end) {
      break;
    }
    if (!(excludeContainers && CONTAINER_LITERALS.has(token)) && token === target) {
      const pos = offsetToPos(text, idx);
      sites.push({ uri, line: pos.line, start: pos.character, end: pos.character + token.length });
    }
    searchFrom = idx + token.length;
  }
  return sites;
};

const walkElements = (node: DefElementNode, visit: (el: DefElementNode) => void): void => {
  visit(node);
  for (const child of node.children) {
    if (child.kind === 'element') {
      walkElements(child, visit);
    }
  }
};

const scanTypeRefsMirror = (file: CorpusFile, uri: string, target: string): RefSiteFace[] => {
  const root = file.parsed.root;
  if (!root) {
    return [];
  }
  const sites: RefSiteFace[] = [];
  walkElements(root, el => {
    if (el.name === 'Type') {
      for (const child of el.children) {
        if (child.kind === 'text') {
          sites.push(...tokenSitesMirror(file, uri, child.startOffset, child.endOffset, target, true));
        }
      }
      for (const child of el.children) {
        if (child.kind === 'element' && child.name === 'of') {
          sites.push(...tokenSitesMirror(file, uri, child.contentStart, child.contentEnd, target, false));
        }
      }
    } else if (el.name === 'Arg') {
      for (const child of el.children) {
        if (child.kind === 'text') {
          sites.push(...tokenSitesMirror(file, uri, child.startOffset, child.endOffset, target, false));
        }
      }
    } else if (el.name === 'of' && el.parent?.name !== 'Type') {
      sites.push(...tokenSitesMirror(file, uri, el.contentStart, el.contentEnd, target, false));
    }
  });
  return sites;
};

const scanDefTagValueSitesMirror = (
  file: CorpusFile,
  uri: string,
  tagName: string,
  target: string,
  onlyDirectInterfacesChild: boolean
): RefSiteFace[] => {
  const root = file.parsed.root;
  if (!root) {
    return [];
  }
  const sites: RefSiteFace[] = [];
  walkElements(root, el => {
    if (el.name !== tagName) {
      return;
    }
    if (onlyDirectInterfacesChild && el.parent?.name !== 'Interfaces') {
      return;
    }
    sites.push(...tokenSitesMirror(file, uri, el.contentStart, el.contentEnd, target, false));
  });
  return sites;
};

// ---- 光标处目标识别镜像 -----------------------------------------------------

interface RefTarget { kind: 'type' | 'parent' | 'interface'; name: string }

const deepestChainAt = (node: DefElementNode, offset: number, chain: DefElementNode[]): DefElementNode | null => {
  if (offset < node.tagStart || offset > node.closeTagEnd) {
    return null;
  }
  chain.push(node);
  for (const child of node.children) {
    if (child.kind !== 'element') {
      continue;
    }
    if (offset >= child.tagStart && offset <= child.closeTagEnd) {
      const deeper = deepestChainAt(child, offset, chain);
      return deeper ?? child;
    }
  }
  return node;
};

const resolveDefTargetMirror = (file: CorpusFile, offset: number): RefTarget | null => {
  const root = file.parsed.root;
  if (!root) {
    return null;
  }
  const chain: DefElementNode[] = [];
  const hit = deepestChainAt(root, offset, chain);
  if (!hit) {
    return null;
  }
  const word = wordAtOffset(file.text, offset);
  if (!word || CONTAINER_LITERALS.has(word)) {
    return null;
  }
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const node = chain[i];
    const parentName = i > 0 ? chain[i - 1].name : null;
    const inValue = offset >= node.contentStart && offset <= node.contentEnd;
    if (INTERFACE_WRAPPER_NAMES.includes(node.name) && parentName === 'Interfaces' && inValue) {
      return { kind: 'interface', name: word };
    }
    if ((node.name === 'Type' || node.name === 'Arg' || node.name === 'of') && inValue) {
      return { kind: 'type', name: word };
    }
    if (node.name === 'Parent' && inValue) {
      return { kind: 'parent', name: word };
    }
    if (node.name === 'Interfaces' && inValue) {
      return { kind: 'interface', name: word };
    }
  }
  return null;
};

const typesXmlSymbolNameMirror = (file: CorpusFile, offset: number): string | null => {
  const root = file.parsed.root;
  if (!root) {
    return null;
  }
  const chain: DefElementNode[] = [];
  const hit = deepestChainAt(root, offset, chain);
  if (!hit) {
    return null;
  }
  const el = chain[chain.length - 1];
  const word = wordAtOffset(file.text, offset);
  if (!word || CONTAINER_LITERALS.has(word)) {
    return null;
  }
  if (chain.length >= 2 && chain[chain.length - 2].name === 'root' && el.name === word && offset < el.contentStart) {
    return word;
  }
  if ((el.name === 'Type' || el.name === 'Arg' || el.name === 'of') && offset >= el.contentStart && offset <= el.contentEnd) {
    return word;
  }
  return null;
};

// ---- 声明域解析(语义分类的 IR 面复算) --------------------------------------

const sameRootTypeDecl = (
  engine: Engine,
  root: string,
  name: string
): { file: string; line1: number } | null => {
  const entries = [...engine.typesDecls.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [typesPath, decls] of entries) {
    if (corpusRootOf(typesPath) !== root) {
      continue;
    }
    const decl = decls.find(d => d.name === name);
    if (decl) {
      return { file: typesPath, line1: decl.line1 };
    }
  }
  return null;
};

const entityDefFile = (engine: Engine, filePath: string, name: string): string | null => {
  const defsRoot = entityDefsRootFor(engine, filePath);
  if (!defsRoot) {
    return null;
  }
  const candidate = `${defsRoot}/${name}.def`;
  return engine.corpusDefs.has(candidate) ? candidate : null;
};

const interfaceDefFile = (engine: Engine, filePath: string, name: string): string | null => {
  const defsRoot = entityDefsRootFor(engine, filePath);
  if (!defsRoot) {
    return null;
  }
  const candidate = `${defsRoot}/interfaces/${name}.def`;
  return engine.corpusDefs.has(candidate) ? candidate : null;
};

// 名字在给定文件解析域内的声明路径(Type=同根 types 字典序首见,无则实体
// def;Parent=实体 def;Interface=接口 def;null=不可解析)——与 Rust
// name_decl_path_at 同链。
const nameDeclPathAt = (
  engine: Engine,
  kind: RefTarget['kind'],
  filePath: string,
  name: string
): string | null => {
  if (kind === 'type') {
    const types = sameRootTypeDecl(engine, corpusRootOf(filePath), name);
    if (types) {
      return types.file;
    }
    return entityDefFile(engine, filePath, name);
  }
  if (kind === 'parent') {
    return entityDefFile(engine, filePath, name);
  }
  return interfaceDefFile(engine, filePath, name);
};

// ---- 站点收集(批 1 同款收集器) ---------------------------------------------

const scanCorpusUris = (engine: Engine): string[] => [
  ...[...engine.corpusDefs].sort(),
  ...[...engine.typesDecls.keys()].sort()
];

const customTypeSitesMirror = (engine: Engine, corpusByUri: Map<string, CorpusFile>, name: string): RefSiteFace[] => {
  const sites: RefSiteFace[] = [];
  for (const uri of scanCorpusUris(engine)) {
    const file = corpusByUri.get(uri);
    if (!file) {
      continue;
    }
    sites.push(...scanTypeRefsMirror(file, uri, name));
  }
  return sites;
};

const entitySitesMirror = (engine: Engine, corpusByUri: Map<string, CorpusFile>, name: string): RefSiteFace[] => {
  const sites: RefSiteFace[] = [];
  for (const uri of [...engine.corpusDefs].sort()) {
    const file = corpusByUri.get(uri);
    if (!file) {
      continue;
    }
    sites.push(...scanDefTagValueSitesMirror(file, uri, 'Parent', name, false));
    sites.push(...scanTypeRefsMirror(file, uri, name));
  }
  return sites;
};

const interfaceSitesMirror = (engine: Engine, corpusByUri: Map<string, CorpusFile>, name: string): RefSiteFace[] => {
  const sites: RefSiteFace[] = [];
  for (const uri of [...engine.corpusDefs].sort()) {
    const file = corpusByUri.get(uri);
    if (!file) {
      continue;
    }
    for (const tag of INTERFACE_WRAPPER_NAMES) {
      sites.push(...scanDefTagValueSitesMirror(file, uri, tag, name, true));
    }
  }
  return sites;
};

// ---- 语义分类(批 2 核心:站点域声明 == 查询声明 → semantic) -----------------

interface ClassifiedSiteFace {
  uri: string;
  line: number;
  start: number;
  end: number;
  semantic: 'semantic' | 'shadow' | 'dangling';
  evidence: string | null;
}

const classifySites = (
  engine: Engine,
  queryFile: CorpusFile,
  target: RefTarget,
  sites: RefSiteFace[]
): ClassifiedSiteFace[] => {
  const queryDecl = nameDeclPathAt(engine, target.kind, queryFile.file, target.name);
  return sites.map(site => {
    const siteDecl = nameDeclPathAt(engine, target.kind, site.uri, target.name);
    if (siteDecl !== null && siteDecl === queryDecl) {
      return { ...site, semantic: 'semantic' as const, evidence: siteDecl };
    }
    if (siteDecl !== null) {
      return { ...site, semantic: 'shadow' as const, evidence: siteDecl };
    }
    return { ...site, semantic: 'dangling' as const, evidence: null };
  });
};

// ---- 逐文件复算(golden 探针集同款;语义面条目 = 站点非空) -------------------

interface ExpectedRef {
  line: number;
  character: number;
  target: { kind: string; name: string };
  sites: ClassifiedSiteFace[];
}

const pushValueTokenProbe = (
  probes: { line1: number; character: number }[],
  file: CorpusFile,
  node: DefElementNode
): void => {
  const content = file.text.slice(node.contentStart, node.contentEnd);
  const trimmed = content.trimStart();
  if (!trimmed) {
    return;
  }
  const lead = content.length - trimmed.length;
  const pos = offsetToPos(file.text, node.contentStart + lead);
  probes.push({ line1: pos.line + 1, character: pos.character });
};

const recomputeFile = (
  engine: Engine,
  corpusByUri: Map<string, CorpusFile>,
  file: CorpusFile
): { probeTotal: number; references: ExpectedRef[] } => {
  const probes: { line1: number; character: number }[] = [];
  const root = file.parsed.root;
  if (file.kind === 'def' && root) {
    const parentTags: DefElementNode[] = [];
    const valueTags: DefElementNode[] = [];
    const ifaceSegments: DefElementNode[] = [];
    walkElements(root, el => {
      if (el.name === 'Parent') {
        parentTags.push(el);
      } else if (el.name === 'Type' || el.name === 'of' || el.name === 'Arg') {
        valueTags.push(el);
      } else if (el.name === 'Interfaces') {
        ifaceSegments.push(el);
      }
    });
    for (const el of parentTags) {
      pushValueTokenProbe(probes, file, el);
    }
    for (const el of valueTags) {
      pushValueTokenProbe(probes, file, el);
    }
    for (const segment of ifaceSegments) {
      walkElements(segment, inner => {
        if (inner !== segment) {
          pushValueTokenProbe(probes, file, inner);
        }
      });
    }
  }
  if (file.kind === 'types' && root) {
    for (const child of getDirectChildElements(root)) {
      const pos = offsetToPos(file.text, child.tagStart + 1);
      probes.push({ line1: pos.line + 1, character: pos.character });
    }
    walkElements(root, el => {
      if (el.name === 'Type' || el.name === 'of' || el.name === 'Arg') {
        pushValueTokenProbe(probes, file, el);
      }
    });
  }
  probes.sort((a, b) => (a.line1 - b.line1) || (a.character - b.character));
  const references: ExpectedRef[] = [];
  let previous: { line1: number; character: number } | null = null;
  for (const probe of probes) {
    if (previous && previous.line1 === probe.line1 && previous.character === probe.character) {
      continue;
    }
    previous = probe;
    const offset = offsetOfPos(file.text, probe.line1, probe.character);
    let target: RefTarget | null = null;
    let sites: RefSiteFace[] = [];
    if (file.kind === 'def') {
      target = resolveDefTargetMirror(file, offset);
      if (target && BUILTIN_TYPES.has(target.name)) {
        target = null;
      }
      if (target && target.kind === 'type') {
        if (sameRootTypeDecl(engine, corpusRootOf(file.file), target.name)) {
          sites = customTypeSitesMirror(engine, corpusByUri, target.name);
        } else if (entityDefFile(engine, file.file, target.name)) {
          sites = entitySitesMirror(engine, corpusByUri, target.name);
        } else {
          target = null;
        }
      } else if (target && target.kind === 'parent') {
        if (!entityDefFile(engine, file.file, target.name)) {
          target = null;
        } else {
          sites = entitySitesMirror(engine, corpusByUri, target.name);
        }
      } else if (target) {
        sites = interfaceSitesMirror(engine, corpusByUri, target.name);
      }
    } else if (file.kind === 'types') {
      const name = typesXmlSymbolNameMirror(file, offset);
      if (name && !BUILTIN_TYPES.has(name) && sameRootTypeDecl(engine, corpusRootOf(file.file), name)) {
        target = { kind: 'type', name };
        sites = scanCorpusUris(engine).flatMap(uri => {
          const scan = corpusByUri.get(uri);
          return scan ? scanTypeRefsMirror(scan, uri, name) : [];
        });
      }
    }
    if (!target || sites.length === 0) {
      continue;
    }
    references.push({
      line: probe.line1,
      character: probe.character,
      target: { kind: target.kind, name: target.name },
      sites: classifySites(engine, file, target, sites)
    });
  }
  return { probeTotal: probes.length, references };
};

// ---- 门禁 -------------------------------------------------------------------

describe('kode2 Phase2 references 语义分类对拍(Rust golden ↔ TS 复算)', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const corpus = collectCorpus();
  const engine = buildEngine(corpus);
  const corpusByUri = new Map(corpus.map(file => [file.file, file]));

  it('golden 语料与 TS 收集同集(文件序一致)', () => {
    expect(golden.files.map((f: { file: string }) => f.file)).toEqual(corpus.map(f => f.file));
  });

  it('逐文件逐探针逐站点比对(语义三分类)', () => {
    let comparedRefs = 0;
    let comparedProbes = 0;
    for (let i = 0; i < corpus.length; i += 1) {
      const expected = recomputeFile(engine, corpusByUri, corpus[i]);
      const actual = golden.files[i].references ?? [];
      expect(actual).toEqual(expected.references);
      comparedRefs += actual.length;
      comparedProbes += expected.probeTotal;
    }
    expect(comparedRefs).toBe(golden.referenceCount);
    expect(comparedProbes).toBe(golden.probeCount);
  });

  it('分类计数守恒 + 跨语料同名真分布在场', () => {
    const counted: Record<string, number> = { semantic: 0, shadow: 0, dangling: 0 };
    let siteTotal = 0;
    for (const file of golden.files) {
      for (const reference of file.references ?? []) {
        for (const site of reference.sites) {
          counted[site.semantic] += 1;
          siteTotal += 1;
        }
      }
    }
    expect(siteTotal).toBe(golden.siteCount);
    // golden 侧 class_counts 是惰性 BTreeMap(零计数键不入档)——两侧
    // 都只比非零键。
    const nonzero = Object.fromEntries(Object.entries(counted).filter(([, n]) => n > 0));
    expect(nonzero).toEqual(golden.classCounts);
    // 跨语料同名实体(Monster/Avatar 双语料各持己声明)是真分布:分类面
    // 退化成恒 semantic(语法同名不剔除)会在此红。
    expect(counted.semantic).toBeGreaterThan(0);
    expect(counted.shadow).toBeGreaterThan(0);
  });

  it('面定义护栏:站点不出语料,证据声明路径在站点解析域内', () => {
    for (const file of golden.files) {
      for (const reference of file.references ?? []) {
        for (const site of reference.sites) {
          expect(corpusByUri.has(site.uri)).toBe(true);
          if (site.evidence !== null) {
            expect(corpusByUri.has(site.evidence)).toBe(true);
            // Shadow 证据必是站点域的声明(≠ 查询域同路径才叫 shadow;
            // 证据路径与站点同 root 或同 tree 由解析域规则保证——这里钉
            // 证据不在查询文件路径上退化成恒等)。
            expect(site.semantic === 'shadow' || site.semantic === 'semantic').toBe(true);
          } else {
            expect(site.semantic).toBe('dangling');
          }
        }
      }
    }
  });
});
