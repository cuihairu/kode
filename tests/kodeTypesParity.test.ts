// kode2 PR-008 对拍门禁:用 TS 现有 defParser/compositionRoots 原语复算 Rust 侧
// 生成的类型面 golden(crates/kode-types/tests/golden/type-parity.json),
// 逐文件 + 图级(分类/别名链/继承链/全图环)比对(本文件只读 fixture 与
// golden,不改 src/,对拍语义 = 双实现同输入同类型面)。与 kodeIndexParity 同构。
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
import { parseDefComposition, parseTypesXml } from '../src/compositionRoots';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-types/tests/golden/type-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;

// 与 Rust builtin::BUILTIN_TYPES 同一清单(engine DataTypes 注册名;databaseSchema 同源)。
const BUILTIN_TYPES = new Set([
  'INT8', 'INT16', 'INT32', 'INT64', 'UINT8', 'UINT16', 'UINT32', 'UINT64',
  'FLOAT', 'DOUBLE', 'STRING', 'UNICODE', 'PYTHON', 'PY_DICT', 'PY_TUPLE', 'PY_LIST',
  'BLOB', 'ENTITYCALL', 'VECTOR2', 'VECTOR3', 'VECTOR4'
]);
const CONTAINER_DIRECTIVES = new Set(['ARRAY', 'FIXED_DICT']);

// ---- golden ----

interface GoldenDecl {
  name: string;
  kind: 'fixedDict' | 'array' | 'builtin';
  implementedBySymbol: string | null;
  fieldRefs: string[];
  elementRef: string | null;
}
interface GoldenAlias {
  name: string;
  aliasType: string;
}
interface GoldenComposition {
  parent: string | null;
  interfaces: string[];
  components: string[];
  fieldTypes: string[];
}
interface GoldenFile {
  file: string;
  kind: 'def' | 'entities' | 'types' | 'alias';
  decls?: GoldenDecl[];
  aliases?: GoldenAlias[];
  composition?: GoldenComposition;
  entities?: string[];
}
interface ChainRecord {
  name?: string;
  entity?: string;
  status: 'resolved' | 'cycle' | 'unknown' | 'missing';
  chain: string[];
}
interface GoldenGraph {
  classifications: Array<{ name: string; class: string }>;
  aliasChains: ChainRecord[];
  inheritanceChains: ChainRecord[];
  cycles: string[][];
}
interface Golden {
  fileCount: number;
  typeNodeCount: number;
  files: GoldenFile[];
  graph: GoldenGraph;
}

const loadGolden = (): Golden => JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

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

const firstTextToken = (node: DefElementNode): string | undefined => {
  const token = getElementText(node).trim().split(/\s+/)[0];
  return token ? token : undefined;
};

const directTextTokens = (node: DefElementNode): string[] =>
  node.children
    .filter(c => !isElementNode(c))
    .map(c => ('text' in c ? c.text.trim() : ''))
    .filter(Boolean);

const defEntityName = (file: string): string =>
  path.basename(file).replace(/\.def$/i, '');

// ---- 图模型(TS 复算侧;与 kode_types::graph 同口径,首写优先) ----

type NodeKind = 'alias' | 'array' | 'fixedDict' | 'entity';
interface GraphNode {
  kind: NodeKind;
  target?: string;
  element?: string | null;
  fieldRefs?: string[];
}
type EdgeKind = 'alias_target' | 'array_element' | 'field' | 'type_ref' | 'component_of' | 'inherits';
interface Edge {
  from: string;
  kind: EdgeKind;
  to: string;
}

interface ComputedSurface {
  fileCount: number;
  typeNodeCount: number;
  files: GoldenFile[];
  graph: GoldenGraph;
}

