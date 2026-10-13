import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISCOVERY_CONVENTIONS,
  applyDiscoveryChoices,
  collectDiscoveryCandidates,
  getDiscoveryChoice,
  resetDiscoveryState,
  resolveDiscoveredEntitiesXmlPath,
  resolveDiscoveredEntityDefsRoot,
  resolveDiscoveredTypesXmlPath,
  resolveEngineMessagesXmlPath,
  resolveKbeSourceRoot,
  runWorkspaceDiscovery,
  scanWorkspaceAnchors,
  setDiscoveryChoice
} from '../src/workspaceDiscovery';
import { getDefinitionWorkspaceLayout } from '../src/definitionWorkspace';
import { activate } from '../src/extension';
import { window as stubWindow } from './helpers/vscodeStub';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import type { DiscoveryKey, DiscoveryPromptDeps } from '../src/workspaceDiscovery';

// 工作区自动发现(批125):约定路径 → 有界深扫描 → 多候选记忆。全部走真实
// 文件系统临时树,不触 vscode(定义布局兜底用例经 vscodeStub 默认配置回落)。

let root = '';

const p = (...segments: string[]) => path.join(root, ...segments);

const write = (relative: string, content = '<xml/>') => {
  const target = p(...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const mkdir = (relative: string) => {
  fs.mkdirSync(p(...relative.split('/')), { recursive: true });
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-discovery-'));
  resetDiscoveryState();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('scanWorkspaceAnchors(一次有界 walk 收集全部锚点)', () => {
  it('collects defs/entities/types/kbe-root/messages in a conventional tree', () => {
    mkdir('scripts/entity_defs');
    write('scripts/entities.xml');
    write('scripts/entity_defs/types.xml');
    write('kbe/src/lib/entitydef/entitydef.cpp');
    write('kbe/res/server/messages_fixed.xml');

    const scan = scanWorkspaceAnchors(root);

    expect(scan.entityDefs).toEqual([p('scripts/entity_defs')]);
    expect(scan.entitiesXml).toEqual([p('scripts/entities.xml')]);
    expect(scan.typesXml).toEqual([p('scripts/entity_defs/types.xml')]);
    expect(scan.kbeSourceRoots).toEqual([p('kbe')]);
    expect(scan.messagesXml).toEqual([p('kbe/res/server/messages_fixed.xml')]);
  });

  it('skips node_modules/.git/dot directories while walking', () => {
    mkdir('node_modules/entity_defs');
    mkdir('.git');
    write('.git/entities.xml');
    mkdir('.hidden/entity_defs');
    mkdir('real/entity_defs');

    const scan = scanWorkspaceAnchors(root);

    expect(scan.entityDefs).toEqual([p('real/entity_defs')]);
    expect(scan.entitiesXml).toEqual([]);
  });

  it('honours maxDepth (7-level nest found, 8-level not)', () => {
    const deep7 = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    fs.mkdirSync(p(...deep7), { recursive: true });
    write([...deep7, 'entities.xml'].join('/'));
    const scan7 = scanWorkspaceAnchors(root);
    expect(scan7.entitiesXml).toEqual([p(...deep7, 'entities.xml')]);

    fs.mkdirSync(p(...deep7, 'h'), { recursive: true });
    write([...deep7, 'h', 'entities.xml'].join('/'));
    const scan8 = scanWorkspaceAnchors(root);
    expect(scan8.entitiesXml).toEqual([p(...deep7, 'entities.xml')]);
  });

  it('stops after maxVisited entries', () => {
    mkdir('d');
    write('d/entities.xml');

    expect(scanWorkspaceAnchors(root, { maxVisited: 1 }).entitiesXml).toEqual([]);
    expect(scanWorkspaceAnchors(root, { maxVisited: 2 }).entitiesXml).toEqual([p('d/entities.xml')]);
  });

  it('flags scanTruncated and scanVisited when the budget cuts the walk', () => {
    // 批127:截断不再静默——命中集可能不全,报告须标注
    mkdir('d');
    write('d/entities.xml');

    const cut = scanWorkspaceAnchors(root, { maxVisited: 1 });
    expect(cut.entitiesXml).toEqual([]);
    expect(cut.scanTruncated).toBe(true);
    expect(cut.scanVisited).toBe(1);

    const full = scanWorkspaceAnchors(root);
    expect(full.scanTruncated).toBe(false);
    expect(full.scanVisited).toBeGreaterThan(0);
  });

  it('stops mid-directory when the budget runs out between sibling entries', () => {
    mkdir('sub');
    write('sub/a_decoy.xml');
    write('sub/entities.xml');

    // 预算 = sub 之前的根条目 + sub 自身 + sub 内 entities.xml 之前的条目数:
    // 目标文件恰好被循环守卫拦下(预算在相邻条目间耗尽)。目标恰为首项时
    // 退化为入口守卫拦截,断言不受影响。
    const beforeSub = fs.readdirSync(root).indexOf('sub');
    const targetPosInSub = fs.readdirSync(p('sub')).indexOf('entities.xml') + 1;

    const scan = scanWorkspaceAnchors(root, { maxVisited: beforeSub + targetPosInSub });

    expect(scan.entitiesXml).toEqual([]);
  });

  it('returns empty candidates for unreadable roots', () => {
    const filePath = p('plain.txt');
    fs.writeFileSync(filePath, 'x', 'utf8');
    expect(scanWorkspaceAnchors(filePath)).toEqual({
      entityDefs: [],
      entitiesXml: [],
      typesXml: [],
      kbeSourceRoots: [],
      messagesXml: [],
      scanVisited: 0,
      scanTruncated: false
    });
    expect(scanWorkspaceAnchors(p('missing-dir'))).toEqual({
      entityDefs: [],
      entitiesXml: [],
      typesXml: [],
      kbeSourceRoots: [],
      messagesXml: [],
      scanVisited: 0,
      scanTruncated: false
    });
  });

  it('ignores entries that are neither file nor directory (symlinks)', () => {
    // 符号链接既不是 isFile 也不是 isDirectory:walk 不跟随,候选只来自真实目录
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-discovery-out-'));
    try {
      fs.mkdirSync(path.join(outside, 'entity_defs'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'entities.xml'), '<xml/>', 'utf8');
      fs.symlinkSync(outside, p('link-outside'));

      expect(scanWorkspaceAnchors(root)).toEqual({
        entityDefs: [],
        entitiesXml: [],
        typesXml: [],
        kbeSourceRoots: [],
        messagesXml: [],
        // 符号链接条目本身计入访问数,只是不跟随
        scanVisited: 1,
        scanTruncated: false
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('requires a kbe ancestor for engine anchors and dedupes one root', () => {
    write('tools/entitydef.cpp');
    write('kbe/src/lib/entitydef/entitydef.cpp');
    write('kbe/src/lib/db_mysql/entity_table_mysql.cpp');

    const scan = scanWorkspaceAnchors(root);

    // tools/entitydef.cpp 无 kbe 祖先,不入根;kbe 下两个锚点去重为一
    expect(scan.kbeSourceRoots).toEqual([p('kbe')]);
  });
});

describe('resolveDiscoveredEntityDefsRoot / EntitiesXml / TypesXml(深扫描兜底优先级)', () => {
  it('returns null on an empty workspace', () => {
    expect(resolveDiscoveredEntityDefsRoot(root)).toBeNull();
    expect(resolveDiscoveredEntitiesXmlPath(root)).toBeNull();
    expect(resolveDiscoveredTypesXmlPath(root)).toBeNull();
  });

  it('returns null when several defs candidates exist — no silent guess', () => {
    mkdir('aaa/entity_defs');
    mkdir('scripts/entity_defs');
    write('scripts/entities.xml');

    expect(resolveDiscoveredEntityDefsRoot(root)).toBeNull();
  });

  it('returns the single scanned defs root when it is unambiguous', () => {
    mkdir('somewhere/else/entity_defs');

    expect(resolveDiscoveredEntityDefsRoot(root)).toBe(p('somewhere/else/entity_defs'));
  });

  it('returns null for multiple entities.xml candidates', () => {
    mkdir('defs1/entity_defs');
    write('defs1/entities.xml');
    write('other/entities.xml');

    expect(resolveDiscoveredEntitiesXmlPath(root)).toBeNull();
  });

  it('returns the single scanned entities.xml when unambiguous', () => {
    mkdir('one');
    write('one/entities.xml');

    expect(resolveDiscoveredEntitiesXmlPath(root)).toBe(p('one/entities.xml'));
  });

  it('returns null for multiple types.xml candidates, the sole hit otherwise', () => {
    mkdir('x/entity_defs');
    write('x/entity_defs/types.xml');
    write('elsewhere/types.xml');
    expect(resolveDiscoveredTypesXmlPath(root)).toBeNull();

    resetDiscoveryState();
    fs.rmSync(p('x'), { recursive: true, force: true });
    expect(resolveDiscoveredTypesXmlPath(root)).toBe(p('elsewhere/types.xml'));
  });

  it('lets a remembered choice win over scan results', () => {
    mkdir('scripts/entity_defs');
    write('scripts/entities.xml');
    write('scripts/entity_defs/types.xml');
    setDiscoveryChoice(root, 'entityDefs', p('scripts/entity_defs'));
    setDiscoveryChoice(root, 'entitiesXml', p('scripts/entities.xml'));
    setDiscoveryChoice(root, 'typesXml', p('scripts/entity_defs/types.xml'));

    expect(resolveDiscoveredEntityDefsRoot(root)).toBe(p('scripts/entity_defs'));
    expect(resolveDiscoveredEntitiesXmlPath(root)).toBe(p('scripts/entities.xml'));
    expect(resolveDiscoveredTypesXmlPath(root)).toBe(p('scripts/entity_defs/types.xml'));
  });

  it('drops remembered choices whose paths vanished from disk', () => {
    mkdir('scripts/entity_defs');
    setDiscoveryChoice(root, 'entityDefs', p('gone/entity_defs'));

    expect(getDiscoveryChoice(root, 'entityDefs')).toBeNull();
    expect(resolveDiscoveredEntityDefsRoot(root)).toBe(p('scripts/entity_defs'));
  });
});

describe('resolveKbeSourceRoot / resolveEngineMessagesXmlPath(引擎锚点)', () => {
  it('uses the conventional anchor path before scanning', () => {
    write('kbe/src/lib/entitydef/entitydef.cpp');
    expect(resolveKbeSourceRoot(root)).toBe(p('kbe'));
  });

  it('falls back to a deep-scanned kbe root outside the conventional spots', () => {
    write('deep/kbe/src/common/entitydef/entitydef.cpp');
    expect(resolveKbeSourceRoot(root)).toBe(p('deep/kbe'));
  });

  it('returns null when no engine anchor exists', () => {
    expect(resolveKbeSourceRoot(root)).toBeNull();
    expect(resolveEngineMessagesXmlPath(root)).toBeNull();
  });

  it('prefers the user messages_fixed.xml over defaults inside the engine res', () => {
    write('kbe/src/lib/entitydef/entitydef.cpp');
    write('kbe/res/server/messages_fixed_defaults.xml');
    expect(resolveEngineMessagesXmlPath(root)).toBe(p('kbe/res/server/messages_fixed_defaults.xml'));

    write('kbe/res/server/messages_fixed.xml');
    expect(resolveEngineMessagesXmlPath(root)).toBe(p('kbe/res/server/messages_fixed.xml'));
  });

  it('skips the engine res probe when the kbe root has no messages file', () => {
    // kbe 根命中但 res/server 无 messages 文件:精确探测落空,回落深扫描
    write('kbe/src/lib/entitydef/entitydef.cpp');
    expect(resolveEngineMessagesXmlPath(root)).toBeNull();
  });

  it('finds a workspace messages_fixed.xml in asset-only repositories', () => {
    write('assets/res/server/messages_fixed.xml');
    expect(resolveEngineMessagesXmlPath(root)).toBe(p('assets/res/server/messages_fixed.xml'));
  });
});

describe('collectDiscoveryCandidates(激活期盘点)', () => {
  it('dedupes convention hits that the scan also finds', () => {
    mkdir('scripts/entity_defs');
    write('scripts/entities.xml');
    write('scripts/entity_defs/types.xml');

    const report = collectDiscoveryCandidates(root);

    expect(report.candidates.entityDefs).toEqual([p('scripts/entity_defs')]);
    expect(report.candidates.entitiesXml).toEqual([p('scripts/entities.xml')]);
    expect(report.candidates.typesXml).toEqual([p('scripts/entity_defs/types.xml')]);
    expect(report.ambiguous).toEqual([]);
  });

  it('reports ambiguous keys when more than one candidate exists', () => {
    mkdir('entity_defs');
    mkdir('scripts/entity_defs');
    write('entities.xml');
    write('scripts/entities.xml');
    write('types.xml');
    write('scripts/entity_defs/types.xml');

    const report = collectDiscoveryCandidates(root);

    expect(report.ambiguous).toEqual<DiscoveryKey[]>(['entityDefs', 'entitiesXml', 'typesXml']);
    expect(report.candidates.entityDefs).toHaveLength(2);
    expect(DISCOVERY_CONVENTIONS.entityDefs.length).toBeGreaterThan(0);
  });
});

describe('choice state(会话记忆)', () => {
  it('merges keys and resets atomically', () => {
    mkdir('a');
    mkdir('b');
    setDiscoveryChoice(root, 'entityDefs', p('a'));
    setDiscoveryChoice(root, 'typesXml', p('b'));

    expect(getDiscoveryChoice(root, 'entityDefs')).toBe(p('a'));
    expect(getDiscoveryChoice(root, 'typesXml')).toBe(p('b'));
    expect(getDiscoveryChoice(root, 'entitiesXml')).toBeNull();

    resetDiscoveryState();
    expect(getDiscoveryChoice(root, 'entityDefs')).toBeNull();
  });

  it('applyDiscoveryChoices ignores undefined payloads', () => {
    applyDiscoveryChoices(root, undefined);
    expect(getDiscoveryChoice(root, 'entityDefs')).toBeNull();
  });

  it('applyDiscoveryChoices replaces the whole group and invalidates the scan cache', () => {
    mkdir('scripts/entity_defs');
    setDiscoveryChoice(root, 'entityDefs', p('scripts/entity_defs'));
    applyDiscoveryChoices(root, { entityDefs: p('scripts/entity_defs') });

    expect(getDiscoveryChoice(root, 'entityDefs')).toBe(p('scripts/entity_defs'));
    expect(getDiscoveryChoice(root, 'typesXml')).toBeNull();
  });
});

describe('runWorkspaceDiscovery(激活期询问流程)', () => {
  const makeDeps = (
    recalled: Partial<Record<DiscoveryKey, string>> | undefined,
    picks: Partial<Record<DiscoveryKey, string>> = {}
  ) => {
    const calls: { picks: DiscoveryKey[]; remembered: Array<Partial<Record<DiscoveryKey, string>>> } = {
      picks: [],
      remembered: []
    };
    const keyOfTitle = (title: string): DiscoveryKey | undefined =>
      title.includes('entity_defs')
        ? 'entityDefs'
        : title.includes('entities.xml')
          ? 'entitiesXml'
          : title.includes('types.xml')
            ? 'typesXml'
            : undefined;
    const deps: DiscoveryPromptDeps = {
      showQuickPick: async (items, title) => {
        const key = keyOfTitle(title);
        void items;
        calls.picks.push(key as DiscoveryKey);
        return key ? picks[key] : undefined;
      },
      recall: () => recalled,
      remember: (_ws, choices) => {
        calls.remembered.push(choices);
      }
    };
    return { deps, calls };
  };

  it('stays silent when every anchor has a single candidate', async () => {
    mkdir('scripts/entity_defs');
    write('scripts/entities.xml');
    write('scripts/entity_defs/types.xml');
    const { deps, calls } = makeDeps(undefined);

    await runWorkspaceDiscovery(deps, root);

    expect(calls.picks).toEqual([]);
    expect(calls.remembered).toEqual([]);
  });

  it('prompts once per ambiguous anchor and remembers the picks', async () => {
    mkdir('entity_defs');
    mkdir('scripts/entity_defs');
    write('entities.xml');
    write('scripts/entities.xml');
    const { deps, calls } = makeDeps(undefined, { entityDefs: p('scripts/entity_defs') });

    await runWorkspaceDiscovery(deps, root);

    expect(calls.picks).toEqual(['entityDefs', 'entitiesXml']);
    expect(calls.remembered).toEqual([{ entityDefs: p('scripts/entity_defs') }]);
    // 选择即生效:深扫描兜底直接返回记忆项,scan 缓存已被失效重算
    expect(resolveDiscoveredEntityDefsRoot(root)).toBe(p('scripts/entity_defs'));
  });

  it('skips anchors whose remembered choice is still valid on disk', async () => {
    mkdir('entity_defs');
    mkdir('scripts/entity_defs');
    write('entities.xml');
    write('scripts/entities.xml');
    const { deps, calls } = makeDeps({ entityDefs: p('entity_defs') });

    await runWorkspaceDiscovery(deps, root);

    // entityDefs 有有效记忆不再询问;entitiesXml 无记忆仍问
    expect(calls.picks).toEqual(['entitiesXml']);
  });

  it('keeps silent for the whole session when the pick is cancelled', async () => {
    mkdir('entity_defs');
    mkdir('scripts/entity_defs');
    write('entities.xml');
    write('scripts/entities.xml');
    const { deps, calls } = makeDeps(undefined, {});

    await runWorkspaceDiscovery(deps, root);

    expect(calls.picks).toEqual(['entityDefs', 'entitiesXml']);
    expect(calls.remembered).toEqual([]);
    // 取消不记忆:多候选同步读宁缺勿猜
    expect(resolveDiscoveredEntityDefsRoot(root)).toBeNull();
  });
});

describe('getDefinitionWorkspaceLayout(批125 发现兜底接线)', () => {
  it('falls back to the deep-scanned defs root when conventions miss', () => {
    mkdir('deep/nested/entity_defs');
    write('other/place/entities.xml');
    write('conf/types.xml');

    const layout = getDefinitionWorkspaceLayout(root);

    expect(layout.entityDefsRoot).toBe(p('deep/nested/entity_defs'));
    expect(layout.entitiesXmlPath).toBe(p('other/place/entities.xml'));
    expect(layout.typesXmlPath).toBe(p('conf/types.xml'));
  });

  it('lets remembered choices override scan results in the layout', () => {
    mkdir('deep/nested/entity_defs');
    write('other/place/entities.xml');
    write('other/place/types.xml');
    setDiscoveryChoice(root, 'entitiesXml', p('other/place/entities.xml'));
    setDiscoveryChoice(root, 'typesXml', p('other/place/types.xml'));

    const layout = getDefinitionWorkspaceLayout(root);

    expect(layout.entityDefsRoot).toBe(p('deep/nested/entity_defs'));
    expect(layout.entitiesXmlPath).toBe(p('other/place/entities.xml'));
    expect(layout.typesXmlPath).toBe(p('other/place/types.xml'));
  });

  it('keeps the conventional preferred root when nothing is found', () => {
    const layout = getDefinitionWorkspaceLayout(root);

    expect(layout.entityDefsRoot).toBe(p('scripts/entity_defs'));
    expect(layout.entitiesXmlPath).toBeNull();
    expect(layout.typesXmlPath).toBeNull();
  });

  it('keeps the conventional layout root when defs candidates are ambiguous', () => {
    mkdir('aaa/entity_defs');
    mkdir('scripts/entity_defs');
    write('scripts/entities.xml');

    // 多候选不猜:布局保持约定首选路径,歧义交激活期 quick pick 记忆
    expect(getDefinitionWorkspaceLayout(root).entityDefsRoot).toBe(p('scripts/entity_defs'));
  });
});

describe('activation wiring(批125 发现流程经 activate 装配)', () => {
  it('runs discovery on activation and remembers picks via workspaceState', async () => {
    mkdir('entity_defs');
    mkdir('scripts/entity_defs');
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: root }, name: 'ws', index: 0 } as never];
    const savedQuickPick = stubWindow.showQuickPick;
    const seen: string[][] = [];
    (stubWindow as unknown as { showQuickPick: unknown }).showQuickPick = async (items: string[]) => {
      seen.push(items);
      return items[0];
    };
    const stored = new Map<string, unknown>();
    const context = {
      subscriptions: [],
      extensionUri: Uri.file('/ext'),
      workspaceState: {
        get: (key: string) => stored.get(key),
        update: async (key: string, value: unknown) => {
          stored.set(key, value);
        }
      }
    };
    try {
      activate(context as never);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 多候选弹一次选择;选择经 deps.remember 落 workspaceState 并即期生效
      expect(seen).toHaveLength(1);
      const choices = stored.get(`kbengine.discovery.${root}`) as
        Partial<Record<DiscoveryKey, string>> | undefined;
      expect([p('entity_defs'), p('scripts/entity_defs')]).toContain(choices?.entityDefs);
      expect(getDiscoveryChoice(root, 'entityDefs')).toBe(choices?.entityDefs);
    } finally {
      (stubWindow as unknown as { showQuickPick: unknown }).showQuickPick = savedQuickPick;
      stubWorkspace.workspaceFolders = [];
      resetDiscoveryState();
    }
  });
});
