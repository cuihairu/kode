import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import { Uri } from './fake-vscode/core';
import { workspace } from './fake-vscode/workspaceState';
import {
  CORPUS_MIRROR_GLOBS,
  corpusMirrorLanguageId,
  mirrorCorpusToRust,
  type CorpusFileFinder
} from '../src/kodeCoreCorpusMirror';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';

// 2026-11-08 用户令「直接切到 rust」:服务轨道语料镜像。Rust 的类型/实体/
// 别名/继承链只由已镜像文档入库——镜像腿把工作区静态语料全量 didOpen 给
// Rust。验收:非服务轨道零开销;def/xml 语料按正确 languageId/version/文本
// 入镜像;已打开文档优先用编辑器内容;失败静默不阻塞。

interface MirroredCall {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

/** 暖门调用记录(RUST-074-W):begin 总数 / complete [done,failed] / cancel 次数 */
interface WarmGateCalls {
  begins: number[];
  completions: Array<[number, number]>;
  cancels: number;
}

/** ad-hoc gate 补齐暖门四面(镜像现在直调 begin/complete/cancel,缺桩即炸) */
function makeWarmStubs(warm: WarmGateCalls): Record<string, unknown> {
  return {
    beginBackgroundScan: async (total: number) => {
      warm.begins.push(total);
      return { state: 'warming' };
    },
    scanComplete: async (done: number, failed: number) => {
      warm.completions.push([done, failed]);
      return { state: 'warm' };
    },
    scanCancel: async () => {
      warm.cancels += 1;
      return { state: 'idle' };
    }
  };
}

function makeFakeGate(serving = true): {
  gate: Pick<
    KodeCoreGate,
    'serveFromRust' | 'mirrorDocument' | 'beginBackgroundScan' | 'scanComplete' | 'scanCancel'
  >;
  calls: MirroredCall[];
  warm: WarmGateCalls;
  servingFlag: { value: boolean };
} {
  const calls: MirroredCall[] = [];
  const warm: WarmGateCalls = { begins: [], completions: [], cancels: 0 };
  const servingFlag = { value: serving };
  return {
    servingFlag,
    calls,
    warm,
    gate: {
      serveFromRust: () => servingFlag.value,
      ...makeWarmStubs(warm),
      mirrorDocument: async (uri, languageId, version, text) => {
        calls.push({ uri, languageId, version, text });
      }
    } as unknown as KodeCoreGate
  };
}

/** 注入替身 finder:按 glob 返回一组真实路径 Uri(记录请求的 glob) */
function makeFinder(filesByGlob: Record<string, string[]>, requested: string[]): CorpusFileFinder {
  return async (glob: string) => {
    requested.push(glob);
    return (filesByGlob[glob] ?? []).map(Uri.file);
  };
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-corpus-'));
  workspace.textDocuments = [];
});

/** 写盘走 fake workspace.fs 内存表(其 readFile 只认内存表,不读真实盘) */
const writeCorpusFile = async (fsPath: string, content: string): Promise<void> => {
  await workspace.fs.writeFile(Uri.file(fsPath), Buffer.from(content, 'utf8'));
};