const computeTypeSurface = (): ComputedSurface => {
  const corpus = collectCorpus();
  const nodes = new Map<string, GraphNode>();
  const edges: Edge[] = [];
  const entityParents = new Map<string, string>();
  const registered = new Set<string>();
  const files: GoldenFile[] = [];

  const putNode = (name: string, node: GraphNode): boolean => {
    if (nodes.has(name)) {
      return false;
    }
    nodes.set(name, node);
    return true;
  };

  for (const { file, kind, text } of corpus) {
    if (kind === 'def') {
      const composition = parseDefComposition(text);
      const name = defEntityName(file);
      files.push({ file, kind, composition: composition ?? { parent: null, interfaces: [], components: [], fieldTypes: [] } });
      if (composition && putNode(name, { kind: 'entity' })) {
        if (composition.parent) {
          if (!entityParents.has(name)) {
            entityParents.set(name, composition.parent);
          }
          edges.push({ from: name, kind: 'inherits', to: composition.parent });
        }
        for (const comp of composition.components) {
          edges.push({ from: name, kind: 'component_of', to: comp });
        }
        for (const ref of composition.fieldTypes) {
          edges.push({ from: name, kind: 'type_ref', to: ref });
        }
      }
    } else if (kind === 'entities') {
      const document = parseDefDocument(text);
      const names: string[] = [];
      if (document.root) {
        for (const node of getDirectChildElements(document.root)) {
          if (node.name === 'root') {
            continue; // root 伪条目排除(与 Rust parse_entities 同口径)
          }
          names.push(node.name);
          registered.add(node.name);
        }
      }
      files.push({ file, kind, entities: names });
    } else if (kind === 'types') {
      const table = parseTypesXml(text);
      const decls: GoldenDecl[] = [...table.entries()].map(([name, decl]) => ({
        name,
        kind: decl.kind,
        implementedBySymbol: decl.implementedBySymbol,
        fieldRefs: decl.fieldRefs,
        elementRef: decl.elementRef
      }));
      files.push({ file, kind, decls });
      // graph 节点:directive 需从原文重取(types 表的 builtin 条目 = 重定向)。
      const document = parseDefDocument(text);
      if (document.root) {
        for (const item of getDirectChildElements(document.root)) {
          const directive = firstTextToken(item);
          if (!directive) {
            continue; // 空条目/属性式不产声明(与 parseTypesXml 同口径)
          }
          if (directive === 'FIXED_DICT') {
            const decl = table.get(item.name);
            if (putNode(item.name, { kind: 'fixedDict', fieldRefs: decl?.fieldRefs ?? [] })) {
              for (const ref of decl?.fieldRefs ?? []) {
                edges.push({ from: item.name, kind: 'field', to: ref });
              }
            }
          } else if (directive === 'ARRAY') {
            const decl = table.get(item.name);
            if (putNode(item.name, { kind: 'array', element: decl?.elementRef ?? null })) {
              if (decl?.elementRef) {
                edges.push({ from: item.name, kind: 'array_element', to: decl.elementRef });
              }
            }
          } else if (putNode(item.name, { kind: 'alias', target: directive })) {
            edges.push({ from: item.name, kind: 'alias_target', to: directive });
          }
        }
      }
    } else {
      // alias.xml:与 Rust parse_alias/TS buildAliasXmlCustomTypeInfo 同口径。
      const document = parseDefDocument(text);
      const aliases: GoldenAlias[] = [];
      if (document.root) {
        for (const node of getDirectChildElements(document.root)) {
          const typeChild = getDirectChildElement(node, 'Type');
          const otherChild = getDirectChildElements(node).find(n => n.name !== 'Type');
          const texts = directTextTokens(node);
          if (!typeChild && !otherChild && texts.length === 0) {
            continue; // 属性式跳过(结构化保留,Rust 侧不进图)
          }
          const aliasType = typeChild
            ? directTextTokens(typeChild)[0] ?? 'ALIAS'
            : otherChild
              ? otherChild.name
              : texts[0] ?? 'ALIAS';
          aliases.push({ name: node.name, aliasType });
          if (putNode(node.name, { kind: 'alias', target: aliasType })) {
            edges.push({ from: node.name, kind: 'alias_target', to: aliasType });
          }
        }
      }
      files.push({ file, kind, aliases });
    }
  }

  // ---- 图级求值(与 Rust graph.rs 同算法) ----

  const knownTerminal = (name: string): boolean =>
    BUILTIN_TYPES.has(name) || CONTAINER_DIRECTIVES.has(name) || nodes.has(name) || registered.has(name);

  const knownEntity = (name: string): boolean =>
    entityParents.has(name) || registered.has(name) || nodes.get(name)?.kind === 'entity';

  const resolveAliasChain = (name: string): ChainRecord => {
    const chain = [name];
    const seen = new Set([name]);
    let cycle = false;
    let current = name;
    for (;;) {
      const node = nodes.get(current);
      if (!node || node.kind !== 'alias' || !node.target) {
        break;
      }
      const target = node.target;
      if (seen.has(target)) {
        cycle = true;
        break;
      }
      chain.push(target);
      seen.add(target);
      current = target;
    }
    const status = cycle ? 'cycle' : knownTerminal(current) ? 'resolved' : 'unknown';
    return { name, status, chain };
  };

  const resolveInheritance = (entity: string): ChainRecord => {
    const chain = [entity];
    const seen = new Set([entity]);
    let status: ChainRecord['status'] = 'resolved';
    let current = entity;
    while (entityParents.has(current)) {
      const parent = entityParents.get(current) as string;
      if (seen.has(parent)) {
        status = 'cycle';
        break;
      }
      chain.push(parent);
      seen.add(parent);
      if (!knownEntity(parent)) {
        status = 'missing';
        break;
      }
      current = parent;
    }
    return { entity, status, chain };
  };

  // 全图环:迭代三色 DFS,回边报告环路径,结果排序去重(与 Rust find_cycles 同)。
  const findCycles = (): string[][] => {
    const names = [...nodes.keys()];
    const idOf = new Map(names.map((n, i) => [n, i]));
    const adj = new Map<number, Array<{ to: string; id: number }>>();
    for (const e of edges) {
      const id = idOf.get(e.to);
      if (id !== undefined) {
        const from = idOf.get(e.from) as number;
        if (!adj.has(from)) {
          adj.set(from, []);
        }
        adj.get(from)!.push({ to: e.to, id });
      }
    }
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const color = names.map(() => WHITE);
    const cycles: string[][] = [];
    const seenCycles = new Set<string>();
    for (let start = 0; start < names.length; start += 1) {
      if (color[start] !== WHITE) {
        continue;
      }
      const stack: Array<[number, number]> = [[start, 0]];
      const pathN: number[] = [start];
      color[start] = GREY;
      while (stack.length > 0) {
        const [node, cursor] = stack[stack.length - 1];
        const neighbours = adj.get(node) ?? [];
        if (cursor >= neighbours.length) {
          color[node] = BLACK;
          stack.pop();
          pathN.pop();
          continue;
        }
        stack[stack.length - 1] = [node, cursor + 1];
        const { to, id } = neighbours[cursor];
        if (color[id] === GREY) {
          const pos = pathN.indexOf(id);
          const cycle = [...pathN.slice(pos === -1 ? 0 : pos).map(n => names[n]), to];
          const key = cycle.join('→');
          if (!seenCycles.has(key)) {
            seenCycles.add(key);
            cycles.push(cycle);
          }
        } else if (color[id] === WHITE) {
          color[id] = GREY;
          stack.push([id, 0]);
          pathN.push(id);
        }
      }
    }
    cycles.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return cycles;
  };

  const classifications = [...new Set([...nodes.keys(), ...registered])]
    .sort()
    .map(name => ({
      name,
      class: BUILTIN_TYPES.has(name)
        ? 'builtin'
        : (() => {
            const node = nodes.get(name);
            if (!node) {
              return registered.has(name) ? 'entity' : 'unknown';
            }
            // 节点种类 → 分类名(与 Rust TypeClass::as_str 同名)。
            return { alias: 'alias', array: 'array', fixedDict: 'fixed_dict', entity: 'entity' }[node.kind];
          })()
    }));
  const aliasChains = [...nodes.entries()]
    .filter(([, n]) => n.kind === 'alias')
    .map(([name]) => resolveAliasChain(name))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const inheritanceChains = [...nodes.entries()]
    .filter(([, n]) => n.kind === 'entity')
    .map(([name]) => resolveInheritance(name))
    .sort((a, b) => (a.entity ?? '').localeCompare(b.entity ?? ''));

  return {
    fileCount: corpus.length,
    typeNodeCount: nodes.size,
    files,
    graph: { classifications, aliasChains, inheritanceChains, cycles: findCycles() }
  };
};

