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
import type { KodeCoreGate } from '../src/kodeCoreGate';

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

function makeFakeGate(serving = true): {
  gate: Pick<KodeCoreGate, 'serveFromRust' | 'mirrorDocument'>;
  calls: MirroredCall[];
  servingFlag: { value: boolean };
} {
  const calls: MirroredCall[] = [];
  const servingFlag = { value: serving };
  return {
    servingFlag,
    calls,
    gate: {
      serveFromRust: () => servingFlag.value,
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

  it('镜像失败静默(不抛,不中断后续文件)', async () => {
    const defPath = path.join(tempRoot, 'Avatar.def');
    const typesPath = path.join(tempRoot, 'types.xml');
    
    await writeCorpusFile(defPath, '<root/>\n');
    
    await writeCorpusFile(typesPath, '<types/>\n');
    const calls: MirroredCall[] = [];
    const gate = {
      serveFromRust: () => true,
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
  });

  it('镜像期间切走服务轨道:停止补镜像', async () => {
    const defPath = path.join(tempRoot, 'Avatar.def');
    const typesPath = path.join(tempRoot, 'types.xml');
    
    await writeCorpusFile(defPath, '<root/>\n');
    
    await writeCorpusFile(typesPath, '<types/>\n');
    const { gate, calls, servingFlag } = makeFakeGate(true);
    const gateWithStop = {
      serveFromRust: () => {
        // 第一个文件镜像后切走服务轨道
        if (calls.length >= 1) {
          servingFlag.value = false;
        }
        return servingFlag.value;
      },
      mirrorDocument: gate.mirrorDocument
    } as unknown as KodeCoreGate;
    await mirrorCorpusToRust(
      gateWithStop,
      makeFinder({ '**/*.def': [defPath], '**/types.xml': [typesPath] }, [])
    );
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});
