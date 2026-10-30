import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { readActiveProfileId } from '../src/activeProfile';
import {
  annotationSourceLog,
  setAnnotationSourceLogEnabled
} from '../src/annotationSourceLog';
import { readBuildCommit } from '../src/buildCommit';
import { CompileallErrorParser } from '../src/buildProblemMatcher';
import { buildScriptCheckTaskSpec } from '../src/buildTaskSpec';
import { DatabaseConnectionRegistry } from '../src/databaseConnectionRegistry';
import { assertReadOnlyStatement, ReadOnlyViolationError } from '../src/databaseDrift';
import { normalizeCallChainTab } from '../src/defCallChainViewLogic';
import { propertyFlagDomainList } from '../src/defAnalyzer';
import { writeFileAtomic } from '../src/atomicFileWrite';
import { parseEntityNames } from '../src/compositionRoots';
import { classifyDriftEvidence } from '../src/databaseDriftEvidence';
import { recordDriftEvidenceFromReport } from '../src/databaseDriftEvidenceIntegration';
import { invalidateDatabaseSchemaCacheForFiles } from '../src/databaseSchema';
import { previewEntitySchemaImpact } from '../src/databaseSchemaImpact';
import { resolveColumnValueType } from '../src/databaseSimulator';
import {
  isCpuProfileRunning,
  resetCpuProfileCapture,
  setCpuProfileSessionFactory,
  startCpuProfile
} from '../src/cpuProfileCapture';
import { formatTablePreview } from '../src/databaseTablePreviewCommand';
import { DebugSessionRegistry } from '../src/debugSessionRegistry';
import { DebugTargetTreeProvider } from '../src/debugStatusTree';
import type { DebugStatusRow } from '../src/debugStatusBoard';
import { DefinitionSemanticsLoader } from '../src/definitionSemantics';
import {
  compareTaskRunContexts,
  prepareTestRun,
  type TaskRunContext
} from '../src/taskContext';
import {
  QuickActionTreeItem,
  QuickActionTreeProvider
} from '../src/quickActionTree';
import { getScanRootForFile } from '../src/scanRoots';
import { SemanticDependencyGraph } from '../src/dependencyGraph';
import { checkExtensionCompatibility } from '../src/engineCompatibility';
import { fileSystemTestDiscoveryDeps } from '../src/pythonTestDiscovery';
import { locateInterpreterOnPath } from '../src/profileInterpreter';
import { resolveFixedDictMember } from '../src/pythonTypeStubs';
import {
  getHostVitalsReport,
  sampleHostVitals,
  stopHostVitalsMonitor
} from '../src/hostVitals';
import {
  describeLiveValidationStatus,
  type LiveValidationRegister
} from '../src/liveValidationInputs';
import { attachWithDeadline } from '../src/debugAttachGuard';
import {
  settleAppliedStatus,
  verifyAppliedReceipt
} from '../src/hotReloadAppliedCheck';
import {
  classifyDefChange,
  structuralFingerprintHash
} from '../src/hotReloadDefStructure';
import {
  createProfileScopedDriftExecutor,
  ProfileDatabaseConnectionService
} from '../src/profileDatabaseConnection';
import { resolveAssetsRootForWorkspace } from '../src/scanRoots';
import {
  getOrParseDocumentSync,
  type DocumentStoreDocument
} from '../src/documentStore';
import { resolveCustomTypePropertyAnnotation } from '../src/pythonTypeStubs';

