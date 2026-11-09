import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { makeTextDocument, Position, Uri, workspace } from './helpers/vscodeStub';
import {
  KBEngineCompletionProvider,
  getAddSpaceGeometryStringPrefix,
  getKnownTypeSuggestions
} from '../src/languageProviders/completion';
import { KodeCoreGate, type ShadowClientLike } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { resetScanRootCache } from '../src/scanRoots';

/**
 * completion.ts 补臂:
 * 既有 completion 系测试(kodeCompletionServing / kodeCompletionParity /
 * navPathCompletion / defCompletionCancellation)已覆盖主面;本文件专门补基线
 * 缺口语句:
 *   - getAddSpaceGeometryStringPrefix:无 '('[228]/字符串内转义[237,238]/
 *     离开调用(depth<=0)[253-255]
 *   - provideCompletionRustFirst 取消检查(await 后 token 已取消)→ [] [322]
 *   - provideNavPathCompletions:findFiles await 后取消 → [] [494]
 *   - getKnownTypeSuggestions 别名指向循环(workspaceRoot 非空且未取消;≥2
 *     个别名触发 sort 比较器)[669]
 *
 * 死臂(公开 API + 真实输入不可达,不强制测试):
 *   - provideCompletionItemsSync 行 336 `if (token?.isCancellationRequested)
 *     return null;`:provideCompletionItems 入口行 304 已先查一次取消;非 rust
 *     路径行 312 同步直调本方法,rust 路径行 322 在 await 后先查一次取消。
 *     两径自 304/322 至 336 之间均无 await(token 状态不可能翻转变真),故 336
 *     恒假、返回臂不可达。
 *   - provideNavPathCompletions 行 487 `return []`:同样地,自 provider 入口
 *     取消检查(304 或 322)至 486 之间无 await,进入时 token 已确定为未取消,
 *     486 恒假、返回臂不可达。
 *   - provideNavPathCompletions 行 508 `if (seen.has(rel)) continue;` 的
 *     continue 臂:findFilesAcrossRoots 已按 normalizeForCompare(fsPath)(path
 *     .resolve + 反斜杠归一 + 盘符小写)在 Map 层去重,进入本循环的任意两个
 *     URI 归一化 fsPath 互异;而 rel = root ? relative(root, fsPath) : abs 对
 *     固定 root 在归一化互异的 fsPath 上单射(relative/abs 内部 resolve 亦
 *     归一),故不可能同 rel,seen.has 恒假、continue 不可达。
 */

const DEF_URI = '/workspace/demo/scripts/entity_defs/Avatar.def';

function makeGate(client: ShadowClientLike, backend = 'rust'): KodeCoreGate {
  const gate = new KodeCoreGate({ clientFactory: () => client });
  gate.setConfig({ backend, serverPath: 'node:stub', shadowTimeoutMs: 500 });
  return gate;
}

/** 确定性地冲刷微任务队列,直到谓词满足或达上限(无真实定时器)。 */
async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

describe('getAddSpaceGeometryStringPrefix 词法补臂', () => {
  it('调用后同行无左括号 → null', () => {
    expect(getAddSpaceGeometryStringPrefix('x = self.addSpaceGeometryMapping')).toBeNull();
  });

  it('字符串内反斜杠转义跳过一个字符,前缀含转义内容', () => {
    // `("a\"` 光标在开字符串内:转义引号是内容,prefix = `a"`(a+反斜杠+引号)
    expect(getAddSpaceGeometryStringPrefix('addSpaceGeometryMapping("a\\"')).toEqual({
      prefix: 'a\\"'
    });
  });

  it('离开调用(闭括号回落到深度 0)→ null', () => {
    expect(getAddSpaceGeometryStringPrefix('addSpaceGeometryMapping("a")')).toBeNull();
  });
});

describe('provideCompletionRustFirst await 后取消', () => {
  it('Rust 请求在途时调用方取消 → 返回 []', async () => {
    let releaseRequest!: (value: unknown) => void;
    const requestCalled = vi.fn((_method: string) => new Promise((resolve) => {
      releaseRequest = resolve;
    }));
    const client: ShadowClientLike = {
      start: vi.fn(async () => ({})),
      request: requestCalled as unknown as ShadowClientLike['request'],
      dispose: vi.fn(async () => undefined),
      openDocument: vi.fn(() => undefined),
      changeDocument: vi.fn(() => undefined),
      closeDocument: vi.fn(() => undefined),
    };
    setKodeCoreShadowGate(makeGate(client));
    const tokenState = { cancelled: false };
    const token = {
      get isCancellationRequested() {
        return tokenState.cancelled;
      },
      onCancellationRequested: () => ({ dispose() {} }),
    };
    const provider = new KBEngineCompletionProvider();
    const document = makeTextDocument('        <Properties>', {
      fileName: DEF_URI,
      languageId: 'kbengine-def',
      version: 1
    });
    const promise = provider.provideCompletionItems(
      document,
      new Position(0, 19),
      token as never
    ) as Promise<unknown>;
    await flushUntil(() => requestCalled.mock.calls.length > 0);
    tokenState.cancelled = true; // 在 Rust 请求 in-flight 时取消
    releaseRequest({ isIncomplete: false, items: [] });
    expect(await promise).toEqual([]);
  });
});

