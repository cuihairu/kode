import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineDefinitionProvider } from '../src/languageProviders';
import { findMethodScriptLocationInDef } from '../src/languageProviders/navigation';
import { buildMethodOwnerBindingKey } from '../src/entityMappingHelpers';
import {
  DefMethodLut,
  buildDefMethodLutKey,
  type DefLutDiskFile,
  type DefMethodLutEntry
} from '../src/backend/defMethodLut';
import {
  INDEX_CACHE_SCHEMA_VERSION,
  readIndexCache,
  writeIndexCache
} from '../src/backend/indexDiskCache';
import {
  Position,
  Uri,
  makeTextDocument,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// DEF-LUT-001:def→py 方法跳转反查表。八钉子(任务书 kode-def-lut.md):
// ①命中毫秒级(打点 <100ms 且慢链零进入) ②missing 秒回空(不等兜底)
// ③MRO 补充(父链实现入 mroImplementations) ④清空 LUT 走慢链结果一致
// ⑤def/py 变更精确作废(代际断言) ⑥磁盘持久化二次启动载入(stat+sha 校验)
// ⑦门控红线:未放行(deferStartup)零构建 ⑧kodeRustFirstDefinitionE2E 回归
// (既有套件,本文件不动它,全量跑里守)。
//
// 夹具口径:Avatar(BaseMethods.onKill 属主实现 / onGhost 全链无实现 /
// CellMethods.onMove 仅父 def(Mob)的 cell 脚本实现=约定链/MRO 臂)。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

const write = (root: string, relative: string, content: string) => {
  const target = p(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const until = async (condition: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting: ${what}`);
};

const AVATAR_DEF = [
  '<root>',
  '  <Parent>Mob</Parent>',
  '  <BaseMethods>',
  '    <onKill/>',
  '    <onGhost/>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <onMove/>',
  '  </CellMethods>',
  '</root>'
].join('\n');

const MOB_DEF = [
  '<root>',
  '  <CellMethods>',
  '    <onMove/>',
  '  </CellMethods>',
  '</root>'
].join('\n');

const AVATAR_BASE_PY = 'class Avatar(object):\n    def onKill(self):\n        pass\n';
const MOB_CELL_PY = 'class Mob(object):\n    def onMove(self):\n        pass\n';
const MOB_BASE_PY = 'class Mob(object):\n    pass\n';

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-def-lut-'));
  write(root, 'scripts/entities.xml',
    '<root>\n  <Avatar hasBase="true" hasCell="true"/>\n  <Mob hasBase="true" hasCell="true"/>\n</root>');
  write(root, 'scripts/entity_defs/Avatar.def', AVATAR_DEF);
  write(root, 'scripts/entity_defs/Mob.def', MOB_DEF);
  write(root, 'scripts/base/Avatar.py', AVATAR_BASE_PY);
  write(root, 'scripts/cell/Mob.py', MOB_CELL_PY);
  write(root, 'scripts/base/Mob.py', MOB_BASE_PY);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'lut', index: 0 }];
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

/** stub findFiles:真实盘面 walk(同 entityMappingManager.test 口径) */
const patchFindFiles = (): void => {
  stubWorkspace.findFiles = async () => {
    const results: Uri[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = p(dir, entry.name);
        if (entry.isDirectory()) { walk(full); }
        else if (entry.name.endsWith('.def')) { results.push(Uri.file(full)); }
      }
    };
    walk(root);
    return results;
  };
};

/** 约定链臂适配(monitoring 同式,文档侧换测试替身;落点转 1 基) */
const resolver = async (
  defPath: string,
  methodName: string,
  section: 'BaseMethods' | 'CellMethods' | 'ClientMethods'
): Promise<{ filePath: string; line: number; character: number } | null> => {
  const location = findMethodScriptLocationInDef(
    makeTextDocument(fs.readFileSync(defPath, 'utf8'), {
      fileName: defPath, languageId: 'kbengine-def'
    }) as never,
    methodName,
    section
  );
  return location
    ? {
        filePath: location.uri.fsPath,
        line: location.range.start.line + 1,
        character: location.range.start.character
      }
    : null;
};

/** `|` 标记光标位置的 def 文档 */
const defDocAt = (
  template: string
): { document: ReturnType<typeof makeTextDocument>; position: Position } => {
  const idx = template.indexOf('|');
  const text = template.replace('|', '');
  const before = text.slice(0, idx);
  const line = before.split('\n').length - 1;
  const lastNewline = before.lastIndexOf('\n');
  const character = line === 0 ? idx : idx - (lastNewline + 1);
  return {
    document: makeTextDocument(text, {
      fileName: p(root, 'scripts/entity_defs/Avatar.def'), languageId: 'kbengine-def'
    }),
    position: new Position(line, character)
  };
};

interface LocationLike {
  uri: { fsPath: string };
  range: { start: { line: number; character: number } };
}

/** 夹具管理器:首扫收敛即回(钉子用例各自 dispose) */
const makeManager = async (): Promise<EntityMappingManager> => {
  const originalFind = stubWorkspace.findFiles;
  patchFindFiles();
  const manager = new EntityMappingManager({ subscriptions: [] } as never);
  await until(() => (manager as unknown as {
    mappingIndexes: Map<string, unknown>;
  }).mappingIndexes.size >= 2, 'lut fixture scan');
  stubWorkspace.findFiles = originalFind;
  return manager;
};

describe('DEF-LUT-001 纯核(零 vscode)', () => {
  it('反查键与 buildMethodOwnerBindingKey 同构(含缺段/大小写)', () => {
    for (const identity of [
      { ownerKind: 'entity', ownerName: 'Avatar', section: 'BaseMethods', symbolName: 'onKill' },
      { ownerKind: 'entity', ownerName: 'Avatar', section: undefined, symbolName: 'onKill' },
      { ownerKind: 'component', ownerName: 'MoveComponent', section: 'CellMethods', symbolName: 'OnTick' }
    ]) {
      expect(buildDefMethodLutKey(identity)).toBe(buildMethodOwnerBindingKey(identity));
    }
  });

  it('getHit 三态:hit 首落点 / missing 秒回空标记 / miss(表未含)undefined', () => {
    const lut = new DefMethodLut();
    const hitKey = buildDefMethodLutKey({ ownerKind: 'entity', ownerName: 'A', section: 'BaseMethods', symbolName: 'ok' });
    const missKey = buildDefMethodLutKey({ ownerKind: 'entity', ownerName: 'A', section: 'BaseMethods', symbolName: 'nope' });
    const orphanKey = buildDefMethodLutKey({ ownerKind: 'entity', ownerName: 'A', section: 'BaseMethods', symbolName: 'okOther' });
    lut.upsertDef('/ws/A.def', { mtimeMs: 1, size: 1 }, new Map<string, DefMethodLutEntry>([
      [hitKey, {
        defFile: '/ws/A.def', defDeclLine: 3, section: 'BaseMethods',
        implementations: [{ filePath: '/ws/scripts/base/A.py', line: 2, character: 4 }],
        mroImplementations: [], missing: false
      }],
      [orphanKey, {
        defFile: '/ws/A.def', defDeclLine: 5, section: 'BaseMethods',
        implementations: [], mroImplementations: [], missing: true
      }]
    ]));
    expect(lut.getHit(hitKey, '/ws/A.def')).toEqual({
      status: 'hit', target: { filePath: '/ws/scripts/base/A.py', line: 2, character: 4 }
    });
    expect(lut.getHit(orphanKey, '/ws/A.def')).toEqual({ status: 'missing' });
    expect(lut.getHit(missKey, '/ws/A.def')).toBeUndefined();
    // 另一 def 的表不代答(defFile 比对)
    expect(lut.getHit(hitKey, '/ws/B.def')).toBeUndefined();
    // 非 missing 的空实现态=诚实 miss(慢链兜底,见钉子④口径)
    expect(lut.getHit(missKey, '/ws/B.def')).toBeUndefined();
    expect(lut.size()).toBe(2);
  });

  it('py 变更精确作废(贡献者索引);def 变更整桶作废;代际推进', () => {
    const lut = new DefMethodLut();
    const keyOf = (symbolName: string) =>
      buildDefMethodLutKey({ ownerKind: 'entity', ownerName: 'A', section: 'BaseMethods', symbolName });
    lut.upsertDef('/ws/A.def', { mtimeMs: 1, size: 1 }, new Map<string, DefMethodLutEntry>([
      [keyOf('m1'), {
        defFile: '/ws/A.def', defDeclLine: 3, section: 'BaseMethods',
        implementations: [{ filePath: '/ws/scripts/base/A.py', line: 2, character: 4 }],
        mroImplementations: [], missing: false
      }],
      [keyOf('m2'), {
        defFile: '/ws/A.def', defDeclLine: 4, section: 'BaseMethods',
        implementations: [], mroImplementations: [], missing: true
      }]
    ]));
    const generationBefore = lut.generation();
    expect(lut.invalidatePythonFile('/ws/scripts/base/A.py')).toBe(1);
    expect(lut.generation()).toBe(generationBefore + 1);
    // m1 出表(py 贡献);m2(missing,零贡献者)原样保留
    expect(lut.getHit(keyOf('m1'), '/ws/A.def')).toBeUndefined();
    expect(lut.getHit(keyOf('m2'), '/ws/A.def')).toEqual({ status: 'missing' });
    // 无关 py 零命中零代际
    const stable = lut.generation();
    expect(lut.invalidatePythonFile('/ws/other.py')).toBe(0);
    expect(lut.generation()).toBe(stable);
    // def 整桶作废
    expect(lut.removeDef('/ws/A.def')).toBe(1);
    expect(lut.getHit(keyOf('m2'), '/ws/A.def')).toBeUndefined();
    expect(lut.size()).toBe(0);
  });

  it('capture/restore 往返:stat 一致收编,漂移/缺失拒收,空载荷零收编(钉子⑥半边)', () => {
    const source = new DefMethodLut();
    const key = buildDefMethodLutKey({ ownerKind: 'entity', ownerName: 'Avatar', section: 'BaseMethods', symbolName: 'onKill' });
    source.upsertDef(p(root, 'scripts/entity_defs/Avatar.def'), { mtimeMs: 111, size: 222 }, new Map([[key, {
      defFile: p(root, 'scripts/entity_defs/Avatar.def'), defDeclLine: 4, section: 'BaseMethods',
      implementations: [{ filePath: p(root, 'scripts/base/Avatar.py'), line: 2, character: 4 }],
      mroImplementations: [], missing: false
    }]]));
    const payload = source.capture();
    expect(payload).toHaveLength(1);

    const statOfFs = (defPath: string) => {
      try {
        const stat = fs.statSync(defPath);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        return null;
      }
    };

    // stat 一致(盘上 Avatar.def 的真实 stat 重新入表)
    const realStat = statOfFs(p(root, 'scripts/entity_defs/Avatar.def'))!;
    source.upsertDef(p(root, 'scripts/entity_defs/Avatar.def'), realStat, new Map([[key, {
      defFile: p(root, 'scripts/entity_defs/Avatar.def'), defDeclLine: 4, section: 'BaseMethods',
      implementations: [], mroImplementations: [], missing: true
    }]]));
    const fresh = new DefMethodLut();
    const report = fresh.restore(source.capture(), statOfFs);
    expect(report).toMatchObject({ adoptedDefs: 1, rejectedDefs: 0, adoptedEntries: 1 });
    expect(fresh.getHit(key, p(root, 'scripts/entity_defs/Avatar.def'))).toEqual({ status: 'missing' });

    // 漂移拒收(伪 stat)+ 空载荷
    const drifted = new DefMethodLut();
    expect(drifted.restore(payload, () => null)).toMatchObject({ adoptedDefs: 0, rejectedDefs: 1 });
    expect(drifted.restore(undefined, statOfFs)).toMatchObject({ adoptedDefs: 0, rejectedDefs: 0, adoptedEntries: 0 });
  });

  it('indexDiskCache defLUT 产物:写盘/读回 sha 校验,篡改弃用(钉子⑥另半边)', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-lut-cache-'));
    try {
      const payload: DefLutDiskFile[] = [{
        defPath: p(root, 'scripts/entity_defs/Avatar.def'), mtimeMs: 1, size: 2,
        entries: [[
          buildDefMethodLutKey({ ownerKind: 'entity', ownerName: 'Avatar', section: 'BaseMethods', symbolName: 'onKill' }),
          {
            defFile: p(root, 'scripts/entity_defs/Avatar.def'), defDeclLine: 4, section: 'BaseMethods',
            implementations: [{ filePath: p(root, 'scripts/base/Avatar.py'), line: 2, character: 4 }],
            mroImplementations: [], missing: false
          }
        ]]
      }];
      expect(writeIndexCache(cacheDir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: 'test' }, { defLut: payload })).toBe(true);
      const loaded = readIndexCache(cacheDir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: 'test' });
      expect(loaded?.payload.defLut).toEqual(payload);
      expect(loaded?.meta.defLutCount).toBe(1);

      // 篡改载荷 → sha 不符 → defLut 缺席(下次启动照旧重建)
      const defLutFile = p(cacheDir, 'defLut.json');
      fs.writeFileSync(defLutFile, '[]', 'utf8');
      const tampered = readIndexCache(cacheDir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion: 'test' });
      expect(tampered?.payload.defLut).toBeUndefined();
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('DEF-LUT-001 管理器+provider 八钉子', () => {
  it('钉子①:后台重建后 LUT 命中 <100ms 且慢链零进入', async () => {
    const manager = await makeManager();
    try {
      await manager.scheduleDefMethodLutRebuild(resolver);
      const hit = manager.getDefMethodLutHit(
        p(root, 'scripts/entity_defs/Avatar.def'), 'onKill', 'BaseMethods');
      // character=8:实现臂与慢链共用 listMethodImplementationsByIdentity,
      // 落点=方法名列(`    def onKill` 的 o 在第 8 列),钉子④同源一致
      expect(hit).toEqual({
        status: 'hit', target: { filePath: p(root, 'scripts/base/Avatar.py'), line: 2, character: 8 }
      });

      // 慢链零进入:身份解析入口装哨兵(LUT 路径不得触它)
      const internal = manager as unknown as Record<string, unknown>;
      const sentinel = internal.resolveDefinitionSymbolAtPosition;
      internal.resolveDefinitionSymbolAtPosition = () => {
        throw new Error('slow chain must not run when LUT hits');
      };
      const provider = new KBEngineDefinitionProvider(manager);
      const { document, position } = defDocAt('  <BaseMethods>\n    <|onKill/>\n  </BaseMethods>');
      const startedAt = Date.now();
      const location = await provider.provideDefinition(
        document as never, position as never) as unknown as LocationLike;
      const elapsed = Date.now() - startedAt;
      delete internal.resolveDefinitionSymbolAtPosition;
      void sentinel;
      expect(location?.uri.fsPath).toBe(p(root, 'scripts/base/Avatar.py'));
      expect(location?.range.start.line).toBe(1);
      expect(elapsed).toBeLessThan(100);
    } finally {
      void (manager as unknown as { dispose(): void }).dispose?.();
    }
  }, 20000);

  it('钉子②:def 有声明 py 无实现 → missing 秒回空(负缓存合流,不进兜底)', async () => {
    const manager = await makeManager();
    try {
      await manager.scheduleDefMethodLutRebuild(resolver);
      expect(manager.getDefMethodLutHit(
        p(root, 'scripts/entity_defs/Avatar.def'), 'onGhost', 'BaseMethods')).toEqual({ status: 'missing' });

      const internal = manager as unknown as Record<string, unknown>;
      const sentinel = internal.resolveDefinitionSymbolAtPosition;
      internal.resolveDefinitionSymbolAtPosition = () => {
        throw new Error('slow chain must not run on LUT missing');
      };
      const provider = new KBEngineDefinitionProvider(manager);
      const { document, position } = defDocAt('  <BaseMethods>\n    <|onGhost/>\n  </BaseMethods>');
      const startedAt = Date.now();
      const result = await provider.provideDefinition(document as never, position as never);
      const elapsed = Date.now() - startedAt;
      delete internal.resolveDefinitionSymbolAtPosition;
      void sentinel;
      expect(result).toBeNull();
      expect(elapsed).toBeLessThan(100);
    } finally {
      void (manager as unknown as { dispose(): void }).dispose?.();
    }
  }, 20000);

  it('钉子③:本实体未实现但父链实现 → mroImplementations 给出并跳转', async () => {
    const manager = await makeManager();
    try {
      await manager.scheduleDefMethodLutRebuild(resolver);
      const hit = manager.getDefMethodLutHit(
        p(root, 'scripts/entity_defs/Avatar.def'), 'onMove', 'CellMethods');
      // 补充臂(慢链同序:全项目回退先命中父 def Mob 的 cell 脚本)入
      // mroImplementations,character=首非空白列(与慢链 collectAllPythonMethodHits 同口径)
      expect(hit).toEqual({
        status: 'hit', target: { filePath: p(root, 'scripts/cell/Mob.py'), line: 2, character: 4 }
      });
      const entry = manager.getDefMethodLut().getEntry(
        buildDefMethodLutKey({ ownerKind: 'entity', ownerName: 'Avatar', section: 'CellMethods', symbolName: 'onMove' }),
        p(root, 'scripts/entity_defs/Avatar.def'));
      expect(entry?.implementations).toEqual([]);
      expect(entry?.mroImplementations).toEqual([
        { filePath: p(root, 'scripts/cell/Mob.py'), line: 2, character: 4 }
      ]);
      expect(entry?.missing).toBe(false);

      const provider = new KBEngineDefinitionProvider(manager);
      const { document, position } = defDocAt('  <CellMethods>\n    <|onMove/>\n  </CellMethods>');
      const location = await provider.provideDefinition(
        document as never, position as never) as unknown as LocationLike;
      expect(location?.uri.fsPath).toBe(p(root, 'scripts/cell/Mob.py'));
      expect(location?.range.start.line).toBe(1);
    } finally {
      void (manager as unknown as { dispose(): void }).dispose?.();
    }
  }, 20000);

  it('钉子④:无 LUT 的慢链结果与 LUT 命中一致(加速层不改变真相)', async () => {
    const withLut = await makeManager();
    let withLutLocation: LocationLike | null = null;
    try {
      await withLut.scheduleDefMethodLutRebuild(resolver);
      const provider = new KBEngineDefinitionProvider(withLut);
      const { document, position } = defDocAt('  <CellMethods>\n    <|onMove/>\n  </CellMethods>');
      withLutLocation = await provider.provideDefinition(
        document as never, position as never) as unknown as LocationLike;
    } finally {
      void (withLut as unknown as { dispose(): void }).dispose?.();
    }
    expect(withLutLocation).not.toBeNull();

    const withoutLut = await makeManager();
    try {
      // 不重建 LUT(空表=miss)→ 慢链(身份绑定→约定链→全项目回退)
      const provider = new KBEngineDefinitionProvider(withoutLut);
      const { document, position } = defDocAt('  <CellMethods>\n    <|onMove/>\n  </CellMethods>');
      const slowLocation = await provider.provideDefinition(
        document as never, position as never) as unknown as LocationLike;
      expect(slowLocation?.uri.fsPath).toBe(withLutLocation!.uri.fsPath);
      expect(slowLocation?.range.start.line).toBe(withLutLocation!.range.start.line);
      expect(slowLocation?.range.start.character).toBe(withLutLocation!.range.start.character);
    } finally {
      void (withoutLut as unknown as { dispose(): void }).dispose?.();
    }
  }, 30000);

  it('钉子⑤:def/py 变更精确作废受影响条目,代际推进,重建补回', async () => {
    const manager = await makeManager();
    const internal = manager as unknown as {
      handleDefFileChanged(file: string, kind: 'change' | 'create' | 'delete'): void;
      handlePythonFileChanged(file: string): void;
      dispose(): void;
    };
    try {
      await manager.scheduleDefMethodLutRebuild(resolver);
      const lut = manager.getDefMethodLut();
      const avatarDef = p(root, 'scripts/entity_defs/Avatar.def');
      const keyOf = (symbolName: string, section: string) =>
        buildDefMethodLutKey({ ownerKind: 'entity', ownerName: 'Avatar', section, symbolName });

      // py 变更:base/Avatar.py 贡献的 onKill 条目精确出表,onMove/onGhost 原样
      const genBeforePy = lut.generation();
      internal.handlePythonFileChanged(p(root, 'scripts/base/Avatar.py'));
      expect(lut.generation()).toBeGreaterThan(genBeforePy);
      expect(lut.getHit(keyOf('onKill', 'BaseMethods'), avatarDef)).toBeUndefined();
      expect(lut.getHit(keyOf('onMove', 'CellMethods'), avatarDef)).toMatchObject({ status: 'hit' });
      expect(lut.getHit(keyOf('onGhost', 'BaseMethods'), avatarDef)).toEqual({ status: 'missing' });
      // 属主重解析收敛后重建补回
      await until(() => lut.getHit(keyOf('onKill', 'BaseMethods'), avatarDef) !== undefined, 'lut rebuild after py change');
      expect(lut.getHit(keyOf('onKill', 'BaseMethods'), avatarDef)).toMatchObject({ status: 'hit' });

      // def 变更:Avatar 桶整体出表(Avatar 条目全没,Mob 桶不受连坐)
      const mobHit = lut.getHit(
        buildDefMethodLutKey({ ownerKind: 'entity', ownerName: 'Mob', section: 'CellMethods', symbolName: 'onMove' }),
        p(root, 'scripts/entity_defs/Mob.def'));
      expect(mobHit).toMatchObject({ status: 'hit' });
      const genBeforeDef = lut.generation();
      internal.handleDefFileChanged(avatarDef, 'change');
      expect(lut.generation()).toBeGreaterThan(genBeforeDef);
      expect(lut.getHit(keyOf('onMove', 'CellMethods'), avatarDef)).toBeUndefined();
      expect(lut.getHit(
        buildDefMethodLutKey({ ownerKind: 'entity', ownerName: 'Mob', section: 'CellMethods', symbolName: 'onMove' }),
        p(root, 'scripts/entity_defs/Mob.def'))).toMatchObject({ status: 'hit' });
      // 定向重解析落定后重建补回
      await until(() => lut.getHit(keyOf('onMove', 'CellMethods'), avatarDef) !== undefined, 'lut rebuild after def change');
    } finally {
      internal.dispose();
    }
  }, 20000);

  it('钉子⑥:管理器载荷落盘 → 二次载入(stat 校验)可查', async () => {
    const manager = await makeManager();
    try {
      await manager.scheduleDefMethodLutRebuild(resolver);
      const payload = manager.captureDefMethodLutSnapshot();
      expect(payload.length).toBeGreaterThan(0);

      // 恢复面:stat 一致收编(夹具未变更,全收);漂移(伪 stat 探针)拒收
      const restored = manager.restoreDefMethodLutFromDisk(payload);
      expect(restored.adoptedDefs).toBe(payload.length);
      expect(manager.getDefMethodLutHit(
        p(root, 'scripts/entity_defs/Avatar.def'), 'onKill', 'BaseMethods')).toMatchObject({ status: 'hit' });

      const empty = new EntityMappingManager({ subscriptions: [] } as never, undefined, { deferStartup: true });
      const driftReport = empty.restoreDefMethodLutFromDisk(payload.map(file => ({ ...file, mtimeMs: file.mtimeMs + 9999 })));
      expect(driftReport.adoptedDefs).toBe(0);
      expect(driftReport.rejectedDefs).toBe(payload.length);
      expect(empty.getDefMethodLutHit(
        p(root, 'scripts/entity_defs/Avatar.def'), 'onKill', 'BaseMethods')).toBeUndefined();
      empty.dispose();
    } finally {
      void (manager as unknown as { dispose(): void }).dispose?.();
    }
  }, 20000);

  it('钉子⑦:门控未放行(deferStartup)零构建、零调度', async () => {
    const deferred = new EntityMappingManager({ subscriptions: [] } as never, undefined, { deferStartup: true });
    try {
      await deferred.scheduleDefMethodLutRebuild(resolver);
      // 让出若干拍(调度/微任务全跑完)再验:零条目、启动位未翻
      for (let i = 0; i < 5; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(deferred.getDefMethodLut().size()).toBe(0);
      expect((deferred as unknown as { startupStarted: boolean }).startupStarted).toBe(false);
    } finally {
      deferred.dispose();
    }
  });

  it('KODE-RESP-004:LUT 重建不持调度槽等首扫(自锁「一直在扫」收口)', async () => {
    const deferred = new EntityMappingManager({ subscriptions: [] } as never, undefined, { deferStartup: true });
    const internal = deferred as unknown as {
      initialScan: Promise<void>;
      scheduler: {
        enqueue(spec: {
          kind: string;
          priority: number;
          run: () => Promise<void>;
        }): { wait: Promise<void> };
      };
    };
    try {
      deferred.ensureStartup();
      // 钉住首扫终态:落定权在本测试(模拟「首扫分块仍在排队」的窗口)。
      let releaseScan!: () => void;
      internal.initialScan = new Promise<void>(resolve => { releaseScan = resolve; });

      const rebuild = deferred.scheduleDefMethodLutRebuild(resolver);
      // 让泵跑一拍:旧口径下 def-lut-build 是唯一任务,必已持槽起跑
      // (新口径闸在任务外,此拍无事发生);再投探针才还原「分块排在
      // 持槽任务之后」的自锁时序。
      await Promise.resolve();
      await Promise.resolve();
      // 同调度器上排队一个普通任务(首扫分块同型):首扫未落定时也必须
      // 能拿到槽执行完——旧口径 def-lut-build 的 run() 持槽
      // await initialScan,排队任务被饿死,首扫分块同理 → 自锁。
      let probeRan = false;
      void internal.scheduler.enqueue({
        kind: 'full-reindex',
        priority: 1,
        run: async () => { probeRan = true; }
      });
      await until(() => probeRan, 'probe task must run while initial scan is pending');

      releaseScan();
      await rebuild;
    } finally {
      deferred.dispose();
    }
  }, 10000);
});
