import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PythonClassIndex } from '../src/backend/pythonClassIndex';
import { checkSyntaxGate, syntaxGateCheck } from '../src/backend/syntaxGate';
import {
  getKodeCoreShadowGate,
  setKodeCoreShadowGate
} from '../src/backend/kodeCoreShadowFaces';
import { workspace } from './fake-vscode/workspaceState';
import { makeTextDocument } from './helpers/vscodeStub';

// INDEX-DISCIPLINE-001 ③:python 索引输入语法门。TS 镜像核与 Rust
// `$/kode/syntax/gate`(kode-server syntax_gate.rs)语义同构——本套镜像
// 语料与 Rust 内联用例一一对应,锁两面一致;onFileChanged 收口面钉
// 「烂文件不入索引保留上次健康符号 / 修复恢复 / 开关关回现状」。

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
  workspace.textDocuments = [];
  vi.restoreAllMocks();
});

const HEALTHY = [
  'class Avatar:',
  '    def tick(self):',
  '        return 1',
  '',
  '    def tock(self, a):',
  "        value = 'it\\'s fine'",
  '        other = "(not a bracket)"',
  '        return value  # trailing comment',
  ''
].join('\n');

describe('syntaxGateCheck 镜像核(与 Rust syntax_gate 内联用例同语料)', () => {
  it('healthy file passes', () => {
    expect(syntaxGateCheck(HEALTHY)).toEqual({ ok: true, reasons: [] });
  });

  it('triple-quoted string with unbalanced brackets inside passes', () => {
    const source = 'def doc():\n    """\n    unclosed ( bracket inside docstring\n    """\n    return 1\n';
    expect(syntaxGateCheck(source).ok).toBe(true);
  });

  it('brackets spanning lines pass and skip indent checks inside them', () => {
    const source = 'result = call_one(\n    call_two(1,\n2),\n  third\n)\n';
    expect(syntaxGateCheck(source).ok).toBe(true);
  });

  it('unclosed bracket is rejected with location', () => {
    const verdict = syntaxGateCheck('def m(self:\n    pass\n');
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0]).toContain("unclosed-bracket '(' from line 1");
  });

  it('mismatched bracket is rejected', () => {
    const verdict = syntaxGateCheck('value = (1, 2]\n');
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some(r => r.includes('unbalanced-bracket at line 1'))).toBe(true);
  });

  it('unterminated single-quoted string is rejected', () => {
    const verdict = syntaxGateCheck('value = \'abc\n');
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toContain('unterminated-string at line 1');
  });

  it('unterminated triple-quoted string is rejected at EOF', () => {
    const verdict = syntaxGateCheck('def doc():\n    """\n    body never ends\n');
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toContain('unterminated-string at EOF');
  });

  it('mixed tabs and spaces in indentation are rejected', () => {
    const verdict = syntaxGateCheck('class A:\n\tdef m(self):\n        pass\n');
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some(r => r.includes('mixed-indent at line 3'))).toBe(true);
  });

  it('dedent to an unseen shallower level is rejected', () => {
    const verdict = syntaxGateCheck('class A:\n    def m(self):\n        pass\n  def n(self):\n        pass\n');
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some(r => r.includes('inconsistent-dedent at line 4'))).toBe(true);
  });

  it('escaped quotes and comments do not trip the scanner', () => {
    const source = 'value = \'it\\\'s fine\'\nother = "# not ( a bracket"\n';
    expect(syntaxGateCheck(source).ok).toBe(true);
  });

  it('backslash continuation merges before scanning', () => {
    const source = 'value = \'abc \\\n    defg\'\n';
    expect(syntaxGateCheck(source).ok).toBe(true);
  });

  it('edited-mid-line breakage is the target shape: rejected, healthy full file never', () => {
    // 编辑中途显式断裂(删了个引号):拦;完整健康文件:放行——宁漏勿冤
    expect(syntaxGateCheck('value = \'it\\\'s\n').ok).toBe(false);
    expect(syntaxGateCheck('value = \'it\\\'s ok\'\n').ok).toBe(true);
  });
});

