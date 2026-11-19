// kode2 Phase2 SignatureHelp 决策核对拍门禁(RUST-140 批 2):生产词法面
// (getPythonCallAtPosition)+ 生产注解链(resolveEntityAnnotationType
// workspaceRoot='' 语境)+ defParser 原语独立复算 Rust 侧 golden
// (crates/kode-server/tests/golden/signature-help-parity.json)——解析决策
// 链(owner 归属/继承链闭包/接收者段闸/打分破平)与签名四件(label/
// 形参注解/documentation/声明落点)逐条重推,双向门禁。本文件只读
// fixture 与 golden,不改 src/。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { getPythonCallAtPosition } from '../src/backend/pythonLanguageUtils';
import { inferMethodSectionFromPythonFile } from '../src/backend/pythonMethodCallQueries';
import { normalizeFileIdentity } from '../src/backend/pathIdentity';
import {
  DefDocument,
  DefElementNode,
  getDirectChildElement,
  getDirectChildElements,
  getDirectChildElementsByName,
  getElementText,
  hasTruthyChildTag,
  parseDefDocument
} from '../src/backend/defParser';
import { resolveEntityAnnotationType } from '../src/definitionWorkspace';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/signature-help-parity.json');
const CALL_AT_GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/python-call-at-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;

// ---- 语料收集(与 Rust collect_corpus/collect_python_corpus 同序) --------

