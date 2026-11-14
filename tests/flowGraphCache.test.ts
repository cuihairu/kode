import { describe, expect, it } from 'vitest';
import { resolveFlowCallSites } from '../src/backend/flowCallResolver';
import {
  createFlowIncrementalIndex,
  type FlowAssemblyDep,
  type FlowIncrementalIndex,
  type FlowParseRequest
} from '../src/backend/flowGraphCache';

// FLOW-013(旧 KFLOW-CORE-13)图增量失效钉。
// 验收:改实现/def/角色映射只更新相关节点和调用方;删除、重命名、未保存
// 文本及跨根隔离有验证。

const FILE_A = '/ws/scripts/base/A.py';
const FILE_A2 = '/ws/scripts/base/A2.py';
const FILE_B = '/ws/scripts/cell/B.py';
const FILE_C = '/ws/scripts/base/C.py';

const TEXT_A = 'class Avatar:\n    def fire(self):\n        pass\n';
// 解析器只为参与调用的函数建节点(叶方法不产节点):A2 文本带一次调用保证有节点
const TEXT_A2 = 'class Avatar:\n    def fire(self):\n        self.base.ping()\n';
const TEXT_B = 'class Avatar:\n    def use(self):\n        pass\n';
const TEXT_C = 'class Other:\n    def solo(self):\n        pass\n';

const makeIndex = () => {
  const parseCalls: string[] = [];
  const index: FlowIncrementalIndex = createFlowIncrementalIndex({
    parse: request => {
      parseCalls.push(`${request.rootKey}\u001f${request.filePath}\u001f${request.versionKey}`);
      return resolveFlowCallSites(request);
    }
  });
  return { index, parseCalls };
};

const req = (filePath: string, versionKey: string, text: string): FlowParseRequest => ({
  rootKey: '/ws',
  filePath,
  versionKey,
  text
});

const dep = (rootKey: string, filePath: string, versionKey: string): FlowAssemblyDep => ({
  rootKey,
  filePath,
  versionKey
});

const buildLinks = (index: FlowIncrementalIndex, deps: FlowAssemblyDep[]) =>
  index.buildAssembly('links', deps, resolve => ({
    aNodes: resolve('/ws', FILE_A)?.nodes.length ?? -1,
    bNodes: resolve('/ws', FILE_B)?.nodes.length ?? -1
  }));

const buildOrphan = (index: FlowIncrementalIndex, versionKey: string) =>
  index.buildAssembly('orphan', [dep('/ws', FILE_C, versionKey)], resolve => ({
    cNodes: resolve('/ws', FILE_C)?.nodes.length ?? -1
  }));

describe('FLOW-013 解析缓存键控', () => {
  it('同键复用:同 (root,file,version) 不重解析;未保存文本=宿主换 versionKey 即重解析', () => {
    const { index, parseCalls } = makeIndex();
    expect(index.updateFile(req(FILE_A, 'v1', TEXT_A)).action).toBe('parsed');
    expect(index.updateFile(req(FILE_A, 'v1', TEXT_A)).action).toBe('reused');
    expect(parseCalls).toHaveLength(1);
    // 未保存文本走宿主文档身份协议:编辑即换键(字节甚至可能相同),缓存不脏读
    expect(index.updateFile(req(FILE_A, 'v2', TEXT_A)).action).toBe('parsed');
    expect(parseCalls).toHaveLength(2);
    expect(index.stats()).toEqual({ parseCount: 2, reuseCount: 1, assemblyBuilds: 0, assemblyReuses: 0 });
  });

  it('改实现只更新相关:links stale,依赖不含该文件的 orphan 原样复用', () => {
    const { index } = makeIndex();
    index.updateFile(req(FILE_A, 'v1', TEXT_A));
    index.updateFile(req(FILE_B, 'v1', TEXT_B));
    index.updateFile(req(FILE_C, 'v1', TEXT_C));
    const first = buildLinks(index, [dep('/ws', FILE_A, 'v1'), dep('/ws', FILE_B, 'v1')]);
    expect(first.reused).toBe(false);
    const orphan = buildOrphan(index, 'v1');
    expect(orphan.reused).toBe(false);

    // 改实现 A(换版)
    index.updateFile(req(FILE_A, 'v2', TEXT_A2));
    // 只更新相关:stale=links,不含 orphan(调用方=反向依赖,不陪绑)
    expect(index.staleAssemblies([{ rootKey: '/ws', filePath: FILE_A }])).toEqual(['links']);
    // links 依赖版本快照失配→重建(解析走 A 新版)
    const rebuilt = buildLinks(index, [dep('/ws', FILE_A, 'v2'), dep('/ws', FILE_B, 'v1')]);
    expect(rebuilt.reused).toBe(false);
    // orphan 依赖未变→复用(不再 build)
    const orphanAgain = buildOrphan(index, 'v1');
    expect(orphanAgain.reused).toBe(true);
    expect(orphanAgain.value).toEqual(orphan.value);
    expect(index.stats().assemblyReuses).toBe(1);
  });

  it('装配同依赖复用:依赖集与版本快照全等→reused,不再构建', () => {
    const { index } = makeIndex();
    index.updateFile(req(FILE_A, 'v1', TEXT_A));
    index.updateFile(req(FILE_B, 'v1', TEXT_B));
    const first = buildLinks(index, [dep('/ws', FILE_A, 'v1'), dep('/ws', FILE_B, 'v1')]);
    expect(first.reused).toBe(false);
    const again = buildLinks(index, [dep('/ws', FILE_A, 'v1'), dep('/ws', FILE_B, 'v1')]);
    expect(again.reused).toBe(true);
    expect(again.value).toEqual(first.value);
    // 依赖集合不同(少一个)→不复用,重建
    const narrowed = buildLinks(index, [dep('/ws', FILE_A, 'v1')]);
    expect(narrowed.reused).toBe(false);
  });
});