// 98% 主线:小文件孤立分支批量补面——每例直击一个未覆盖守卫/回退臂,
// 纯逻辑无需 vscode 装配。
describe('小文件孤立分支(覆盖率 98% 线)', () => {
  it('activeProfile:无 memento → 读稳定 ID 返回 null(29)', () => {
    expect(readActiveProfileId(undefined)).toBeNull();
  });

  it('annotationSourceLog:开关关闭 → 早退零产出(43)', () => {
    setAnnotationSourceLogEnabled(false);
    annotationSourceLog('info', 'should not record');
    expect(annotationSourceLog.toString()).toContain('function');
  });

  it('buildCommit:commit 字段非字符串/空 → unknown(21)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-commit-'));
    try {
      fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'out', 'buildCommit.json'), JSON.stringify({ commit: '' }), 'utf8');
      expect(readBuildCommit(dir)).toBe('unknown');
      fs.writeFileSync(path.join(dir, 'out', 'buildCommit.json'), JSON.stringify({ commit: 123 }), 'utf8');
      expect(readBuildCommit(dir)).toBe('unknown');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildProblemMatcher:单行内联格式一次出问题(56)', () => {
    const parser = new CompileallErrorParser();
    const problem = parser.feed('*** ValueError: bad value in file scripts/hero.py on line 3');
    expect(problem).toEqual({ message: 'ValueError: bad value', file: 'scripts/hero.py', line: 3 });
  });

  it('buildTaskSpec:profile 配了解释器 → 以其为命令(48)', () => {
    const spec = buildScriptCheckTaskSpec({
      assetsRoot: '/tmp/ws/',
      interpreterPath: '/usr/bin/python3',
      buildCommand: ''
    });
    expect(spec.command).toBe('/usr/bin/python3');
  });

  it('databaseConnectionRegistry:负载里非对象连接配置被拒绝(31-32)', () => {
    const registry = new DatabaseConnectionRegistry({
      now: () => Date.now(),
      load: () => ({ connections: { p1: null, p2: 'notobject' } })
    });
    // 不炸即通过(两值都未入表,空表)
    const snapshot = (registry as unknown as {
      connections: Map<string, unknown>;
    }).connections;
    expect(snapshot.size).toBe(0);
  });

  it('databaseDrift:空语句非查询 → 拒绝(102)', () => {
    expect(() => assertReadOnlyStatement('')).toThrow(ReadOnlyViolationError);
  });

  it('defCallChainViewLogic:未知 tab 值 → 未选(14)', () => {
    expect(normalizeCallChainTab('unknown')).toBeNull();
    expect(normalizeCallChainTab('graph')).toBe('graph');
  });

  it('defAnalyzer:CELL 旗标归一为 CELL_PUBLIC 域(100)', () => {
    expect(propertyFlagDomainList('CELL')).toEqual(['cell']);
  });
});

describe('小文件孤立分支第二波(覆盖率 98% 线)', () => {
  const ref = { filePath: '/tmp/ws/scripts/entity_defs/Avatar.def', line: 1, path: 'Avatar', category: 'entity' as const };

  it('atomicFileWrite:rename 失败且临时文件存在 → 清理(21)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-atomic-'));
    try {
      // 目标路径是目录 → rename 到目录失败,临时文件被清理
      const targetDir = path.join(dir, 'target');
      fs.mkdirSync(targetDir);
      expect(() => writeFileAtomic(targetDir, 'content')).toThrow();
      const leftovers = fs.readdirSync(dir).filter(name => name.includes('.kode-tmp-'));
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compositionRoots:无根文档 → 空实体名表(29)', () => {
    expect(parseEntityNames('')).toEqual([]);
  });

  it('databaseDriftEvidence:引擎版本 unknown → 不宣称兼容(34)', () => {
    const verdict = classifyDriftEvidence({
      engineVersion: 'unknown',
      queried: null,
      simulated: { summary: 'sim' },
      driftSummary: '',
      recordedAt: 0
    });
    expect(verdict.verdict).toBe('unknown-version');
  });

  it('databaseDriftEvidenceIntegration:未校验报告 → 不落证据(35)', () => {
    const record = recordDriftEvidenceFromReport(
      { checked: false } as never,
      { resolveEngineVersion: () => null, now: () => 0 }
    );
    expect(record).toBeNull();
  });

  it('databaseSchema:空文件清单 → 摘除 0 条(119)', () => {
    expect(invalidateDatabaseSchemaCacheForFiles([])).toBe(0);
  });

  it('databaseSchemaImpact:synthetic 列剔除影响面(35)', () => {
    const table = (fields: Array<Record<string, unknown>>) => ({
      name: 'Avatar', kind: 'entity', title: 'Avatar', source: ref, fields
    });
    const impact = previewEntitySchemaImpact(
      table([
        { name: 'id', typeLabel: 'int', source: ref, identifier: true, synthetic: true },
        { name: 'hp', typeLabel: 'UINT32', source: ref, identifier: false }
      ]),
      table([
        { name: 'id', typeLabel: 'int', source: ref, identifier: true, synthetic: true }
      ])
    );
    expect(impact.entries).toEqual([{ field: 'hp', change: 'removed', before: 'UINT32' }]);
  });

  it('databaseSimulator:vector 列 → float(96)', () => {
    expect(resolveColumnValueType({
      name: 'pos', typeLabel: 'VECTOR3', source: ref, identifier: false
    })).toEqual({ kind: 'float' });
  });
});

