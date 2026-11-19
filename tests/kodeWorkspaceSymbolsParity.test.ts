// kode2 Phase2 WorkspaceSymbol 快速搜索对拍门禁(RUST-139 批 2):defParser
// 原语独立复算 Rust 侧 golden(crates/kode-server/tests/golden/
// workspace-symbols-parity.json)——root 集(entity 类 def)/effective 折叠
// 闭包(own → interfaces → parent,first-wins 去重)/组件槽独立面(槽名
// 去重,槽内再折叠)/前缀大小写不敏感 + trim/排序(rootName → symbolName
// → line)逐条重推,双向门禁。本文件只读 fixture 与 golden,不改 src/。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DefElementNode,
  getDirectChildElement,
  getDirectChildElements,
  getDirectChildElementsByName,
  getElementText,
  parseDefDocument
} from '../src/backend/defParser';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/workspace-symbols-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;

const cmpStr = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

// ---- 语料收集(signature-help 镜像同款) ------------------------------------

type Kind = 'def' | 'entities' | 'types' | 'alias';

interface CorpusFile {
  file: string;
  kind: Kind;
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
      const kind: Kind | null = entry.name.endsWith('.def')
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
  return out.sort((a, b) => cmpStr(a.file, b.file));
};

// ---- 语料视图(defsRoot / category;references 镜像同款) --------------------

const dirOf = (filePath: string): string | null => {
  const idx = filePath.lastIndexOf('/');
  return idx >= 0 ? filePath.slice(0, idx) : null;
};

interface Engine {
  corpusDefs: Set<string>;
  entitiesDirs: Set<string>;
  defFiles: Map<string, CorpusFile>;
}

const buildEngine = (corpus: CorpusFile[]): Engine => {
  const engine: Engine = { corpusDefs: new Set(), entitiesDirs: new Set(), defFiles: new Map() };
  for (const file of corpus) {
    if (file.kind === 'def') {
      engine.corpusDefs.add(file.file);
      engine.defFiles.set(file.file, file);
    }
    if (file.kind === 'entities') {
      const dir = dirOf(file.file);
      if (dir) {
        engine.entitiesDirs.add(dir);
      }
    }
  }
  return engine;
};

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

type Category = 'entity' | 'interface' | 'component';

const categoryOf = (defsRoot: string, defPath: string): Category => {
  if (!defPath.startsWith(`${defsRoot}/`)) {
    return 'entity';
  }
  const rel = defPath.slice(defsRoot.length + 1);
  if (rel.split('/').includes('interfaces')) {
    return 'interface';
  }
  if (rel.split('/').includes('components')) {
    return 'component';
  }
  return 'entity';
};

// ---- def 视图(顶层 Properties / 方法三段 / Interfaces / Parent / 组件) ---

const offsetToLine1 = (file: CorpusFile, offset: number): number => {
  let line = 0;
  for (let i = 0; i < offset && i < file.text.length; i += 1) {
    if (file.text[i] === '\n') {
      line += 1;
    }
  }
  return line + 1;
};

interface MirrorProperty {
  name: string;
  line: number;
  flags: string[];
}

const propertiesOf = (file: CorpusFile): MirrorProperty[] => {
  const root = file.parsed.root;
  if (!root) {
    return [];
  }
  const propsNode = getDirectChildElement(root, 'Properties');
  if (!propsNode) {
    return [];
  }
  return getDirectChildElements(propsNode).map(prop => {
    // parser "flags" | "clientflags" 双标签并入;`|` 分词,trim + 大写,保序去重。
    const tokens: string[] = [];
    for (const tag of ['Flags', 'ClientFlags']) {
      const node = getDirectChildElement(prop, tag);
      if (!node) {
        continue;
      }
      for (const token of getElementText(node).split('|')) {
        const normalized = token.trim().toUpperCase();
        if (normalized && !tokens.includes(normalized)) {
          tokens.push(normalized);
        }
      }
    }
    return { name: prop.name, line: offsetToLine1(file, prop.tagStart), flags: tokens };
  });
};

interface MirrorMethod {
  name: string;
  line: number;
  section: 'BaseMethods' | 'CellMethods' | 'ClientMethods';
}