describe('kodeCoreCorpusMirror 服务轨道语料镜像', () => {
  it('语料 glob 集合:def + 三类 XML 全量发现', () => {
    expect(CORPUS_MIRROR_GLOBS).toEqual([
      '**/*.def',
      '**/types.xml',
      '**/entities.xml',
      '**/alias.xml'
    ]);
  });

  it('corpusMirrorLanguageId:def → kbengine-def,语料 XML → xml', () => {
    expect(corpusMirrorLanguageId('/w/Avatar.def')).toBe('kbengine-def');
    expect(corpusMirrorLanguageId('/w/scripts/types.xml')).toBe('xml');
    expect(corpusMirrorLanguageId('/w/scripts/entities.xml')).toBe('xml');
    expect(corpusMirrorLanguageId('/w/scripts/alias.xml')).toBe('xml');
  });

  it('非服务轨道:零镜像零发现,零开销', async () => {
    const { gate, calls } = makeFakeGate(false);
    const requested: string[] = [];
    await mirrorCorpusToRust(gate as KodeCoreGate, makeFinder({}, requested));
    expect(calls).toEqual([]);
    expect(requested).toEqual([]);
  });

  it('服务轨道:def 与三类 XML 从盘镜像,languageId/version/text 正确', async () => {
    const defPath = path.join(tempRoot, 'Avatar.def');
    const typesPath = path.join(tempRoot, 'types.xml');
    const entitiesPath = path.join(tempRoot, 'entities.xml');
    const aliasPath = path.join(tempRoot, 'alias.xml');
    
    await writeCorpusFile(defPath, '<root>\n<Properties/>\n</root>\n');
    
    await writeCorpusFile(typesPath, '<types/>\n');
    
    await writeCorpusFile(entitiesPath, '<root>\n<Entity name="Avatar"/>\n</root>\n');
    
    await writeCorpusFile(aliasPath, '<root/>\n');
    const { gate, calls } = makeFakeGate(true);
    const requested: string[] = [];
    await mirrorCorpusToRust(
      gate as KodeCoreGate,
      makeFinder(
        {
          '**/*.def': [defPath],
          '**/types.xml': [typesPath],
          '**/entities.xml': [entitiesPath],
          '**/alias.xml': [aliasPath]
        },
        requested
      )
    );
    // 四类语料全部入镜像(无重复,按路径去重)
    expect(calls.map(call => call.uri).sort()).toEqual(
      [defPath, typesPath, entitiesPath, aliasPath].sort()
    );
    const defCall = calls.find(call => call.uri === defPath)!;
    expect(defCall.languageId).toBe('kbengine-def');
    expect(defCall.version).toBe(1);
    expect(defCall.text).toContain('<Properties/>');
    const typesCall = calls.find(call => call.uri === typesPath)!;
    expect(typesCall.languageId).toBe('xml');
  });

  it('已打开文档优先:用编辑器内容与版本,不用盘上快照', async () => {
    const defPath = path.join(tempRoot, 'Avatar.def');
    
    await writeCorpusFile(defPath, '<root>disk</root>\n');
    // 打开文档(未保存修订:版本 3,内容与盘不同)
    workspace.textDocuments = [
      {
        uri: Uri.file(defPath),
        languageId: 'kbengine-def',
        version: 3,
        getText: () => '<root>unsaved edits</root>\n'
      }
    ];
    const { gate, calls } = makeFakeGate(true);
    await mirrorCorpusToRust(
      gate as KodeCoreGate,
      makeFinder({ '**/*.def': [defPath] }, [])
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].version).toBe(3);
    expect(calls[0].text).toContain('unsaved edits');
  });

  it('初扫优先级:已打开语料文档排前镜像,其余保持发现序(RUST-125)', async () => {
    const a = path.join(tempRoot, 'a.def');
    const b = path.join(tempRoot, 'b.def');
    const c = path.join(tempRoot, 'c.def');
    for (const p of [a, b, c]) {
      await writeCorpusFile(p, '<root/>\n');
    }
    // 打开 b(发现序 = a,b,c):镜像顺序须为 b,a,c。
    workspace.textDocuments = [
      {
        uri: Uri.file(b),
        languageId: 'kbengine-def',
        version: 3,
        getText: () => '<root>unsaved</root>\n'
      }
    ];
    const { gate, calls } = makeFakeGate(true);
    await mirrorCorpusToRust(
      gate as KodeCoreGate,
      makeFinder({ '**/*.def': [a, b, c] }, [])
    );
    const mirrored = calls.map(call => call.uri);
    expect(mirrored).toEqual([Uri.file(b).fsPath, Uri.file(a).fsPath, Uri.file(c).fsPath]);
    // 打开文档镜像用编辑器内容(优先面不只顺序,内容同口径)。
    expect(calls[0].text).toContain('unsaved');
  });

  it('同一文件被多 glob 命中:按路径去重不重复镜像', async () => {
    const defPath = path.join(tempRoot, 'Avatar.def');
    
    await writeCorpusFile(defPath, '<root/>\n');
    const { gate, calls } = makeFakeGate(true);
    // 两个 glob 都返回同一文件
    await mirrorCorpusToRust(
      gate as KodeCoreGate,
      makeFinder(
        { '**/*.def': [defPath], '**/types.xml': [defPath] },
        []
      )
    );
    expect(calls).toHaveLength(1);
  });

  it('发现失败(单个 glob 抛):按已得集合继续,不抛', async () => {
    const defPath = path.join(tempRoot, 'Avatar.def');
    
    await writeCorpusFile(defPath, '<root/>\n');
    const { gate, calls } = makeFakeGate(true);
    const finder: CorpusFileFinder = async glob => {
      if (glob === '**/types.xml') {
        throw new Error('glob failed');
      }
      return glob === '**/*.def' ? [Uri.file(defPath)] : [];
    };
    await expect(mirrorCorpusToRust(gate as KodeCoreGate, finder)).resolves.toBeUndefined();
    expect(calls.map(call => call.uri)).toEqual([defPath]);
  });

  it('镜像失败静默(不抛,不中断后续文件),计入 failed', async () => {
    const defPath = path.join(tempRoot, 'Avatar.def');
    const typesPath = path.join(tempRoot, 'types.xml');

    await writeCorpusFile(defPath, '<root/>\n');

    await writeCorpusFile(typesPath, '<types/>\n');
    const calls: MirroredCall[] = [];
    const warm: WarmGateCalls = { begins: [], completions: [], cancels: 0 };
    const gate = {
      serveFromRust: () => true,
      ...makeWarmStubs(warm),
      mirrorDocument: async (uri: string, languageId: string, version: number, text: string) => {
        calls.push({ uri, languageId, version, text });
        if (uri === defPath) {
          throw new Error('mirror failed');
        }
      }
    } as unknown as KodeCoreGate;
    await expect(
      mirrorCorpusToRust(gate, makeFinder({ '**/*.def': [defPath], '**/types.xml': [typesPath] }, []))
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(2); // 失败的不中断后续
    // RUST-074-W:完成回执带真实计数(1 成功 1 失败)。
    expect(warm.completions).toEqual([[1, 1]]);
  });

  it('镜像期间切走服务轨道:cancel 回 Idle 不留假 pending,不发 complete', async () => {
    const defPath = path.join(tempRoot, 'Avatar.def');
    const typesPath = path.join(tempRoot, 'types.xml');

    await writeCorpusFile(defPath, '<root/>\n');

    await writeCorpusFile(typesPath, '<types/>\n');
    const { gate, calls, servingFlag, warm } = makeFakeGate(true);
    const gateWithStop = {
      serveFromRust: () => {
        // 第一个文件镜像后切走服务轨道
        if (calls.length >= 1) {
          servingFlag.value = false;
        }
        return servingFlag.value;
      },
      ...makeWarmStubs(warm),
      mirrorDocument: gate.mirrorDocument
    } as unknown as KodeCoreGate;
    await mirrorCorpusToRust(
      gateWithStop,
      makeFinder({ '**/*.def': [defPath], '**/types.xml': [typesPath] }, [])
    );
    expect(calls.length).toBeLessThanOrEqual(1);
    // RUST-074-W:中断走 cancel(回 Idle),绝不 complete(Warm 假账)。
    expect(warm.begins).toEqual([2]);
    expect(warm.cancels).toBe(1);
    expect(warm.completions).toEqual([]);
  });

  it('暖门接线:begin(总数) 先于镜像,complete(done,failed) 后于镜像', async () => {
    const defPath = path.join(tempRoot, 'Avatar.def');
    const typesPath = path.join(tempRoot, 'types.xml');

    await writeCorpusFile(defPath, '<root/>\n');

    await writeCorpusFile(typesPath, '<types/>\n');
    const ops: string[] = [];
    const gate = {
      serveFromRust: () => true,
      beginBackgroundScan: async (total: number) => {
        ops.push(`begin:${total}`);
        return { state: 'warming' };
      },
      scanComplete: async (done: number, failed: number) => {
        ops.push(`complete:${done},${failed}`);
        return { state: 'warm' };
      },
      scanCancel: async () => {
        ops.push('cancel');
        return { state: 'idle' };
      },
      mirrorDocument: async (uri: string) => {
        ops.push(`mirror:${uri}`);
      }
    } as unknown as KodeCoreGate;
    await mirrorCorpusToRust(
      gate,
      makeFinder({ '**/*.def': [defPath], '**/types.xml': [typesPath] }, [])
    );
    // begin 在任何镜像前;complete 收尾且计数齐全;全程无 cancel。
    expect(ops[0]).toBe('begin:2');
    expect(ops[ops.length - 1]).toBe('complete:2,0');
    expect(ops.filter(op => op.startsWith('mirror:'))).toHaveLength(2);
    expect(ops).not.toContain('cancel');
  });

  it('暖门计数:读盘失败计入 failed(成功文件数+失败数=begin 总数)', async () => {
    const defPath = path.join(tempRoot, 'Avatar.def');
    const missingPath = path.join(tempRoot, 'Ghost.def');

    await writeCorpusFile(defPath, '<root/>\n');
    const { gate, warm } = makeFakeGate(true);
    // Ghost.def 被发现但读盘失败(内存表无内容)。
    await mirrorCorpusToRust(
      gate,
      makeFinder({ '**/*.def': [defPath, missingPath] }, [])
    );
    expect(warm.begins).toEqual([2]);
    expect(warm.completions).toEqual([[1, 1]]);
  });
});