describe('kode-types 与 TS defParser/compositionRoots 类型面对拍(PR-008)', () => {
  const golden = loadGolden();
  const computed = computeTypeSurface();

  it('golden 覆盖面与语料一致(文件集合/类型节点数相同)', () => {
    expect(computed.fileCount).toBe(golden.fileCount);
    expect(computed.typeNodeCount).toBe(golden.typeNodeCount);
    expect(computed.files.map(f => f.file)).toEqual(golden.files.map(f => f.file));
  });

  it('逐文件类型面一致(decls/aliases/composition/entities)', () => {
    const mismatches: string[] = [];
    let total = 0;
    let matched = 0;
    for (let i = 0; i < golden.files.length; i += 1) {
      total += 1;
      const expected = golden.files[i];
      const got = computed.files[i];
      if (JSON.stringify(expected) === JSON.stringify(got)) {
        matched += 1;
      } else {
        mismatches.push(`${expected.file}:\n  golden=${JSON.stringify(expected)}\n  ts=${JSON.stringify(got)}`);
      }
    }
    if (mismatches.length > 0) {
      console.error(`文件面对拍不一致 ${mismatches.length}/${total}:\n${mismatches.slice(0, 5).join('\n')}`);
    }
    expect(matched).toBe(total);
  });

  it('图级面一致(分类/别名链/继承链/全图环)', () => {
    let total = 0;
    let matched = 0;
    const mismatchDetails: string[] = [];
    const compareArrays = <T>(label: string, expected: T[], actual: T[], keyOf: (v: T) => string): void => {
      const maxLength = Math.max(expected.length, actual.length);
      for (let i = 0; i < maxLength; i += 1) {
        total += 1;
        const e = expected[i];
        const a = actual[i];
        if (e !== undefined && a !== undefined && JSON.stringify(e) === JSON.stringify(a)) {
          matched += 1;
        } else {
          mismatchDetails.push(`${label}[${i}](${keyOf(e ?? a ?? ({} as T))}): golden=${JSON.stringify(e ?? null)} ts=${JSON.stringify(a ?? null)}`);
        }
      }
    };
    compareArrays('classifications', golden.graph.classifications, computed.graph.classifications, v => v.name);
    compareArrays('aliasChains', golden.graph.aliasChains, computed.graph.aliasChains, v => v.name ?? '');
    compareArrays('inheritanceChains', golden.graph.inheritanceChains, computed.graph.inheritanceChains, v => v.entity ?? '');
    compareArrays('cycles', golden.graph.cycles, computed.graph.cycles, v => JSON.stringify(v));
    if (mismatchDetails.length > 0) {
      console.error(`图级对拍不一致 ${mismatchDetails.length}/${total}:\n${mismatchDetails.slice(0, 10).join('\n')}`);
    }
    console.error(`类型面对拍: ${matched}/${total} = ${((matched / total) * 100).toFixed(1)}%`);
    expect(matched).toBe(total);
    expect(total).toBeGreaterThan(0);
  });
});