const methodsOf = (file: CorpusFile): MirrorMethod[] => {
  const root = file.parsed.root;
  if (!root) {
    return [];
  }
  const out: MirrorMethod[] = [];
  const sections = ['BaseMethods', 'CellMethods', 'ClientMethods'] as const;
  for (const section of sections) {
    const node = getDirectChildElement(root, section);
    if (!node) {
      continue;
    }
    for (const method of getDirectChildElements(node)) {
      out.push({ name: method.name, line: offsetToLine1(file, method.tagStart), section });
    }
  }
  return out;
};

const childText = (node: DefElementNode, tag: string): string => {
  const child = getDirectChildElement(node, tag);
  return child ? getElementText(child).trim() : '';
};

const interfacesOf = (file: CorpusFile): string[] => {
  const root = file.parsed.root;
  if (!root) {
    return [];
  }
  const node = getDirectChildElement(root, 'Interfaces');
  if (!node) {
    return [];
  }
  // 语料口径:文本形态条目(parser KR-AUD-88 元素形态归 parser 面)。
  return getDirectChildElementsByName(node, 'interface')
    .map(node2 => getElementText(node2).trim())
    .filter(name => name.length > 0);
};

interface MirrorComponent {
  slot: string;
  type: string;
}

const componentsOf = (file: CorpusFile): MirrorComponent[] => {
  const root = file.parsed.root;
  if (!root) {
    return [];
  }
  const node = getDirectChildElement(root, 'Components');
  if (!node) {
    return [];
  }
  const out: MirrorComponent[] = [];
  for (const comp of getDirectChildElements(node)) {
    const type = childText(comp, 'Type');
    if (type) {
      out.push({ slot: comp.name, type });
    }
  }
  return out;
};

const parentOf = (file: CorpusFile): string => {
  const root = file.parsed.root;
  return root ? childText(root, 'Parent') : '';
};

// ---- 折叠闭包(own + interfaces + parent 链;接口不跟随 Parent) ------------