describe('checkSyntaxGate 主入口(Rust 主路径 + TS 回退)', () => {
  it('no gate → falls back to the TS mirror with identical verdict', async () => {
    expect(getKodeCoreShadowGate()).toBeNull();
    const broken = 'def m(self:\n    pass\n';
    expect(await checkSyntaxGate(broken)).toEqual(syntaxGateCheck(broken));
    expect(await checkSyntaxGate(HEALTHY)).toEqual({ ok: true, reasons: [] });
  });

  it('malformed gate response → falls back instead of starving the gate', async () => {
    setKodeCoreShadowGate({
      runInRust: async () => ({ ok: true, result: { nonsense: true } })
    } as never);
    try {
      const verdict = await checkSyntaxGate('def m(self:\n    pass\n');
      expect(verdict).toEqual(syntaxGateCheck('def m(self:\n    pass\n'));
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('gate rejecting → falls back to the TS mirror', async () => {
    setKodeCoreShadowGate({
      runInRust: async () => ({ ok: false, reason: 'face missing' })
    } as never);
    try {
      expect((await checkSyntaxGate(HEALTHY)).ok).toBe(true);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('healthy gate answer wins (Rust 主路径)', async () => {
    setKodeCoreShadowGate({
      runInRust: async (_method: string, params: unknown) => {
        const text = (params as { text: string }).text;
        return { ok: true, result: syntaxGateCheck(text) };
      }
    } as never);
    try {
      expect((await checkSyntaxGate('def m(self:\n    pass\n')).ok).toBe(false);
      expect((await checkSyntaxGate(HEALTHY)).ok).toBe(true);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });
});

describe('onFileChanged 语法门收口(烂文件不入索引)', () => {
  const HEALTHY_PY = 'class Gate:\n    def tick(self):\n        return 1\n';
  // 括号断裂=编辑中途形态:确定烂
  const BROKEN_PY = 'class Gate:\n    def tick(self:\n        return 1\n';

  it('gate off (开关关) → 行为回到现状:烂文件照入索引', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-syngate-off-'));
    temporaryDirectories.push(root);
    const file = path.join(root, 'gate.py');
    fs.writeFileSync(file, BROKEN_PY, 'utf8');
    const index = new PythonClassIndex(undefined, undefined, () => false);
    await index.onFileChanged(file);
    expect(index.findClassesByName.length).toBeGreaterThan(0);
    const classes = await index.findClassesByName('Gate');
    expect(classes).toHaveLength(1);
    expect(index.getSyntaxGateSkippedCount()).toBe(0);
  });

  it('broken file is skipped, index keeps the last healthy symbols; repair restores', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-syngate-keep-'));
    temporaryDirectories.push(root);
    const file = path.join(root, 'gate.py');
    fs.writeFileSync(file, HEALTHY_PY, 'utf8');
    const index = new PythonClassIndex();
    await index.onFileChanged(file);
    expect(await index.findClassesByName('Gate')).toHaveLength(1);

    // 烂版本落盘(保存了半截):拦下,不入索引,上次健康符号保留
    fs.writeFileSync(file, BROKEN_PY, 'utf8');
    await index.onFileChanged(file);
    expect(index.getSyntaxGateSkippedCount()).toBe(1);
    const kept = await index.findClassesByName('Gate');
    expect(kept).toHaveLength(1);
    expect(kept[0].methods.has('tick')).toBe(true);

    // 保存修复:自动恢复全量索引(同面过关即装载)
    fs.writeFileSync(file, HEALTHY_PY + '    def tock(self):\n        return 2\n', 'utf8');
    await index.onFileChanged(file);
    expect(index.getSyntaxGateSkippedCount()).toBe(1);
    const repaired = await index.findClassesByName('Gate');
    expect(repaired).toHaveLength(1);
    expect(repaired[0].methods.has('tock')).toBe(true);
  });

  it('open dirty buffer text is what gets gated (open document preferred over disk)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-syngate-buf-'));
    temporaryDirectories.push(root);
    const file = path.join(root, 'gate.py');
    fs.writeFileSync(file, HEALTHY_PY, 'utf8');
    const index = new PythonClassIndex();
    await index.onFileChanged(file);
    // 开档缓冲是烂的而盘上是好的:门禁文本=开档缓冲(拦的就是将要入索引的那份)
    workspace.textDocuments = [makeTextDocument(BROKEN_PY, { fileName: file, languageId: 'python', version: 3 })];
    await index.onFileChanged(file);
    expect(index.getSyntaxGateSkippedCount()).toBe(1);
    const kept = await index.findClassesByName('Gate');
    expect(kept).toHaveLength(1);
    expect(kept[0].methods.has('tock')).toBe(false);
  });
});
