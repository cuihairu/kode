// kode2 Phase2 def 重命名对拍门禁(RUST-141 批 1):直接 import 生产
// defRenamer/defParser 逐文件复算 Rust 侧生成的 golden
// (crates/kode-server/tests/golden/def-rename-parity.json)——生产 TS 面 ↔
// Rust 面最强对拍(零复算漂移,references/document-symbols/python-call-at
// 镜像同构;本文件只读 fixture 与 golden,不改 src/)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  computeDefRenameEdits,
  findDefRenameConflict,
  findDefRenameConflictInClosure,
  findEntityDefsRootFromFile,
  resolveRenameSymbolAtOffset,
  type DefRenameSymbol
} from '../src/backend/defRenamer';
import { getDirectChildElements, parseDefDocument } from '../src/backend/defParser';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/def-rename-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;
const PROBE_NEW_NAME = 'zzRenameProbeNew';
const MEMBER_SECTIONS = new Set(['Properties', 'Components', 'BaseMethods', 'CellMethods', 'ClientMethods']);

interface DefFile {
  file: string;
  abs: string;
  text: string;
}

const toRel = (p: string): string => path.relative(REPO_ROOT, p).split(path.sep).join('/');

const collectDefCorpus = (): DefFile[] => {
  const out: DefFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childPath = path.join(dir, entry.name);
      const relChild = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childPath, relChild);
        continue;
      }
      if (entry.name.toLowerCase().endsWith('.def')) {
        out.push({ file: relChild, abs: childPath, text: fs.readFileSync(childPath, 'utf8') });
      }
    }
  };
  for (const corpus of CORPORA) {
    walk(path.join(REPO_ROOT, corpus), corpus);
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

// 顶层成员名(Properties/Components/三方法段直接子元素;与 Rust
// member_names_of 同口径)。
const memberNames = (text: string): string[] => {
  const doc = parseDefDocument(text);
  if (!doc.root) {
    return [];
  }
  const names = new Set<string>();
  for (const section of getDirectChildElements(doc.root)) {
    if (!MEMBER_SECTIONS.has(section.name)) {
      continue;
    }
    for (const child of getDirectChildElements(section)) {
      names.add(child.name);
    }
  }
  return [...names].sort();
};

const diskReader = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

const mapConflict = (
  conflict: { surface: string; name: string; line: number; filePath?: string } | null
): { surface: string; name: string; line: number; filePath: string | null } | null =>
  conflict === null
    ? null
    : {
        surface: conflict.surface,
        name: conflict.name,
        line: conflict.line,
        filePath: conflict.filePath === undefined ? null : toRel(conflict.filePath)
      };

// 逐文件复算(偏移 0..=长度全探测;分析 = 同文件冲突候选 × 本文件成员名 ∪
// 探测名 / 全工作区编辑 / 闭包冲突候选 × 他文件成员名 ∪ 探测名;候选宇宙
// 规则与 Rust dump 头注同口径)。
const recomputeFile = async (
  entry: DefFile,
  workspaceMemberNames: ReadonlyMap<string, readonly string[]>
): Promise<unknown> => {
  const symbolHits: unknown[] = [];
  const keys: Array<{ kind: 'property' | 'method'; section: string | null; name: string }> = [];
  const seenKeys = new Set<string>();
  for (let offset = 0; offset <= entry.text.length; offset += 1) {
    const symbol = resolveRenameSymbolAtOffset(entry.text, offset);
    if (!symbol) {
      continue;
    }
    const key = `${symbol.kind}|${symbol.section ?? ''}|${symbol.name}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      keys.push({ kind: symbol.kind, section: symbol.section, name: symbol.name });
    }
    symbolHits.push({
      offset,
      kind: symbol.kind,
      section: symbol.section ?? null,
      name: symbol.name,
      wordStart: symbol.wordStart,
      wordEnd: symbol.wordEnd
    });
  }

  const ownNames = workspaceMemberNames.get(entry.file) ?? [];
  const otherNames = new Set<string>();
  for (const [file, names] of workspaceMemberNames) {
    if (file === entry.file) {
      continue;
    }
    for (const name of names) {
      otherNames.add(name);
    }
  }

  const analyses = [];
  for (const { kind, section, name } of keys) {
    const symbol: DefRenameSymbol = {
      kind,
      name,
      section: section as DefRenameSymbol['section'],
      wordStart: 0,
      wordEnd: 0
    };
    const conflictCandidates = [...new Set([...ownNames, PROBE_NEW_NAME])].sort();
    const conflictChecks = conflictCandidates.map(newName => ({
      newName,
      conflict: mapConflict(findDefRenameConflict(entry.text, symbol, newName))
    }));
    const edits = (
      await computeDefRenameEdits({
        targetFilePath: entry.abs,
        targetText: entry.text,
        symbol,
        newName: PROBE_NEW_NAME,
        readCrossFileContent: diskReader
      })
    ).map(fileEdits => ({
      file: toRel(fileEdits.filePath),
      ranges: fileEdits.edits.map(edit => [edit.start, edit.end])
    }));
    const closureCandidates = [...new Set([...otherNames, PROBE_NEW_NAME])].sort();
    const closureChecks = [];
    for (const newName of closureCandidates) {
      const conflict = await findDefRenameConflictInClosure({
        targetFilePath: entry.abs,
        targetText: entry.text,
        symbol,
        newName,
        readCrossFileContent: diskReader
      });
      closureChecks.push({ newName, conflict: mapConflict(conflict) });
    }
    analyses.push({ kind, section: section ?? null, name, conflictChecks, edits, closureChecks });
  }

  return {
    file: entry.file,
    probeCount: entry.text.length + 1,
    symbolHits,
    analyses
  };
};

describe('kode2 Phase2 def 重命名对拍(Rust golden ↔ 生产函数复算)', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const corpus = collectDefCorpus();

  it('golden 语料与 TS 收集同集(工作区分组 + 组内文件序一致)', () => {
    // TS 分组复算(None 先、根字节序;组内全路径字节序——与 Rust
    // BTreeMap<Option<String>> + 组内 BTreeMap 同序;golden 拼平是工作区
    // 主序,不是全局路径字节序)。
    const groups = new Map<string | null, string[]>();
    for (const f of corpus) {
      const root = findEntityDefsRootFromFile(f.abs);
      const key = root === null ? null : toRel(root);
      const list = groups.get(key) ?? [];
      list.push(f.file);
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    const orderedKeys = [...groups.keys()].sort((a, b) => {
      if (a === null) return -1;
      if (b === null) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    expect(
      golden.workspaces.map((w: { root: string | null }) => w.root)
    ).toEqual(orderedKeys);
    for (const workspace of golden.workspaces) {
      expect(
        workspace.files.map((f: { file: string }) => f.file)
      ).toEqual(groups.get(workspace.root));
    }
  });

  it('逐文件复算深等(符号解析/同文件冲突/工作区编辑/闭包冲突全集)', { timeout: 900_000 }, async () => {
    // 工作区分组(与 golden 同规则)。
    const groups = new Map<string | null, DefFile[]>();
    for (const entry of corpus) {
      const root = findEntityDefsRootFromFile(entry.abs);
      const key = root === null ? null : toRel(root);
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
    // 逐工作区成员名面(供候选宇宙)。
    const workspaces = [...groups.entries()].sort((a, b) => {
      if (a[0] === null) return -1;
      if (b[0] === null) return 1;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    let probeTotal = 0;
    let hitTotal = 0;
    let analysisTotal = 0;
    let closureTotal = 0;
    for (const [root, files] of workspaces) {
      const memberNameMap = new Map<string, readonly string[]>(
        files.map(entry => [entry.file, memberNames(entry.text)])
      );
      const goldenWorkspace = golden.workspaces.find((w: { root: string | null }) => w.root === root);
      expect(goldenWorkspace, `工作区 ${root} 缺 golden 分组`).toBeDefined();
      const goldenByFile = new Map<string, unknown>(
        goldenWorkspace.files.map((f: { file: string }) => [f.file, f])
      );
      for (const entry of files) {
        const expected = await recomputeFile(entry, memberNameMap);
        const goldenFile = goldenByFile.get(entry.file);
        expect(goldenFile, `文件 ${entry.file} 缺 golden 条目`).toBeDefined();
        expect(expected).toEqual(goldenFile);
        const typed = expected as { probeCount: number; symbolHits: unknown[]; analyses: Array<{ closureChecks: unknown[] }> };
        probeTotal += typed.probeCount;
        hitTotal += typed.symbolHits.length;
        analysisTotal += typed.analyses.length;
        closureTotal += typed.analyses.reduce((sum, a) => sum + a.closureChecks.length, 0);
      }
    }
    expect(probeTotal).toBeGreaterThan(0);
    expect(hitTotal).toBe(golden.symbolHitCount);
    expect(analysisTotal).toBe(golden.analysisCount);
    expect(closureTotal).toBe(golden.closureCheckCount);
    expect(golden.workspaces.length).toBe(workspaces.length);
    expect(golden.defFileCount).toBe(corpus.length);
  });

  it('面定义护栏:kind/section/surface/ranges 合法性', () => {
    const surfaces = new Set(['Properties', 'Components', 'BaseMethods', 'CellMethods', 'ClientMethods']);
    for (const workspace of golden.workspaces) {
      for (const file of workspace.files) {
        for (const hit of file.symbolHits) {
          expect(hit.kind === 'property' || hit.kind === 'method').toBe(true);
          expect(hit.name.length).toBeGreaterThan(0);
          expect(hit.wordEnd).toBeGreaterThan(hit.wordStart);
        }
        for (const analysis of file.analyses) {
          expect(analysis.kind === 'property' || analysis.kind === 'method').toBe(true);
          for (const edit of analysis.edits) {
            expect(edit.ranges.length).toBeGreaterThan(0);
            let previousStart = -1;
            for (const [start, end] of edit.ranges) {
              expect(end).toBeGreaterThan(start);
              expect(start).toBeGreaterThanOrEqual(previousStart);
              previousStart = start;
            }
          }
          for (const check of [...analysis.conflictChecks, ...analysis.closureChecks]) {
            if (check.conflict !== null) {
              expect(surfaces.has(check.conflict.surface)).toBe(true);
              expect(check.conflict.line).toBeGreaterThanOrEqual(1);
              expect(check.conflict.name).toBe(check.newName);
            }
          }
        }
      }
    }
  });
});