const foldPaths = (engine: Engine, startDef: string): string[] => {
  const defsRoot = defsRootFor(engine, startDef);
  if (!defsRoot) {
    return [startDef];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = startDef;
  while (current) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const file = engine.defFiles.get(current);
    if (!file) {
      break;
    }
    out.push(current);
    const category = categoryOf(defsRoot, current);
    for (const name of interfacesOf(file)) {
      const candidate = `${defsRoot}/interfaces/${name}.def`;
      if (engine.corpusDefs.has(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
    }
    // 接口 def 不跟随 Parent(引擎 loadInterfaces 口径)。
    if (category === 'interface') {
      break;
    }
    const parent = parentOf(file);
    if (!parent) {
      break;
    }
    const parentDir = category === 'component' ? `${defsRoot}/components` : defsRoot;
    const parentPath = `${parentDir}/${parent}.def`;
    if (!engine.corpusDefs.has(parentPath) || seen.has(parentPath)) {
      break;
    }
    current = parentPath;
  }
  return out;
};

const parentChain = (engine: Engine, startDef: string): string[] => {
  const defsRoot = defsRootFor(engine, startDef);
  if (!defsRoot) {
    return [startDef];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = startDef;
  while (current) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const file = engine.defFiles.get(current);
    if (!file) {
      break;
    }
    out.push(current);
    const category = categoryOf(defsRoot, current);
    if (category === 'interface') {
      break;
    }
    const parent = parentOf(file);
    if (!parent) {
      break;
    }
    const parentDir = category === 'component' ? `${defsRoot}/components` : defsRoot;
    const parentPath = `${parentDir}/${parent}.def`;
    if (!engine.corpusDefs.has(parentPath)) {
      break;
    }
    current = parentPath;
  }
  return out;
};

// ---- 组件槽面(local + parent 链 Components 段,槽名小写去重) --------------

const componentSlots = (engine: Engine, rootDef: string): { slot: string; defFile: string }[] => {
  const out: { slot: string; defFile: string }[] = [];
  const seenSlots = new Set<string>();
  for (const node of parentChain(engine, rootDef)) {
    const file = engine.defFiles.get(node);
    const defsRoot = defsRootFor(engine, node);
    if (!file || !defsRoot) {
      continue;
    }
    for (const comp of componentsOf(file)) {
      if (seenSlots.has(comp.slot.toLowerCase())) {
        continue;
      }
      seenSlots.add(comp.slot.toLowerCase());
      const candidate = `${defsRoot}/components/${comp.type}.def`;
      if (engine.corpusDefs.has(candidate)) {
        out.push({ slot: comp.slot, defFile: candidate });
      }
    }
  }
  return out;
};

// ---- 检索面(root 集 + 折叠去重 + 前缀 + 排序;Rust 同构) ------------------

interface SymbolHit {
  symbolName: string;
  kind: 'property' | 'method';
  section: 'BaseMethods' | 'CellMethods' | 'ClientMethods' | null;
  rootName: string;
  rootDefFile: string;
  defFile: string;
  line: number;
}

const pushFoldHits = (
  engine: Engine,
  hits: SymbolHit[],
  rootName: string,
  rootDefFile: string,
  startDef: string,
  needle: string
): void => {
  const seenProps = new Set<string>();
  const seenMethods = new Set<string>();
  for (const defPath of foldPaths(engine, startDef)) {
    const file = engine.defFiles.get(defPath);
    if (!file) {
      break;
    }
    for (const prop of propertiesOf(file)) {
      const key = `${prop.name}\u0001${[...prop.flags].sort().join('\u0002')}`;
      if (seenProps.has(key)) {
        continue;
      }
      seenProps.add(key);
      if (needle && !prop.name.toLowerCase().startsWith(needle)) {
        continue;
      }
      hits.push({
        symbolName: prop.name,
        kind: 'property',
        section: null,
        rootName,
        rootDefFile,
        defFile: defPath,
        line: prop.line
      });
    }
    for (const method of methodsOf(file)) {
      const key = `${method.section}\u0001${method.name}`;
      if (seenMethods.has(key)) {
        continue;
      }
      seenMethods.add(key);
      if (needle && !method.name.toLowerCase().startsWith(needle)) {
        continue;
      }
      hits.push({
        symbolName: method.name,
        kind: 'method',
        section: method.section,
        rootName,
        rootDefFile,
        defFile: defPath,
        line: method.line
      });
    }
  }
};

const workspaceSymbolRoots = (engine: Engine): { rootName: string; rootDefFile: string }[] => {
  const roots: { rootName: string; rootDefFile: string }[] = [];
  for (const defPath of [...engine.corpusDefs].sort(cmpStr)) {
    const defsRoot = defsRootFor(engine, defPath);
    if (!defsRoot || categoryOf(defsRoot, defPath) !== 'entity') {
      continue;
    }
    const base = defPath.slice(defPath.lastIndexOf('/') + 1);
    roots.push({ rootName: base.replace(/\.def$/, ''), rootDefFile: defPath });
  }
  return roots;
};

const workspaceSymbols = (engine: Engine, prefix: string): SymbolHit[] => {
  const needle = prefix.trim().toLowerCase();
  const hits: SymbolHit[] = [];
  for (const root of workspaceSymbolRoots(engine)) {
    pushFoldHits(engine, hits, root.rootName, root.rootDefFile, root.rootDefFile, needle);
    for (const slot of componentSlots(engine, root.rootDefFile)) {
      pushFoldHits(engine, hits, root.rootName, root.rootDefFile, slot.defFile, needle);
    }
  }
  hits.sort((a, b) =>
    cmpStr(a.rootName, b.rootName)
    || cmpStr(a.symbolName, b.symbolName)
    || a.line - b.line);
  return hits;
};

// ---- 探针派生(Rust derive_probes 同构) -----------------------------------

const deriveProbes = (universe: SymbolHit[]): string[] => {
  const names = [...new Set(universe.map(hit => hit.symbolName))].sort(cmpStr);
  const probes = new Set<string>(['', 'zz', 'qq']);
  for (const name of names) {
    probes.add(name);
    const head = [...name].slice(0, 2).join('');
    if (head.length === 2) {
      probes.add(head.toLowerCase());
      probes.add(head);
    }
  }
  return [...probes].sort(cmpStr);
};

// ---- 对拍 -------------------------------------------------------------------

interface GoldenHit {
  symbolName: string;
  kind: string;
  section: string | null;
  rootName: string;
  rootDefFile: string;
  defFile: string;
  line: number;
}

describe('kode2 Phase2 WorkspaceSymbol 快速搜索对拍(Rust golden ↔ defParser 复算)', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const corpus = collectCorpus();
  const engine = buildEngine(corpus);
  const universe = workspaceSymbols(engine, '');
  const derivedProbes = deriveProbes(universe);

  it('golden 计数锚(rootCount/probeCount/symbolCount/universeCount + 探针集同派生)', () => {
    expect(golden.rootCount).toBe(workspaceSymbolRoots(engine).length);
    expect(golden.symbolCount).toBe(new Set(universe.map(h => h.symbolName)).size);
    expect(golden.universeCount).toBe(universe.length);
    expect(golden.probeCount).toBe(derivedProbes.length);
    expect(golden.probes.map((p: { prefix: string }) => p.prefix)).toEqual(derivedProbes);
  });

  it('全集(空前缀)复算深等', () => {
    const goldenUniverse = golden.probes.find((p: { prefix: string }) => p.prefix === '').hits;
    expect(goldenUniverse).toEqual(universe);
  });

  it('逐探针复算深等(81 探针全量;前缀口径 + 排序面全链重推)', () => {
    let hitTotal = 0;
    expect(golden.probes.length).toBe(derivedProbes.length);
    for (let i = 0; i < golden.probes.length; i += 1) {
      const goldenProbe = golden.probes[i];
      const recomputed = workspaceSymbols(engine, goldenProbe.prefix);
      expect(goldenProbe.hits).toEqual(recomputed);
      hitTotal += recomputed.length;
    }
    expect(golden.hitCount).toBe(hitTotal);
  });

  it('护栏:落点在语料 + root 恒实体 + kind/段值域 + 负例真空 + 折叠真分布', () => {
    const sections = new Set(['BaseMethods', 'CellMethods', 'ClientMethods']);
    for (const probe of golden.probes) {
      const needle = probe.prefix.trim().toLowerCase();
      for (const hit of probe.hits as GoldenHit[]) {
        expect(engine.corpusDefs.has(hit.defFile)).toBe(true);
        expect(engine.corpusDefs.has(hit.rootDefFile)).toBe(true);
        expect(hit.rootDefFile.includes('/interfaces/')).toBe(false);
        expect(hit.rootDefFile.includes('/components/')).toBe(false);
        expect(hit.line).toBeGreaterThanOrEqual(1);
        expect(needle === '' || hit.symbolName.toLowerCase().startsWith(needle)).toBe(true);
        if (hit.kind === 'property') {
          expect(hit.section).toBeNull();
        } else if (hit.kind === 'method') {
          expect(sections.has(hit.section as string)).toBe(true);
        } else {
          throw new Error(`kind 越界: ${hit.kind}`);
        }
      }
      const hits = probe.hits as GoldenHit[];
      for (let i = 1; i < hits.length; i += 1) {
        const keyA = [hits[i - 1].rootName, hits[i - 1].symbolName, hits[i - 1].line];
        const keyB = [hits[i].rootName, hits[i].symbolName, hits[i].line];
        expect(cmpStr(keyA[0] as string, keyB[0] as string)
          || cmpStr(keyA[1] as string, keyB[1] as string)
          || (keyA[2] as number) - (keyB[2] as number)).toBeLessThanOrEqual(0);
      }
    }
    // 负例真空 + 区分度真分布:接口折入/组件槽/父链折叠命中在语料上在场。
    const universeHits = golden.probes.find((p: { prefix: string }) => p.prefix === '').hits as GoldenHit[];
    expect(golden.probes.filter((p: { hits: GoldenHit[] }) => p.hits.length === 0).length).toBeGreaterThan(0);
    expect(universeHits.some(h => h.defFile.includes('/interfaces/'))).toBe(true);
    expect(universeHits.some(h => h.defFile.includes('/components/'))).toBe(true);
    expect(
      universeHits.some(h => h.defFile !== h.rootDefFile
        && !h.defFile.includes('/interfaces/')
        && !h.defFile.includes('/components/'))
    ).toBe(true);
    expect(universeHits.length).toBeGreaterThan(0);
  });
});