// RUST-069-W:根生命周期先行——镜像入口先注册扫描根(registerRoot),再镜像
// 语料(didOpen 根归属依赖根已注册)。外部 assetsRoot 根不在 initialize
// 握手里,只能走这条先行面。
describe('kodeCoreCorpusMirror 根生命周期先行(RUST-069-W)', () => {
  it('先 registerRoot 全部扫描根,再镜像首个文档(顺序不可倒置)', async () => {
    const defPath = path.join(tempRoot, 'Avatar.def');
    await writeCorpusFile(defPath, '<root/>\n');
    const ops: string[] = [];
    const registeredRoots: string[] = [];
    const gate = {
      serveFromRust: () => true,
      ...makeWarmStubs({ begins: [], completions: [], cancels: 0 }),
      registerRoot: async (fsPath: string) => {
        ops.push(`registerRoot:${fsPath}`);
        registeredRoots.push(fsPath);
        return { root: registeredRoots.length };
      },
      mirrorDocument: async (uri: string) => {
        ops.push(`mirror:${uri}`);
      }
    } as unknown as KodeCoreGate;
    await mirrorCorpusToRust(
      gate,
      makeFinder({ '**/*.def': [defPath] }, []),
      () => ['/ws/a', '/assets/external']
    );
    const firstMirrorAt = ops.findIndex(op => op.startsWith('mirror:'));
    expect(firstMirrorAt).toBeGreaterThan(-1);
    expect(ops.slice(0, firstMirrorAt)).toEqual([
      'registerRoot:/ws/a',
      'registerRoot:/assets/external'
    ]);
    expect(ops[firstMirrorAt]).toBe(`mirror:${defPath}`);
  });

  it('扫描根提供者异常:回空数组继续镜像(根面静默,不误伤语料)', async () => {
    const defPath = path.join(tempRoot, 'Avatar.def');
    await writeCorpusFile(defPath, '<root/>\n');
    const calls: MirroredCall[] = [];
    const gate = {
      serveFromRust: () => true,
      ...makeWarmStubs({ begins: [], completions: [], cancels: 0 }),
      registerRoot: async () => {
        throw new Error('roots failed');
      },
      mirrorDocument: async (uri: string, languageId: string, version: number, text: string) => {
        calls.push({ uri, languageId, version, text });
      }
    } as unknown as KodeCoreGate;
    await expect(
      mirrorCorpusToRust(gate, makeFinder({ '**/*.def': [defPath] }, []), () => {
        throw new Error('scan roots provider failed');
      })
    ).resolves.toBeUndefined();
    expect(calls.map(call => call.uri)).toEqual([defPath]);
  });
});
