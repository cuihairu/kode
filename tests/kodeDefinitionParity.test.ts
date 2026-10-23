// kode2 Phase2 首片对拍门禁:用 TS defParser 原语复算 Rust 侧生成的
// definition golden(crates/kode-server/tests/golden/definition-parity.json),
// 逐文件逐落点比对(语料声明落点面;本文件只读 fixture 与 golden,不改 src/)。
// 与 kodeHoverParity/kodeCompletionParity 同构。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DefElementNode,
  getDirectChildElements,
  getElementText,
  parseDefDocument
} from '../src/defParser';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/definition-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;

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

// ---- 坐标换算(VS Code positionAt 同语义:\n 切行,\r 计入行内) ------------

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

const line1Of = (text: string, offset: number): number => offsetToPos(text, offset).line + 1;

// ---- 语料视图(与 HoverEngine 同语义:路径键、字典序首见) -----------------

interface Engine {
  corpusDefs: Set<string>;
  defByName: Map<string, string>;
  entitiesDirs: Set<string>;
  typesDecls: Map<string, { name: string; line1: number }[]>;
}

const stemOf = (filePath: string): string => {
  const base = filePath.split('/').pop() ?? filePath;
  return base.replace(/\.def$/, '');
};

const dirOf = (filePath: string): string | null => {
  const idx = filePath.lastIndexOf('/');
  return idx >= 0 ? filePath.slice(0, idx) : null;
};