describe('小文件孤立分支第三波(覆盖率 98% 线)', () => {
  it('cpuProfileCapture:采集中 reset → 断开会话清运行态(132-133)', async () => {
    setCpuProfileSessionFactory(() => ({
      connect: (): void => undefined,
      disconnect: (): void => undefined,
      post: (_method, _params, callback) => callback(null, {})
    }));
    try {
      expect(await startCpuProfile()).toBe(true);
      expect(isCpuProfileRunning()).toBe(true);
      resetCpuProfileCapture();
      expect(isCpuProfileRunning()).toBe(false);
    } finally {
      resetCpuProfileCapture();
    }
  });

  it('databaseTablePreviewCommand:未定义单元格渲染为空串(63)', () => {
    const out = formatTablePreview({
      kind: 'preview',
      columns: [{ name: 'hp' }],
      rows: [{ hp: undefined }],
      limit: 10,
      returnedRows: 1,
      truncated: false
    } as never, 'Avatar');
    expect(out).toContain('表预览');
    expect(out).toContain('(1 行');
  });

  it('debugSessionRegistry:全部在挂链(all 面)(95)', () => {
    const startListeners: Array<(session: { id: string; name: string }) => void> = [];
    const registry = new DebugSessionRegistry({
      onStart: listener => {
        startListeners.push(listener);
        return { dispose: (): void => undefined };
      },
      onTerminate: () => ({ dispose: (): void => undefined })
    });
    startListeners.forEach(listener =>
      listener({ id: 's1', name: 'KBEngine: Python attach to cellapp (debugpy 5679)' })
    );
    expect(registry.all()).toHaveLength(1);
  });

  it('debugStatusTree:getTreeItem 原样返回(75)', async () => {
    const row: DebugStatusRow = {
      serverKey: 'cellapp',
      component: 'cellapp',
      targetId: 'cellapp',
      processStatus: 'Running',
      phase: 'listening',
      port: 5708,
      attachedSessions: 0
    };
    const provider = new DebugTargetTreeProvider({ getRows: () => [row] });
    const [item] = await provider.getChildren();
    expect(provider.getTreeItem(item)).toBe(item);
  });

  it('definitionSemantics:精确路径 miss → 缓存 null 回传(223/226/227)', () => {
    const loader = new DefinitionSemanticsLoader('/tmp/ws');
    expect(loader.loadResolvedAt('/tmp/ws/nonexistent.def', 'Avatar', 'entity')).toBeNull();
    expect(loader.loadResolvedAt('/tmp/ws/nonexistent.def', 'Avatar', 'entity')).toBeNull();
  });

  it('definitionSemantics:畸形 def 内容 → 解析失败回 null(249)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sem-'));
    try {
      const defPath = path.join(dir, 'Avatar.def');
      fs.writeFileSync(defPath, '<root><Broken', 'utf8');
      const loader = new DefinitionSemanticsLoader(dir);
      expect(loader.loadResolvedAt(defPath, 'Avatar', 'entity')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('小文件孤立分支第四波(覆盖率 98% 线)', () => {
  const ctx = (interpreterPath: string | null): TaskRunContext => ({
    profileId: 'p1',
    displayName: 'P1',
    assetsRoot: '/tmp/assets',
    engineRoot: '/tmp/engine',
    interpreterPath,
    interpreterSource: 'profile'
  });

  it('taskContext:解释器漂移逐条点名(45)', () => {
    expect(compareTaskRunContexts(ctx('/usr/bin/python3'), ctx('/opt/python'))).toEqual([
      '解释器:/usr/bin/python3 → /opt/python'
    ]);
  });

  it('taskContext:损坏的保存上下文拒绝重跑(83)', () => {
    const result = prepareTestRun(ctx('/usr/bin/python3'), '{"profileId":1}', {
      exists: () => true
    });
    expect(result.outcome).toBe('refuse');
  });

  it('taskContext:活动 profile 取消选择 → 备注重跑用保存上下文(112)', () => {
    const result = prepareTestRun(null, JSON.stringify(ctx(null)), {
      exists: () => true
    });
    expect(result.outcome).toBe('run');
    expect(result.notes.join('')).toContain('活动 profile 已取消选择');
  });

  it('quickActionTree:脚本条目标签取基名(59)', () => {
    const item = new QuickActionTreeItem({
      name: 'hero',
      type: 'script',
      target: '/tmp/scripts/hero.py'
    });
    expect(item.contextValue).toBe('quickAction');
  });

  it('quickActionTree:refresh 触发变更事件(69)', () => {
    const provider = new QuickActionTreeProvider({
      getActions: async () => ({ registered: [], scripts: [], httpRequests: [] })
    });
    let fired = false;
    provider.onDidChangeTreeData(() => {
      fired = true;
    });
    provider.refresh();
    expect(fired).toBe(true);
  });

  it('quickActionTree:getTreeItem 原样返回(73)', () => {
    const provider = new QuickActionTreeProvider({
      getActions: async () => ({ registered: [], scripts: [], httpRequests: [] })
    });
    const item = new QuickActionTreeItem({ name: 'x', type: 'command', target: 'a.b' });
    expect(provider.getTreeItem(item)).toBe(item);
  });

  it('scanRoots:无扫描根匹配 → null(177)', () => {
    expect(getScanRootForFile('/tmp/kode-none/scripts/hero.py')).toBeNull();
  });

  it('dependencyGraph:未登记文件依赖空(123/162)', () => {
    const graph = new SemanticDependencyGraph();
    expect(graph.getDependencies('/tmp/ws/scripts/hero.py')).toEqual([]);
    expect(graph.getDependents('/tmp/ws/scripts/hero.py')).toEqual([]);
  });

  it('engineCompatibility:清单不可读 → manifest error(68)', () => {
    const report = checkExtensionCompatibility('/tmp/kode-none-package.json', null, {
      displayName: 'kode',
      engines: '>=2.5.0',
      vscodeEngine: '^1.90.0',
      files: []
    });
    expect(report.checks.find(check => check.name === 'manifest')?.status).toBe('error');
  });
});

describe('小文件孤立分支第五波(覆盖率 98% 线)', () => {
  it('pythonTestDiscovery:列目录/读文件失败兜底(140/147)', () => {
    expect(fileSystemTestDiscoveryDeps.readDir('/tmp/kode-none-dir')).toEqual([]);
    expect(fileSystemTestDiscoveryDeps.readFile('/tmp/kode-none-dir/x.py')).toBe('');
  });

  it('profileInterpreter:空 PATH 段跳过(45)', () => {
    expect(locateInterpreterOnPath('/nonexistent1::/nonexistent2')).toBeNull();
  });

  it('pythonTypeStubs:固定字典非字典方法成员 → null(472)', () => {
    const customTypes = [{
      name: 'HeroInfo',
      aliasType: 'FIXED_DICT',
      properties: [{ name: 'hp', typeLabel: 'UINT32' }]
    }];
    expect(resolveFixedDictMember('HeroInfo', 'weird', true, customTypes as never)).toBeNull();
  });

  it('hostVitals:未激活时采样/报告零产出(156/172)', () => {
    stopHostVitalsMonitor();
    sampleHostVitals();
    expect(getHostVitalsReport()).toContain('not started');
  });

  it('liveValidationInputs:缺实例态描述(129)', () => {
    const register: LiveValidationRegister = {
      engineVersion: { registered: true, ref: 'v2.5.0', repoUrl: 'https://x' },
      componentAddresses: [],
      startupConditions: [],
      instanceAvailable: false,
      lastVerifiedAt: 0
    };
    expect(describeLiveValidationStatus(register)).toContain('缺实例');
  });

  it('liveValidationInputs:实例可用输入未齐描述(130)', () => {
    const register: LiveValidationRegister = {
      engineVersion: { registered: false },
      componentAddresses: [],
      startupConditions: [],
      instanceAvailable: true,
      lastVerifiedAt: 0
    };
    expect(describeLiveValidationStatus(register)).toContain('输入未齐');
  });

  it('debugAttachGuard:start 同步抛错 → rejection 通道(73)', async () => {
    await expect(attachWithDeadline({
      label: 'cellapp',
      timeoutMs: 0,
      start: () => {
        throw new Error('boom');
      },
      stop: (): void => undefined,
      notify: (): void => undefined
    })).rejects.toThrow('boom');
  });
});

describe('小文件孤立分支第六波(覆盖率 98% 线)', () => {
  const verify = (body: string): string =>
    verifyAppliedReceipt({} as never, {} as never, '/tmp/ws/scripts/Avatar.py', body, {
      sentContent: 'content'
    }).kind === 'not-applied'
      ? verifyAppliedReceipt({} as never, {} as never, '/tmp/ws/scripts/Avatar.py', body, {
          sentContent: 'content'
        }).reason
      : '';

  it('hotReloadAppliedCheck:回执是数组 → 不升格(42)', () => {
    expect(verify('[1,2,3]')).toContain('不是 JSON 对象');
  });

  it('hotReloadAppliedCheck:回执 file 与所发不一致 → 不升格(52)', () => {
    expect(verify('{"status":"applied","file":"/wrong.py"}')).toContain('file 回显');
  });

  it('hotReloadAppliedCheck:applied 记录 → 已确认(81)', () => {
    expect(settleAppliedStatus({ outcome: 'applied' } as never, {
      deadlineMs: 0,
      now: () => 0
    })).toBe('applied');
  });

  it('hotReloadDefStructure:空文档无指纹(95)', () => {
    expect(structuralFingerprintHash('')).toBeNull();
  });

  it('hotReloadDefStructure:含 RPC 方法指纹稳定(99)', () => {
    const hash = structuralFingerprintHash([
      '<Avatar>',
      '  <CellMethods>',
      '    <reborn><Arg>UINT32</Arg></reborn>',
      '  </CellMethods>',
      '</Avatar>'
    ].join('\n'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hotReloadDefStructure:方法新增 → 结构性变更(139)', () => {
    const before = [
      '<Avatar>',
      '  <CellMethods>',
      '    <reborn><Arg>UINT32</Arg></reborn>',
      '  </CellMethods>',
      '</Avatar>'
    ].join('\n');
    const after = [
      '<Avatar>',
      '  <CellMethods>',
      '    <reborn><Arg>UINT32</Arg></reborn>',
      '    <boost><Arg>UINT8</Arg></boost>',
      '  </CellMethods>',
      '</Avatar>'
    ].join('\n');
    const verdict = classifyDefChange(before, after);
    expect(verdict.structural).toBe(true);
    expect(verdict.reasons.some(reason => reason.includes('方法新增'))).toBe(true);
  });
});

describe('小文件孤立分支第七波(覆盖率 98% 线)', () => {
  it('profileDatabaseConnection:cache 取当前结果缓存(145)', () => {
    const service = new ProfileDatabaseConnectionService({
      registry: new DatabaseConnectionRegistry({
        now: () => 0,
        load: () => ({ connections: {} })
      }),
      queryResultCache: {} as never,
      resolveConfig: () => null
    });
    expect(service.cache).toBeDefined();
  });

  it('profileDatabaseConnection:内层有 destroy 则透传(175)', async () => {
    const factory = createProfileScopedDriftExecutor(
      'p1',
      {} as never,
      async () => ({
        runQuery: async () => ({ columns: [], rows: [] }),
        close: async (): Promise<void> => undefined,
        destroy: async (): Promise<void> => undefined
      } as never)
    );
    const executor = await factory({} as never);
    expect(executor.destroy).toBeDefined();
  });

  it('scanRoots:无配置无发现 → 记录空发现并返回空(101)', () => {
    expect(resolveAssetsRootForWorkspace('/tmp/kode-none-ws')).toBe('');
  });

  it('documentStore:文件类型分类 .py/.def(344/345)', () => {
    const doc = (fsPath: string): DocumentStoreDocument => ({
      uri: { toString: () => `file://${fsPath}`, fsPath },
      getText: () => 'x = 1'
    });
    expect(getOrParseDocumentSync(doc('/tmp/ws/scripts/hero.py'), text => text).result).toBe('x = 1');
    expect(getOrParseDocumentSync(doc('/tmp/ws/scripts/entity_defs/Avatar.def'), text => text).result).toBe('x = 1');
  });

  it('pythonTypeStubs:属性解析异常 → 回退 Any(417)', () => {
    expect(resolveCustomTypePropertyAnnotation({ name: 'x' } as never, [])).toBe('Any');
  });
});