describe('FLOW-013 删除与重命名', () => {
  it('删除:解析丢弃+调用方装配列出;同版本再 update 是重新解析不是复用', () => {
    const { index, parseCalls } = makeIndex();
    index.updateFile(req(FILE_A, 'v1', TEXT_A));
    index.updateFile(req(FILE_B, 'v1', TEXT_B));
    buildLinks(index, [dep('/ws', FILE_A, 'v1'), dep('/ws', FILE_B, 'v1')]);
    const stale = index.removeFile('/ws', FILE_A);
    expect(stale).toEqual(['links']);
    // 解析已丢:同键再 update 走真解析
    const before = parseCalls.length;
    expect(index.updateFile(req(FILE_A, 'v1', TEXT_A)).action).toBe('parsed');
    expect(parseCalls.length).toBe(before + 1);
    // 无依赖装配的文件删除:stale 空如实
    expect(index.removeFile('/ws', FILE_C)).toEqual([]);
  });

  it('重命名:旧路径依赖 stale+新路径独立解析(不假装继承)', () => {
    const { index } = makeIndex();
    index.updateFile(req(FILE_A, 'v1', TEXT_A));
    index.updateFile(req(FILE_B, 'v1', TEXT_B));
    buildLinks(index, [dep('/ws', FILE_A, 'v1'), dep('/ws', FILE_B, 'v1')]);
    const stale = index.renameFile('/ws', FILE_A, FILE_A2, 'v1', TEXT_A2);
    expect(stale).toEqual(['links']);
    // 旧路径解析已删:links 依赖快照查无→重建(不继承旧值)
    const rebuilt = buildLinks(index, [dep('/ws', FILE_A, 'v1'), dep('/ws', FILE_B, 'v1')]);
    expect(rebuilt.reused).toBe(false);
    // 新路径自己的解析可装配
    const renamed = index.buildAssembly('renamed', [dep('/ws', FILE_A2, 'v1')], resolve => ({
      nodes: resolve('/ws', FILE_A2)?.nodes.length ?? -1
    }));
    expect(renamed.reused).toBe(false);
    expect(renamed.value.nodes).toBeGreaterThan(0);
    // 新路径不在旧路径的 stale 面
    expect(index.staleAssemblies([{ rootKey: '/ws', filePath: FILE_A2 }])).toEqual(['renamed']);
  });
});

describe('FLOW-013 跨根隔离', () => {
  it('同路径异根:解析互不串,装配互不陪绑', () => {
    const { index, parseCalls } = makeIndex();
    index.updateFile({ rootKey: '/ws', filePath: FILE_A, versionKey: 'v1', text: TEXT_A });
    index.updateFile({ rootKey: '/other', filePath: FILE_A, versionKey: 'v1', text: TEXT_A2 });
    expect(parseCalls).toHaveLength(2);
    // '/ws' 同键复用,不落到 '/other' 的解析
    expect(
      index.updateFile({ rootKey: '/ws', filePath: FILE_A, versionKey: 'v1', text: TEXT_A }).action
    ).toBe('reused');
    // '/other' 装配
    const buildOther = () =>
      index.buildAssembly('other-links', [dep('/other', FILE_A, 'v1')], resolve => ({
        nodes: resolve('/other', FILE_A)?.nodes.length ?? -1
      }));
    const first = buildOther();
    expect(first.reused).toBe(false);
    // '/ws' 换版不动 '/other' 装配
    index.updateFile({ rootKey: '/ws', filePath: FILE_A, versionKey: 'v2', text: TEXT_A2 });
    expect(index.staleAssemblies([{ rootKey: '/ws', filePath: FILE_A }])).toEqual([]);
    expect(buildOther().reused).toBe(true);
  });
});