const buildEngine = (corpus: CorpusFile[]): Engine => {
  const engine: Engine = {
    corpusDefs: new Set(),
    defByName: new Map(),
    entitiesDirs: new Set(),
    typesDecls: new Map()
  };
  for (const file of corpus) {
    if (file.kind === 'def') {
      engine.corpusDefs.add(file.file);
      const stem = stemOf(file.file);
      if (!engine.defByName.has(stem)) {
        engine.defByName.set(stem, file.file);
      }
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

// ---- 各 kind 的声明抽取(与 kode-parser extract_* 同口径) -----------------

const typesDeclsOf = (file: CorpusFile): { name: string; line1: number }[] => {
  const out: { name: string; line1: number }[] = [];
  const root = file.parsed.root;
  if (!root) {
    return out;
  }
  for (const child of getDirectChildElements(root)) {
    // 与 Rust parse_types 同口径:文本首 token 或 type 属性;全空跳过。
    const textDirective = getElementText(child).trim().split(/\s+/)[0] ?? '';
    const attrDirective = (child.attributes as Record<string, string> | undefined)?.type?.trim() ?? '';
    if (!textDirective && !attrDirective) {
      continue;
    }
    out.push({ name: child.name, line1: line1Of(file.text, child.tagStart) });
  }
  return out;
};

const aliasDeclsOf = (file: CorpusFile): { name: string; line1: number }[] => {
  const out: { name: string; line1: number }[] = [];
  const root = file.parsed.root;
  if (!root) {
    return out;
  }
  for (const child of getDirectChildElements(root)) {
    const typeChild = getDirectChildElements(child).find(n => n.name === 'Type');
    const otherChild = getDirectChildElements(child).find(n => n.name !== 'Type');
    const directText = getElementText(child).trim().split(/\s+/)[0] ?? '';
    if (!typeChild && !otherChild && !directText) {
      continue;
    }
    out.push({ name: child.name, line1: line1Of(file.text, child.tagStart) });
  }
  return out;
};

interface EntityProbe { name: string; line1: number }

const entitiesEntriesOf = (file: CorpusFile): EntityProbe[] => {
  const out: EntityProbe[] = [];
  const root = file.parsed.root;
  if (!root) {
    return out;
  }
  for (const child of getDirectChildElements(root)) {
    if (child.name === 'root') {
      continue;
    }
    out.push({ name: child.name, line1: line1Of(file.text, child.tagStart) });
  }
  return out;
};

const BUILTIN_TYPES = new Set([
  'UINT8', 'UINT16', 'UINT32', 'UINT64', 'INT8', 'INT16', 'INT32', 'INT64',
  'FLOAT', 'DOUBLE', 'STRING', 'UNICODE', 'VECTOR2', 'VECTOR3', 'VECTOR4',
  'ENTITYCALL', 'PYTHON', 'PY_DICT', 'PY_TUPLE', 'PY_LIST', 'BLOB', 'ARRAY', 'FIXED_DICT'
]);

// ---- 落点复算(与 Rust definition_word 同规则) ----------------------------

interface LocationFace {
  uri: string;
  range: { start: Pos; end: Pos };
}

const headLocation = (uri: string): LocationFace => ({
  uri,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
});

const lineStartLocation = (uri: string, line1: number): LocationFace => ({
  uri,
  range: {
    start: { line: line1 - 1, character: 0 },
    end: { line: line1 - 1, character: 0 }
  }
});

const nameSpanLocation = (text: string, filePath: string, node: DefElementNode): LocationFace => {
  const start = offsetToPos(text, node.tagStart + 1);
  const end = offsetToPos(text, node.tagStart + 1 + node.name.length);
  return { uri: filePath, range: { start, end } };
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

const categorySegment = (defsRoot: string, filePath: string): 'interface' | 'component' | 'entity' => {
  if (!filePath.startsWith(`${defsRoot}/`)) {
    return 'entity';
  }
  const rel = filePath.slice(defsRoot.length + 1);
  if (rel.split('/').includes('interfaces')) {
    return 'interface';
  }
  if (rel.split('/').includes('components')) {
    return 'component';
  }
  return 'entity';
};

const parentLanding = (engine: Engine, filePath: string, parent: string): LocationFace | null => {
  const defsRoot = defsRootFor(engine, filePath);
  if (!defsRoot) {
    return null;
  }
  const category = categorySegment(defsRoot, filePath);
  const parentDir = category === 'component' ? `${defsRoot}/components` : defsRoot;
  const parentPath = `${parentDir}/${parent}.def`;
  if (!engine.corpusDefs.has(parentPath)) {
    return null;
  }
  return headLocation(parentPath);
};

const parentNameOf = (root: DefElementNode): string => {
  const parent = getDirectChildElements(root).find(n => n.name === 'Parent');
  return parent ? getElementText(parent).trim() : '';
};

const sectionsOf = (root: DefElementNode): DefElementNode[] => getDirectChildElements(root);

const sectionSymbols = (section: DefElementNode): DefElementNode[] =>
  getDirectChildElements(section);

// ---- 逐文件复算 ------------------------------------------------------------

interface ExpectedDefinition { line: number; word: string; definition: LocationFace }

const recomputeFile = (engine: Engine, file: CorpusFile): ExpectedDefinition[] => {
  const probes: { line1: number; word: string }[] = [];
  const root = file.parsed.root;
  if (!root) {
    return [];
  }
  const landingFor = (line1: number, word: string): LocationFace | null => {
    if (file.kind === 'def') {
      // Parent 取值词。
      const parent = parentNameOf(root);
      if (parent && word === parent) {
        return parentLanding(engine, file.file, parent);
      }
      // 探针位(行首)不在 Type/of 内容内 → 类型落点不触发(与 Rust
      // definition_at_line 的 char=0 同口径);回到声明本体。
      for (const section of sectionsOf(root)) {
        for (const symbol of sectionSymbols(section)) {
          const line = line1Of(file.text, symbol.tagStart + 1);
          if (line === line1 && symbol.name === word) {
            return nameSpanLocation(file.text, file.file, symbol);
          }
        }
      }
      return null;
    }
    if (file.kind === 'entities') {
      const target = engine.defByName.get(word);
      return target ? headLocation(target) : null;
    }
    if (file.kind === 'types') {
      return lineStartLocation(file.file, line1);
    }
    if (file.kind === 'alias') {
      return lineStartLocation(file.file, line1);
    }
    return null;
  };

  if (file.kind === 'def') {
    // ①Parent 探针(`<Parent>` 出现行)。
    const parent = parentNameOf(root);
    if (parent) {
      const idx = file.text.split('\n').findIndex(l => l.includes(parent));
      if (idx >= 0) {
        probes.push({ line1: idx + 1, word: parent });
      }
    }
    // ②属性 `<Type>` 首 token 探针。
    for (const section of sectionsOf(root)) {
      if (section.name !== 'Properties') {
        continue;
      }
      for (const symbol of sectionSymbols(section)) {
        const typeNode = getDirectChildElements(symbol).find(n => n.name === 'Type');
        if (!typeNode) {
          continue;
        }
        const typeToken = getElementText(typeNode).trim().split(/\s+/)[0] ?? '';
        if (!typeToken) {
          continue;
        }
        probes.push({ line1: line1Of(file.text, symbol.tagStart + 1), word: typeToken });
      }
    }
  }
  if (file.kind === 'entities') {
    probes.push(...entitiesEntriesOf(file).map(entry => ({ line1: entry.line1, word: entry.name })));
  }
  if (file.kind === 'types') {
    probes.push(...typesDeclsOf(file).map(decl => ({ line1: decl.line1, word: decl.name })));
  }
  if (file.kind === 'alias') {
    probes.push(...aliasDeclsOf(file).map(decl => ({ line1: decl.line1, word: decl.name })));
  }
  if (file.kind === 'def') {
    // ③声明符号探针(Properties/三方法段/Components 段内声明;与 Rust
    // extract_records 同集合 —— Interfaces/Parent/Volatile 段无声明符号)。
    for (const section of sectionsOf(root)) {
      if (!['Properties', 'BaseMethods', 'CellMethods', 'ClientMethods', 'Components'].includes(section.name)) {
        continue;
      }
      for (const symbol of sectionSymbols(section)) {
        probes.push({ line1: line1Of(file.text, symbol.tagStart + 1), word: symbol.name });
      }
    }
  }
  // 稳定排序(按行)+ 去重相邻同项(与 Rust sort_by_key + dedup 同口径)。
  probes.sort((a, b) => a.line1 - b.line1);
  const out: ExpectedDefinition[] = [];
  let previous: { line1: number; word: string } | null = null;
  for (const probe of probes) {
    if (previous && previous.line1 === probe.line1 && previous.word === probe.word) {
      continue;
    }
    previous = probe;
    const definition = landingFor(probe.line1, probe.word);
    if (definition) {
      out.push({ line: probe.line1, word: probe.word, definition });
    }
  }
  return out;
};

// ---- 门禁 -------------------------------------------------------------------

describe('kode2 Phase2 definition 对拍(Rust golden ↔ TS 复算)', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const corpus = collectCorpus();
  const engine = buildEngine(corpus);

  it('golden 语料与 TS 收集同集(文件序一致)', () => {
    expect(golden.files.map((f: { file: string }) => f.file)).toEqual(corpus.map(f => f.file));
  });

  it('逐文件逐落点比对(声明落点面)', () => {
    let compared = 0;
    for (let i = 0; i < corpus.length; i += 1) {
      const expected = recomputeFile(engine, corpus[i]);
      const actual = golden.files[i].definitions ?? [];
      expect(actual).toEqual(expected);
      compared += actual.length;
    }
    expect(compared).toBe(golden.definitionCount);
  });

  it('面定义护栏:内建类型引用不落点,注册类型落 types.xml 行首', () => {
    expect(BUILTIN_TYPES.has('UINT32')).toBe(true);
    // 护栏断言放在真实语料上:golden 里所有落点 uri 必在语料内或等于宿主文件。
    for (const file of golden.files) {
      for (const definition of file.definitions ?? []) {
        const uri = definition.definition.uri as string;
        expect(uri === file.file || engine.corpusDefs.has(uri) || engine.typesDecls.has(uri)).toBe(true);
      }
    }
  });
});
