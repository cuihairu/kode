// kode2 Phase2 python call-at 对拍门禁(RUST-140 批 1):直接 import 生产
// getPythonCallAtPosition(pythonLanguageUtils)逐位置复算 Rust 侧生成的
// golden(crates/kode-server/tests/golden/python-call-at-parity.json)——
// 生产 TS 面 ↔ Rust 面最强对拍(零复算漂移,document/references 镜像同构;
// 本文件只读 fixture 与 golden,不改 src/)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { getPythonCallAtPosition } from '../src/backend/pythonLanguageUtils';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/python-call-at-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;

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

interface HitFace {
  line: number;
  character: number;
  receiverName: string;
  methodName: string;
  section: string | null;
  activeArgument: number;
}

// 生产函数逐位置复算(行切分 '\n' + 尾 '\r' 剥除 = VS Code lineAt 同语义;
// 0..=行长全位置;非空命中收集)。
const recomputeFile = (file: PyFile): { probeCount: number; hits: HitFace[] } => {
  let probeCount = 0;
  const hits: HitFace[] = [];
  const lines = file.text.split('\n');
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx].endsWith('\r') ? lines[idx].slice(0, -1) : lines[idx];
    for (let character = 0; character <= line.length; character += 1) {
      probeCount += 1;
      const call = getPythonCallAtPosition(line, character);
      if (call) {
        hits.push({
          line: idx + 1,
          character,
          receiverName: call.receiverName,
          methodName: call.methodName,
          section: call.section ?? null,
          activeArgument: call.activeArgument
        });
      }
    }
  }
  return { probeCount, hits };
};

describe('kode2 Phase2 python call-at 对拍(Rust golden ↔ 生产函数复算)', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const corpus = collectPyCorpus();

  it('golden 语料与 TS 收集同集(.py 文件序一致)', () => {
    expect(golden.files.map((f: { file: string }) => f.file)).toEqual(corpus.map(f => f.file));
  });

  it('逐文件逐位置复算深等(调用解析面全集)', () => {
    let probeTotal = 0;
    let hitTotal = 0;
    for (let i = 0; i < corpus.length; i += 1) {
      const expected = recomputeFile(corpus[i]);
      const goldenFile = golden.files[i];
      expect(goldenFile.probeCount).toBe(expected.probeCount);
      expect(goldenFile.hits ?? []).toEqual(expected.hits);
      probeTotal += expected.probeCount;
      hitTotal += expected.hits.length;
    }
    expect(probeTotal).toBe(golden.probeCount);
    expect(hitTotal).toBe(golden.hitCount);
  });

  it('面定义护栏:section 仅三段值或 null,activeArgument 非负', () => {
    const sections = new Set(['BaseMethods', 'CellMethods', 'ClientMethods']);
    for (const file of golden.files) {
      for (const hit of file.hits ?? []) {
        expect(hit.section === null || sections.has(hit.section)).toBe(true);
        expect(hit.activeArgument).toBeGreaterThanOrEqual(0);
        expect(hit.character).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
