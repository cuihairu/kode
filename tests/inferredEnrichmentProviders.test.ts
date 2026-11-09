import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { KBEngineHoverProvider } from '../src/languageProviders';
import { InferredMirrorTypeInlayHintsProvider } from '../src/languageProviders/inlay';
import { createInferredMirrorHover } from '../src/inferredMirrorLookup';
import { planPythonExtraPaths } from '../src/pythonExtraPaths';
import {
  configurationOverrides,
  makeTextDocument,
  Position,
  Range,
  Uri,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// KODE-CFG-017-R 消费面 provider 测试(docs/design/kode-cfg-017-consumer.md §8):
// hover 镜像兜底(hover.ts 链尾) / inlay 镜像行差分 / T-04 禁遮蔽
// (extraPaths 计划恒无镜像目录 + 源码静态审计)。

const SRC_TEXT = 'def foo(self):\n    return 1\n\n\ncount = 0\n';
const MIR_TEXT = 'def foo(self) -> int:\n    return 1\n\n\ncount: int = 0\n';

const tmpRoots: string[] = [];
const makeRoot = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kode-inferred-${label}-`));
  tmpRoots.push(dir);
  return dir;
};

/** 建 workspace + 源/镜像盘上文件;返回源文档。 */
const makeScene = (label: string, mirrorText: string | null) => {
  const root = makeRoot(label);
  const srcPath = path.join(root, 'scripts', 'foo.py');
  fs.mkdirSync(path.dirname(srcPath), { recursive: true });
  fs.writeFileSync(srcPath, SRC_TEXT);
  if (mirrorText !== null) {
    const mirPath = path.join(root, '.kbengine', 'inferred', 'scripts', 'foo.py');
    fs.mkdirSync(path.dirname(mirPath), { recursive: true });
    fs.writeFileSync(mirPath, mirrorText);
  }
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return { root, document: makeTextDocument(SRC_TEXT, { fileName: srcPath, languageId: 'python', version: 1 }) };
};

/** 替身 Hover.contents 单数/数组双形态,统一取首段 markdown 文本。 */
const hoverValue = (hover: { contents: unknown }): string => {
  const contents = hover.contents as { value?: string } | Array<{ value?: string }>;
  const first = Array.isArray(contents) ? contents[0] : contents;
  return first?.value ?? '';
};

let originalFolders: typeof stubWorkspace.workspaceFolders;

beforeEach(() => {
  originalFolders = stubWorkspace.workspaceFolders;
});

afterEach(() => {
  stubWorkspace.workspaceFolders = originalFolders;
  configurationOverrides.delete('kbengine');
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('hover 镜像兜底富化', () => {
  it('普通 Python def 链全 miss → 镜像推断类型悬停(返回+形参)', async () => {
    const { document } = makeScene('hover-def', MIR_TEXT);
    const provider = new KBEngineHoverProvider();
    const hover = (await provider.provideHover(document, new Position(0, 5))) as {
      contents: unknown;
    } | null;
    expect(hover).not.toBeNull();
    const value = hoverValue(hover!);
    expect(value).toContain('**推断类型**: `-> int`');
    // self 无注解不出参数行(只出已注解形参)
    expect(value).not.toContain('**参数**');
  });

  it('变量赋值悬停 → 镜像变量注解', async () => {
    const { document } = makeScene('hover-var', MIR_TEXT);
    const provider = new KBEngineHoverProvider();
    const hover = (await provider.provideHover(document, new Position(4, 2))) as {
      contents: unknown;
    } | null;
    expect(hover).not.toBeNull();
    expect(hoverValue(hover!)).toContain('**推断类型**: `int`');
  });

  it('镜像缺失 → 链尾静默 null(不抛错不刷通知)', async () => {
    const { document } = makeScene('hover-miss', null);
    const provider = new KBEngineHoverProvider();
    const hover = await provider.provideHover(document, new Position(0, 5));
    expect(hover).toBeNull();
  });

  it('镜像无该符号注解 → null(只补缺)', async () => {
    const { document } = makeScene('hover-noann', 'def other() -> int:\n    pass\n');
    const provider = new KBEngineHoverProvider();
    const hover = await provider.provideHover(document, new Position(0, 5));
    expect(hover).toBeNull();
  });
});

describe('createInferredMirrorHover 直接面', () => {
  it('非标识符词 → null', () => {
    const { document } = makeScene('word-bad', MIR_TEXT);
    expect(createInferredMirrorHover(document, 'not-a-word')).toBeNull();
  });

  it('非 python 文档也可读镜像(调用方闸语言;本面只管词与镜像)', () => {
    // 直接面不重复闸 languageId(hover 链已闸);这里只验证词合法时的读取路径
    const root = makeRoot('direct');
    const srcPath = path.join(root, 'scripts', 'a.py');
    fs.mkdirSync(path.dirname(srcPath), { recursive: true });
    fs.writeFileSync(srcPath, 'x = 1\n');
    const mirPath = path.join(root, '.kbengine', 'inferred', 'scripts', 'a.py');
    fs.mkdirSync(path.dirname(mirPath), { recursive: true });
    fs.writeFileSync(mirPath, 'x: int = 1\n');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const document = makeTextDocument('x = 1\n', { fileName: srcPath, languageId: 'python' });
    const hover = createInferredMirrorHover(document, 'x');
    expect(hover).not.toBeNull();
    expect(hoverValue(hover!)).toContain('**推断类型**: `int`');
  });
});

describe('InferredMirrorTypeInlayHintsProvider', () => {
  const WHOLE = new Range(new Position(0, 0), new Position(64, 0));

  it('源缺注解而镜像同行有 → 形参/返回/赋值三类提示', () => {
    const { document } = makeScene('inlay', MIR_TEXT);
    const hints = new InferredMirrorTypeInlayHintsProvider().provideInlayHints(document, WHOLE);
    expect(hints.map(h => [h.position.line, h.position.character, h.label])).toEqual([
      [0, 13, '-> int'],
      [4, 5, ': int']
    ]);
    expect(hints.every(h => h.kind === 1)).toBe(true); // InlayHintKind.Type
  });

  it('可视区外行不出提示', () => {
    const { document } = makeScene('inlay-window', MIR_TEXT);
    const hints = new InferredMirrorTypeInlayHintsProvider().provideInlayHints(
      document,
      new Range(new Position(4, 0), new Position(4, 10))
    );
    expect(hints.map(h => h.position.line)).toEqual([4]);
  });

  it('infer.enabled=false(镜像生产总闸)→ 空', () => {
    configurationOverrides.set('kbengine', { 'infer.enabled': false });
    const { document } = makeScene('inlay-off', MIR_TEXT);
    expect(new InferredMirrorTypeInlayHintsProvider().provideInlayHints(document, WHOLE)).toEqual([]);
  });

  it('镜像缺失 → 空', () => {
    const { document } = makeScene('inlay-miss', null);
    expect(new InferredMirrorTypeInlayHintsProvider().provideInlayHints(document, WHOLE)).toEqual([]);
  });

  it('非 python 文档 → 空', () => {
    const { document } = makeScene('inlay-lang', MIR_TEXT);
    const defDoc = makeTextDocument('<Properties>\n</Properties>\n', {
      fileName: path.join(path.dirname(document.fileName), 'Avatar.def'),
      languageId: 'kbengine-def'
    });
    expect(new InferredMirrorTypeInlayHintsProvider().provideInlayHints(defDoc, WHOLE)).toEqual([]);
  });
});

describe('T-04 禁遮蔽:镜像绝不进导入解析', () => {
  it('extraPaths 计划输出恒无镜像目录条目', () => {
    const plan = planPythonExtraPaths({
      workspaceRoot: '/ws',
      currentPaths: [],
      previouslyManaged: [],
      deps: { exists: (): boolean => true, listSubdirs: (): string[] => [] }
    });
    expect(plan.nextPaths.length).toBeGreaterThan(0);
    for (const entry of plan.nextPaths) {
      expect(entry.toLowerCase()).not.toContain('inferred');
    }
  });

  it('extraPaths/存根导出源码不引用镜像消费面(静态审计)', () => {
    for (const file of ['src/pythonExtraPaths.ts', 'src/pythonStubExport.ts']) {
      const text = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(text.match(/inferredDirFor|inferredMirrorLookup|inferredEnrichment/)).toBeNull();
    }
  });
});