interface CorpusFile {
  file: string;
  kind: 'def' | 'entities' | 'types' | 'alias';
  text: string;
  parsed: DefDocument;
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

interface PyFile {
  file: string;
  text: string;
}

const collectPyCorpus = (): PyFile[] => {
  const out: PyFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childPath = path.join(dir, entry.name);
      const relChild = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childPath, relChild);
        continue;
      }
      if (entry.name.endsWith('.py')) {
        out.push({ file: relChild, text: fs.readFileSync(childPath, 'utf8') });
      }
    }
  };
  for (const corpus of CORPORA) {
    walk(path.join(REPO_ROOT, corpus), corpus);
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

// ---- 坐标换算(references 镜像同款) ---------------------------------------

const offsetToPos = (text: string, offset: number): { line: number; character: number } => {
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

const dirOf = (filePath: string): string | null => {
  const idx = filePath.lastIndexOf('/');
  return idx >= 0 ? filePath.slice(0, idx) : null;
};

// ---- 语料视图(defsRoot / entityDefsRoot 折算,references 镜像同款) -------

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

const categoryOf = (defsRoot: string, defPath: string): 'entity' | 'interface' | 'component' => {
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

// ---- def 方法候选索引(类型 IR 面;与 Rust method_def_candidates 同构) ----

interface DefMethodMirror {
  name: string;
  line1: number;
  args: string[];
  exposed: boolean;
}

const methodsOfSection = (file: CorpusFile, section: string): DefMethodMirror[] => {
  const root = file.parsed.root;
  if (!root) {
    return [];
  }
  const sectionNode = getDirectChildElement(root, section);
  if (!sectionNode) {
    return [];
  }
  return getDirectChildElements(sectionNode).map(method => ({
    name: method.name,
    line1: offsetToPos(file.text, method.tagStart).line + 1,
    // Rust parser 同口径:空 `<Arg>` 不产参。
    args: getDirectChildElementsByName(method, 'Arg')
      .map(arg => getElementText(arg).trim())
      .filter(argText => argText.length > 0),
    exposed: hasTruthyChildTag(method, 'Exposed')
  }));
};

interface Candidate {
  defFile: string;
  line: number;
  section: 'BaseMethods' | 'CellMethods' | 'ClientMethods';
  exposed: boolean;
  ownerKind: 'entity' | 'interface' | 'component';
  ownerName: string;
  symbolName: string;
  declaredArgs: string[];
}

const collectCandidates = (engine: Engine): Candidate[] => {
  const out: Candidate[] = [];
  const defPaths = [...engine.corpusDefs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const defPath of defPaths) {
    const file = engine.defFiles.get(defPath);
    if (!file) {
      continue;
    }
    const defsRoot = defsRootFor(engine, defPath);
    const ownerKind = defsRoot ? categoryOf(defsRoot, defPath) : 'entity';
    const ownerName = defPath.slice(defPath.lastIndexOf('/') + 1).replace(/\.def$/, '');
    const sections = ['BaseMethods', 'CellMethods', 'ClientMethods'] as const;
    for (const section of sections) {
      for (const method of methodsOfSection(file, section)) {
        out.push({
          defFile: defPath,
          line: method.line1,
          section,
          exposed: method.exposed,
          ownerKind,
          ownerName,
          symbolName: method.name,
          declaredArgs: method.args
        });
      }
    }
  }
  return out;
};

// ---- 调用方身份(生产 section 推断 + owner 推断镜像) ----------------------

const inferOwnerKind = (pythonFile: string): 'entity' | 'interface' | 'component' | undefined => {
  const normalized = normalizeFileIdentity(pythonFile).toLowerCase();
  if (normalized.includes('/components/')) {
    return 'component';
  }
  if (normalized.includes('/interfaces/')) {
    return 'interface';
  }
  if (normalized.endsWith('.py')) {
    return 'entity';
  }
  return undefined;
};

const inferOwnerName = (pythonFile: string): string => {
  const base = pythonFile.slice(Math.max(pythonFile.lastIndexOf('/'), pythonFile.lastIndexOf('\\')) + 1);
  return base.endsWith('.py') ? base.slice(0, -'.py'.length) : base;
};

// ---- owner 继承链闭包路径(与 Rust owner_chain_paths 同构) ----------------

const ownerChainPaths = (engine: Engine, pythonFile: string): string[] | null => {
  const ownerName = inferOwnerName(pythonFile);
  const defsRootDir = defsRootFor(engine, pythonFile);
  if (!defsRootDir) {
    return null;
  }
  const entityDefs = defsRootDir.endsWith('/entity_defs')
    ? defsRootDir
    : `${defsRootDir}/entity_defs`;
  const ownerPath = `${entityDefs}/${ownerName}.def`;
  if (!engine.corpusDefs.has(ownerPath)) {
    return null;
  }
  const defsRoot = defsRootFor(engine, ownerPath);
  if (!defsRoot) {
    return [ownerPath];
  }
  const out = [ownerPath];
  const seen = new Set([ownerPath]);
  let current: string | undefined = ownerPath;
  while (current) {
    const file = engine.defFiles.get(current);
    if (!file) {
      break;
    }
    const root = file.parsed.root;
    if (!root) {
      break;
    }
    const category = categoryOf(defsRoot, current);
    for (const name of getDirectChildElement(root, 'Interfaces')
      ? getDirectChildElementsByName(getDirectChildElement(root, 'Interfaces') as DefElementNode, 'interface')
        .map(node => getElementText(node).trim())
      : []) {
      const candidate = `${defsRoot}/interfaces/${name}.def`;
      if (engine.corpusDefs.has(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
    }
    const componentsNode = getDirectChildElement(root, 'Components');
    if (componentsNode) {
      for (const comp of getDirectChildElements(componentsNode)) {
        const name = getDirectChildElement(comp, 'Type')
          ? getElementText(getDirectChildElement(comp, 'Type') as DefElementNode).trim()
          : '';
        if (!name) {
          continue;
        }
        const candidate = `${defsRoot}/components/${name}.def`;
        if (engine.corpusDefs.has(candidate) && !seen.has(candidate)) {
          seen.add(candidate);
          out.push(candidate);
        }
      }
    }
    // 接口 def 不跟随 Parent(引擎 loadInterfaces 口径)。
    if (category === 'interface') {
      break;
    }
    const parentValue = getDirectChildElement(root, 'Parent')
      ? getElementText(getDirectChildElement(root, 'Parent') as DefElementNode).trim()
      : '';
    if (!parentValue) {
      break;
    }
    const parentDir = category === 'component' ? `${defsRoot}/components` : defsRoot;
    const parentPath = `${parentDir}/${parentValue}.def`;
    if (!engine.corpusDefs.has(parentPath) || seen.has(parentPath)) {
      break;
    }
    seen.add(parentPath);
    out.push(parentPath);
    current = parentPath;
  }
  return out;
};

// ---- 解析决策核(段硬闸 + 打分 + 破平,与 Rust 同构) ----------------------

const scoreCandidate = (
  candidate: Candidate,
  ownerKind: string | undefined,
  ownerName: string,
  callerSection: string | undefined
): number => {
  let score = 0;
  if (ownerKind !== undefined && candidate.ownerKind === ownerKind) {
    score += 40;
  }
  if (ownerName.length > 0 && candidate.ownerName === ownerName) {
    score += 40;
  }
  if (callerSection !== undefined && candidate.section === callerSection) {
    score += 20;
  }
  score += 10;
  return score;
};

const resolveMethodDefinition = (
  candidates: Candidate[],
  pythonFile: string,
  methodName: string,
  receiverSection: string | null
): Candidate | null => {
  const ownerKind = inferOwnerKind(pythonFile);
  const ownerName = inferOwnerName(pythonFile);
  const callerSection = inferMethodSectionFromPythonFile(pythonFile);
  const scored = candidates
    .filter(candidate => candidate.symbolName === methodName)
    .filter(candidate => receiverSection === null || candidate.section === receiverSection)
    .map(candidate => ({ candidate, score: scoreCandidate(candidate, ownerKind, ownerName, callerSection) }));
  if (scored.length === 0) {
    return null;
  }
  scored.sort((left, right) =>
    right.score - left.score
    // 破平:规范化 def 路径字典序(逐字节序;Rust byte cmp 同构,语料
    // 路径全 ASCII),再行号。
    || (normalizeFileIdentity(left.candidate.defFile) < normalizeFileIdentity(right.candidate.defFile) ? -1
      : normalizeFileIdentity(left.candidate.defFile) > normalizeFileIdentity(right.candidate.defFile) ? 1 : 0)
    || left.candidate.line - right.candidate.line);
  return scored[0].candidate;
};

// ---- 签名组装(生产注解链 + argN 形态) -----------------------------------

const formatParameter = (arg: string, index: number): string => {
  const trimmed = arg.trim();
  if (!trimmed) {
    return `arg${index + 1}`;
  }
  const annotation = resolveEntityAnnotationType('', trimmed);
  // 三提示面不显 Any(production formatDefMethodParameter 同收口)。
  if (annotation === 'Any') {
    return `arg${index + 1}`;
  }
  return `arg${index + 1}: ${annotation}`;
};

const clampActiveParameter = (activeArgument: number, parameterCount: number): number =>
  parameterCount === 0 ? 0 : Math.min(activeArgument, parameterCount - 1);

interface HelpFace {
  label: string;
  parameters: string[];
  documentation: string;
  definition: { file: string; line: number; section: string; exposed: boolean };
}

const signatureHelp = (
  engine: Engine,
  candidates: Candidate[],
  pythonFile: string,
  methodName: string,
  receiverSection: string | null
): HelpFace | null => {
  const ownerKind = inferOwnerKind(pythonFile);
  const scope = ownerChainPaths(engine, pythonFile);
  let selected: Candidate | null = null;
  if (scope) {
    const scopeSet = new Set(scope);
    selected = resolveMethodDefinition(
      candidates.filter(candidate => scopeSet.has(candidate.defFile)),
      pythonFile,
      methodName,
      receiverSection
    );
  }
  if (!selected && ownerKind === 'interface' && receiverSection !== null) {
    selected = resolveMethodDefinition(candidates, pythonFile, methodName, receiverSection);
  }
  if (!selected) {
    return null;
  }
  const parameters = selected.declaredArgs.map((arg, index) => formatParameter(arg, index));
  let documentation = `此调用是实体 def 声明的 ${selected.section} 方法`;
  if (receiverSection !== null) {
    documentation += `(接收者 self.${receiverSection})`;
  }
  if (selected.exposed) {
    documentation += ' · **Exposed**: 可被客户端远程调用';
  }
  return {
    label: parameters.length > 0
      ? `def ${methodName}(self, ${parameters.join(', ')})`
      : `def ${methodName}(self)`,
    parameters,
    documentation,
    definition: {
      file: selected.defFile,
      line: selected.line,
      section: selected.section,
      exposed: selected.exposed
    }
  };
};

// ---- 复算(逐命中 → 组(行, 方法名, 段)→ 签名四件 + 逐位标亮) ----------

interface MirrorEntry {
  line: number;
  call: { methodName: string; section: string | null };
  help: HelpFace;
  activations: { character: number; activeArgument: number; activeParameter: number }[];
}

const recomputeFile = (
  engine: Engine,
  candidates: Candidate[],
  file: PyFile
): { probeCount: number; hitCount: number; entries: MirrorEntry[]; resolvedPositions: Set<number> } => {
  let probeCount = 0;
  let hitCount = 0;
  const groups = new Map<string, MirrorEntry>();
  const resolvedPositions = new Set<number>();
  const lines = file.text.split('\n');
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx].endsWith('\r') ? lines[idx].slice(0, -1) : lines[idx];
    probeCount += line.length + 1;
    for (let character = 0; character <= line.length; character += 1) {
      const call = getPythonCallAtPosition(line, character);
      if (!call) {
        continue;
      }
      hitCount += 1;
      const help = signatureHelp(engine, candidates, file.file, call.methodName, call.section ?? null);
      if (!help) {
        continue;
      }
      const key = `${idx + 1}\u0000${call.methodName}\u0000${call.section ?? ''}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          line: idx + 1,
          call: { methodName: call.methodName, section: call.section ?? null },
          help,
          activations: []
        };
        groups.set(key, group);
      }
      group.activations.push({
        character,
        activeArgument: call.activeArgument,
        activeParameter: clampActiveParameter(call.activeArgument, help.parameters.length)
      });
      resolvedPositions.add(character);
    }
  }
  const cmpStr = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  const entries = [...groups.values()].sort((a, b) =>
    a.line - b.line
    || cmpStr(a.call.methodName, b.call.methodName)
    || cmpStr(a.call.section ?? '', b.call.section ?? ''));
  return { probeCount, hitCount, entries, resolvedPositions };
};

describe('kode2 Phase2 SignatureHelp 决策核对拍(Rust golden ↔ 生产面复算)', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const callAtGolden = JSON.parse(fs.readFileSync(CALL_AT_GOLDEN_PATH, 'utf8'));
  const pyCorpus = collectPyCorpus();
  const corpus = collectCorpus();
  const engine = buildEngine(corpus);
  const candidates = collectCandidates(engine);

  it('golden 语料同集 + 批 1 词法对账锚(fileCount/probeCount/hitCount 同值)', () => {
    expect(golden.files.map((f: { file: string }) => f.file)).toEqual(pyCorpus.map(f => f.file));
    expect(golden.fileCount).toBe(callAtGolden.fileCount);
    expect(golden.probeCount).toBe(callAtGolden.probeCount);
    expect(golden.hitCount).toBe(callAtGolden.hitCount);
  });

  it('逐文件复算深等(探针/命中/条目/签名四件/逐位标亮)', () => {
    let resolvedTotal = 0;
    for (let i = 0; i < pyCorpus.length; i += 1) {
      const recomputed = recomputeFile(engine, candidates, pyCorpus[i]);
      const goldenFile = golden.files[i];
      expect(goldenFile.probeCount).toBe(recomputed.probeCount);
      expect(goldenFile.hitCount).toBe(recomputed.hitCount);
      expect(goldenFile.entries).toEqual(recomputed.entries);
      resolvedTotal += recomputed.entries.reduce(
        (sum, entry) => sum + entry.activations.length,
        0
      );
    }
    expect(golden.resolvedCount).toBe(resolvedTotal);
  });

  it('未解析命中位如实落空(词法命中全集 − 激活位 = 复算 miss 位)', () => {
    for (let i = 0; i < pyCorpus.length; i += 1) {
      const goldenFile = golden.files[i];
      const resolved = new Set<number>();
      for (const entry of goldenFile.entries) {
        for (const activation of entry.activations) {
          resolved.add(activation.character);
        }
      }
      const recomputed = recomputeFile(engine, candidates, pyCorpus[i]);
      // 复算解析位集合与 golden 激活位集合一致(miss 位差集为空)。
      expect(recomputed.resolvedPositions).toEqual(resolved);
    }
  });

  it('护栏:声明落点在语料内 + label 前缀 + 段值域 + resolvedCount<hitCount', () => {
    const sections = new Set(['BaseMethods', 'CellMethods', 'ClientMethods']);
    for (const file of golden.files) {
      for (const entry of file.entries) {
        expect(engine.corpusDefs.has(entry.help.definition.file)).toBe(true);
        expect(entry.help.label.startsWith(`def ${entry.call.methodName}(self`)).toBe(true);
        expect(sections.has(entry.help.definition.section)).toBe(true);
        expect(entry.help.definition.line).toBeGreaterThanOrEqual(1);
        for (const activation of entry.activations) {
          const max = entry.help.parameters.length === 0
            ? 0
            : entry.help.parameters.length - 1;
          expect(activation.activeParameter).toBeLessThanOrEqual(max);
        }
      }
    }
    expect(golden.resolvedCount).toBeLessThan(golden.hitCount);
    expect(golden.resolvedCount).toBeGreaterThan(0);
  });
});