describe('provideNavPathCompletions 补臂', () => {
  const ORIGINAL_FIND = workspace.findFiles;
  const ORIGINAL_FOLDERS = workspace.workspaceFolders;
  const LINE = 'KBEngine.addSpaceGeometryMapping(0, None, "';

  beforeEach(() => {
    resetScanRootCache();
    setKodeCoreShadowGate(null); // 非 rust 轨道,走 TS 既有链路
    workspace.workspaceFolders = [{ uri: Uri.file('D:/ws'), name: 'ws', index: 0 }];
  });

  afterEach(() => {
    workspace.findFiles = ORIGINAL_FIND;
    workspace.workspaceFolders = ORIGINAL_FOLDERS;
    resetScanRootCache();
  });

  const makeToken = () => {
    const state = { cancelled: false };
    return {
      state,
      token: {
        get isCancellationRequested() {
          return state.cancelled;
        },
        onCancellationRequested: () => ({ dispose() {} }),
      },
    };
  };

  it('findFiles await 期间取消 → 返回 []', async () => {
    const pending: Array<(v: unknown) => void> = [];
    workspace.findFiles = ((_pattern: unknown) => new Promise((resolve) => {
      pending.push(resolve);
    })) as typeof workspace.findFiles;
    const { state, token } = makeToken();
    const provider = new KBEngineCompletionProvider();
    const document = makeTextDocument(`${LINE}\n`, {
      fileName: 'D:/ws/scripts/cell/kbemain.py',
      languageId: 'python'
    });
    const promise = provider.provideCompletionItems(
      document,
      new Position(0, LINE.length),
      token as never
    ) as Promise<unknown>;
    await flushUntil(() => pending.length >= 2);
    state.cancelled = true;
    for (const resolve of pending) resolve([]);
    expect(await promise).toEqual([]);
  });

  it('同一文件被重复发现(navmesh 扫描撞名)只出一次:去重发生在 findFilesAcrossRoots', async () => {
    // 去重面在 findFilesAcrossRoots 的 fsPath Map(normalizeForCompare),非本
    // provider 的 seen[508](该 continue 臂经上游去重后不可达,见文件头死臂)。
    // 本用例锁住「重复扫描结果不产生重复补全项」的对外行为。
    const dup = Uri.file('D:/ws/res/spaces/dup.navmesh');
    workspace.findFiles = (async (pattern?: string) => {
      if (typeof pattern === 'string' && pattern.includes('navmesh')) return [dup, dup];
      return [];
    }) as typeof workspace.findFiles;
    const provider = new KBEngineCompletionProvider();
    const document = makeTextDocument(`${LINE}\n`, {
      fileName: 'D:/ws/scripts/cell/kbemain.py',
      languageId: 'python'
    });
    const items = (await provider.provideCompletionItems(
      document,
      new Position(0, LINE.length)
    )) as { label: unknown }[];
    expect(items).toHaveLength(1);
    expect(String(items[0].label)).toContain('dup.navmesh');
  });
});

describe('getKnownTypeSuggestions 别名指向循环', () => {
  const ORIGINAL_FOLDERS = workspace.workspaceFolders;

  afterEach(() => {
    workspace.workspaceFolders = ORIGINAL_FOLDERS;
    setKodeCoreShadowGate(null);
  });

  it('workspace 根内注册 alias.xml → 别名指向进入补全面', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-completion-alias-'));
    try {
      const defsDir = path.join(root, 'scripts', 'entity_defs');
      fs.mkdirSync(defsDir, { recursive: true });
      fs.writeFileSync(
        path.join(defsDir, 'alias.xml'),
        '<root>\n  <MyAlias><Type>UINT8</Type></MyAlias>\n  <AnotherAlias><Type>STRING</Type></AnotherAlias>\n</root>\n'
      );
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      const document = makeTextDocument('x = 1', {
        fileName: path.join(root, 'scripts', 'cell', 'Avatar.py'),
        languageId: 'python'
      });
      const suggestions = getKnownTypeSuggestions(document);
      // 两个别名 → sort 比较器实际被调用(单别名时比较器不触发)
      const names = suggestions.map(s => s.name);
      expect(names).toContain('MyAlias');
      expect(names).toContain('AnotherAlias');
      // 字典序稳定:AnotherAlias < MyAlias
      expect(names.indexOf('AnotherAlias')).toBeLessThan(names.indexOf('MyAlias'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
