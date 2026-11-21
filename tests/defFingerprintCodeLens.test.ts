import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { makeTextDocument } from './helpers/vscodeStub';
import { languagesRegistry } from './fake-vscode/languages';
import {
  DefFingerprintCodeLensProvider,
  DEF_FINGERPRINT_CODE_LENS_LANGUAGE,
  defaultDefFingerprintCodeLensDeps,
  findDefRootLine,
  setupDefFingerprintCodeLens,
  type DefFingerprintCodeLensDeps
} from '../src/defFingerprintCodeLens';
import { DEF_FINGERPRINT_INSPECTOR_COMMAND, type DefFingerprintDeps } from '../src/defFingerprintInspector';
import type { DefFingerprintSnapshot } from '../src/backend/hotReloadDefFingerprintLedger';

// RUST-400(HR-HASH-013)①:.def 编辑器 CodeLens——根元素行挂 sha256+语义短
// hash,点击开 Inspector;懒加载(只算当前可见文档)。判据:
// - 非 kbengine-def 语言 → 无 lens;
// - 读不到(compute=null)→ 无 lens(如实缺,不冒充);
// - 指纹 lens 挂在根元素行,title 含 sha256 前 12 位 + 语义短 hash;
// - 语义解析失败 → title 标「解析失败」(不猜不补);
// - refresh 触发 onDidChangeCodeLenses。

const FILE = '/ws/entity_defs/Avatar.def';

const snapshot = (overrides: Partial<DefFingerprintSnapshot> = {}): DefFingerprintSnapshot => ({
  fileHash: 'a'.repeat(64),
  byteLength: 42,
  semanticHash: 'b'.repeat(32),
  source: 'disk',
  at: 1000,
  durationMs: 1,
  ...overrides
});

const makeProvider = (compute: (fsPath: string) => DefFingerprintSnapshot | null): DefFingerprintCodeLensProvider =>
  new DefFingerprintCodeLensProvider({ compute });

const lensOf = (
  provider: DefFingerprintCodeLensProvider,
  text: string,
  languageId: string = DEF_FINGERPRINT_CODE_LENS_LANGUAGE
): vscode.CodeLens[] => {
  const document = makeTextDocument(text, { fileName: FILE, languageId });
  return provider.provideCodeLenses(document as unknown as vscode.TextDocument);
};

describe('RUST-400 findDefRootLine(.def 根元素行)', () => {
  it('根元素首行 = 0;prolog/注释/空白行跳过', () => {
    expect(findDefRootLine('<root>\n</root>')).toBe(0);
    expect(findDefRootLine('<?xml version="1.0"?>\n<!-- 注释 -->\n\n<root>\n</root>')).toBe(3);
  });

  it('无 XML 元素(纯注释/空)→ 第 0 行占位(不挂空)', () => {
    expect(findDefRootLine('<!-- only comment -->')).toBe(0);
    expect(findDefRootLine('')).toBe(0);
  });
});

describe('RUST-400 DefFingerprintCodeLensProvider(.def 指纹 CodeLens)', () => {
  it('非 kbengine-def 语言 → 无 lens', () => {
    const provider = makeProvider(() => snapshot());
    expect(lensOf(provider, '<root/>', 'python')).toEqual([]);
  });

  it('读不到(compute=null)→ 无 lens(如实缺)', () => {
    const provider = makeProvider(() => null);
    expect(lensOf(provider, '<root/>')).toEqual([]);
  });

  it('指纹 lens 挂根元素行,title 含 sha256 前 12 位 + 语义短 hash + Hash 详情', () => {
    const provider = makeProvider(() => snapshot());
    const lenses = lensOf(provider, '<?xml version="1.0"?>\n<root>\n  <Properties/>\n</root>');
    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.range.start.line).toBe(1);
    expect(lenses[0]!.command).toMatchObject({ command: DEF_FINGERPRINT_INSPECTOR_COMMAND });
    const title = (lenses[0]!.command as vscode.Command).title;
    expect(title).toContain('sha256:aaaaaaaaaaaa');
    expect(title).toContain('语义:bbbbbbbbbbbb');
    expect(title).toContain('Hash 详情');
  });

  it('语义解析失败 → title 标「解析失败」(不猜不补)', () => {
    const provider = makeProvider(() => snapshot({ semanticHash: null }));
    const lenses = lensOf(provider, '<root/>');
    expect((lenses[0]!.command as vscode.Command).title).toContain('语义:解析失败');
  });

  it('refresh 触发 onDidChangeCodeLenses', () => {
    const provider = makeProvider(() => snapshot());
    let fired = 0;
    provider.onDidChangeCodeLenses(() => {
      fired += 1;
    });
    provider.refresh();
    expect(fired).toBe(1);
  });
});

describe('RUST-400 defaultDefFingerprintCodeLensDeps(缺省依赖复用 Inspector 读面)', () => {
  it('compute 委托 computeDefFingerprintSnapshot(同 deps 同读面)', () => {
    const fingerprintDeps: DefFingerprintDeps = {
      readSnapshot: fsPath =>
        fsPath === FILE
          ? { content: '<root/>', source: 'disk' }
          : null,
      now: () => 1000,
      lastMd5Check: () => null
    };
    const deps = defaultDefFingerprintCodeLensDeps(fingerprintDeps);
    const result = deps.compute(FILE);
    expect(result).not.toBeNull();
    expect(result!.fileHash).toHaveLength(64);
    // 读不到 = null(如实缺)
    expect(deps.compute('/ws/missing.def')).toBeNull();
  });
});

describe('RUST-400 setupDefFingerprintCodeLens(装配注册)', () => {
  it('注册 kbengine-def 的 CodeLens provider 并返回 provider', () => {
    languagesRegistry.codeLensRegistrations.length = 0;
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const provider = setupDefFingerprintCodeLens(context, { compute: () => snapshot() });
    expect(languagesRegistry.codeLensRegistrations).toHaveLength(1);
    expect(languagesRegistry.codeLensRegistrations[0]!.selector).toEqual({
      language: DEF_FINGERPRINT_CODE_LENS_LANGUAGE
    });
    expect(provider).toBeInstanceOf(DefFingerprintCodeLensProvider);
    expect(context.subscriptions).toHaveLength(1);
  });
});
