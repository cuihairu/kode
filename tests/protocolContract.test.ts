import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, describe, expect, it } from 'vitest';

import { KODE_FILE_CHANGED_METHOD } from '../src/backend/fileChangeBypass';
import { KodeCoreClient, KODE_PROTOCOL_VERSION } from '../src/backend/kodeCoreClient';

// RUST-055(部分,第一增量):协议契约门——TS 消费的 RPC 面对着真实
// kode-server 二进制钉**应答形状**(键集+类型,不钉数值),把 mock-vs-wire
// 契约漂移的教训(mock 编码实现侧形状≠线上契约)变成常红闸:Rust 侧行为
// 即规范真源,TS 侧类型与封装必须与观测形状一致;任一侧漂移本门即红。
// 覆盖核心面:initialize/health/$/kode/rpc 信封(echo 往返+method not found
// 错误码)/textDocument 四面(hover/definition/completion/diagnostic)。
// 二进制缺失时现场 cargo build;无 Rust 工具链环境整套 skip(同 kodeCoreE2E)。

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');

if (!existsSync(binaryPath)) {
  spawnSync('cargo', ['build', '-p', 'kode-server'], { cwd: repoRoot, timeout: 300_000 });
}
const binaryReady = existsSync(binaryPath);

const sortedKeys = (value: unknown): string[] =>
  Object.keys(value as Record<string, unknown>).sort();

const suite = binaryReady ? describe : describe.skip;
const URI = 'file:///workspace/contract/entities/Monster.def';

// RUST-064:协议版本双源同步守卫(无需二进制,恒跑)——TS 侧
// KODE_PROTOCOL_VERSION 与 Rust 侧 kode-protocol PROTOCOL_VERSION 任一侧
// 独自升版,运行时版本门(kodeCoreClient RUST-008 判据①)会让每个会话
// 拒绝对讲回落 ts;本守卫把这类漂移提前到单测门暴露。
describe('协议版本双源同步(无需二进制)', () => {
  it('TS KODE_PROTOCOL_VERSION 与 Rust kode-protocol PROTOCOL_VERSION 一致', () => {
    const rust = /PROTOCOL_VERSION:\s*&str\s*=\s*"([^"]+)"/.exec(
      readFileSync(join(repoRoot, 'crates', 'kode-protocol', 'src', 'lib.rs'), 'utf8')
    );
    expect(rust).not.toBeNull();
    expect(rust?.[1]).toBe(KODE_PROTOCOL_VERSION);
  });
});

suite('协议契约门(真实 kode-server 应答形状)', () => {
  const clients: KodeCoreClient[] = [];
  afterAll(async () => {
    for (const client of clients) {
      await client.dispose().catch(() => undefined);
    }
  });

  function makeClient(): KodeCoreClient {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/contract', capabilities: {} },
      onStderr: () => undefined,
    });
    clients.push(client);
    return client;
  }

  it('initialize:capabilities/serverInfo 键集钉死', async () => {
    const client = makeClient();
    const result = await client.start();
    expect(sortedKeys(result)).toEqual(['capabilities', 'serverInfo']);
    expect(sortedKeys(result.capabilities)).toEqual(
      [
        'completionProvider',
        'definitionProvider',
        'documentSymbolProvider',
        'hoverProvider',
        'textDocumentSync'
      ]
    );
    // RUST-139 批 3:textDocument/documentSymbol(def 段符号面)能力声明。
    expect(result.capabilities.documentSymbolProvider).toBe(true);
    expect(result.capabilities.textDocumentSync).toEqual({ openClose: true, change: 1 });
    // completion triggerCharacters 面随契约钉死(def 标签补全 '<' 触发);
    // RUST-135:resolveProvider 延迟补详情面(complationItem/resolve)同契约。
    const completionProvider = result.capabilities.completionProvider as {
      triggerCharacters: string[];
      resolveProvider: boolean;
    };
    expect(completionProvider.triggerCharacters).toEqual(['<']);
    expect(completionProvider.resolveProvider).toBe(true);
    expect(sortedKeys(result.serverInfo)).toEqual(['name', 'version']);
    // RUST-064:真二进制上报版本必须与 TS 侧常量一致(运行时版本门的
    // 上游事实面;漂移时 RUST-008 版本门会在扩展侧拒绝对讲)
    expect(result.serverInfo.version).toBe(KODE_PROTOCOL_VERSION);
    await client.dispose();
  }, 20_000);

  it('health:顶层键集与 resources 键集钉死(开文档前后 documents 形状一致)', async () => {
    const client = makeClient();
    await client.start();
    client.openDocument(URI, 'kbengine-def', 1, '<Entity><GroupName>mob</GroupName></Entity>');
    const health = await client.health();
    expect(sortedKeys(health)).toEqual(
      ['documents', 'indexGaps', 'ingest', 'initialized', 'maintenance', 'parseCache',
       'pid', 'pool', 'resources', 'restartGeneration', 'serverVersion',
       'shutdownRequested', 'status', 'uptimeMs', 'warm']
    );
    // RUST-133:索引缺口观测恒装配(unindexed/partial/stale 三族;fresh
    // server 零缺口,partial 计数 0 且暖扫外 known/missing 诚实 null)。
    expect(health.indexGaps).toEqual({
      unindexed: { known: null, indexed: 0, missing: null },
      partial: { count: 0, samples: [] },
      stale: { queued: expect.any(Number), stormBuffered: expect.any(Number) },
    });
    // RUST-074-W:暖门观测恒装配(fresh server 未 begin = idle 全形状)。
    expect(health.warm).toEqual({
      state: 'idle', coldWhileWarming: 0, done: 0, failed: 0, total: null
    });
    // RUST-078-W:驻留维护观测恒装配(新进程零老化零回收;RSS 未采样=null)。
    expect(health.maintenance).toEqual({
      agedTerminal: 0, pressureReclaims: 0, lastRssBytes: null
    });
    // RUST-070/071/073:索引刷新队列观测恒装配(open 一文件后:该文件
    // 的 ingest 已入队;请求入口 freshen 使其可执行,queued 0/1 均为合法
    // 瞬态,只钉累计计数形状与 open 的入队事实)。
    // RUST-082:didChange 风暴缓冲五记账键同笔恒装配。
    // RUST-120-W:分类失效四记账键(identical/bodyOnly/signature/removed)。
    expect(sortedKeys(health.ingest)).toEqual(
      ['enqueued', 'executed', 'ingestBodyOnly', 'ingestIdentical',
       'ingestRemoved', 'ingestSignature', 'merged', 'purged', 'queued',
       'rejectedQueueFull', 'staleDropped', 'stormBuffered',
       'stormDeadlineFlushes', 'stormForcedFlushes', 'stormMerged',
       'stormSeen']
    );
    expect(health.ingest.enqueued).toBeGreaterThanOrEqual(1);
    for (const value of Object.values(health.ingest ?? {})) {
      expect(typeof value).toBe('number');
    }
    // RUST-125:解析驻留观测恒装配(预算构造 256MB 常量口径;打开一文件
    // 后驻留增长,驱逐未发生=0)。didOpen 的 parse 在队列泵上异步执行,
    // 满载下 health 可能早于首 parse 到达(valid=0 瞬态)——形状/常量断言
    // 不轮询,就绪面(valid/resident)有界轮询至首 parse 落账。
    expect(sortedKeys(health.parseCache)).toEqual(
      ['budgetBytes', 'evictions', 'negative', 'residentBytes', 'valid']
    );
    expect(health.parseCache.budgetBytes).toBe(256 * 1024 * 1024);
    expect(health.parseCache.evictions).toBe(0);
    let parseReady = health.parseCache;
    for (let attempt = 0; attempt < 50 && parseReady.valid < 1; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      parseReady = (await client.health()).parseCache;
    }
    expect(parseReady.valid).toBeGreaterThanOrEqual(1);
    expect(parseReady.residentBytes).toBeGreaterThan(0);
    // RUST-075-W:worker 执行器默认装配,健康面带池记账键。
    // RUST-076-W:LaneGate 泳道记账键(ioRunning/cpuRunning)入池形状。
    expect(sortedKeys(health.pool)).toEqual(
      ['backgroundRunning', 'cpuRunning', 'interactiveRunning', 'ioRunning',
       'jobsCancelled', 'jobsDone', 'jobsFailed', 'workers']
    );
    // 空闲池:泳道在飞全 0(交互预留位经 interactiveRunning 口径呈现,
    // LaneGate 的 Interactive 记数不重复出表)。
    expect(health.pool).toMatchObject({
      ioRunning: 0, cpuRunning: 0, interactiveRunning: 0, backgroundRunning: 0
    });
    for (const value of Object.values(health.pool ?? {})) {
      expect(typeof value).toBe('number');
    }
    expect(Array.isArray(health.documents)).toBe(true);
    expect(health.documents[0]).toEqual({ uri: URI, version: 1 });
    expect(sortedKeys(health.resources)).toEqual(
      ['cpuTimeMs', 'diskReadBytes', 'diskWriteBytes', 'rssBytes', 'threads']
    );
    for (const value of Object.values(health.resources ?? {})) {
      expect(typeof value).toBe('number');
    }
    await client.dispose();
  }, 20_000);

  it('$/kode/index 暖门四面:屏障期真实 RPC 照常解析,incomplete 显式,刷新与取消无假 pending', async () => {
    const client = makeClient();
    await client.start();
    expect(await client.warmState()).toEqual({
      state: 'idle', coldWhileWarming: 0, done: 0, failed: 0, total: null
    });
    // 可控屏障:begin 后不发 complete——首扫挂住 = Warming;进行中复用。
    expect(await client.beginBackgroundScan(1000)).toEqual({
      state: 'warming', decision: 'queued', scanId: 1
    });
    expect(await client.beginBackgroundScan(1000)).toEqual({
      state: 'warming', decision: 'reused', scanId: 1
    });
    // 屏障期真实 RPC:目标文件照常解析(池交互优先级,请求不等首扫)。
    const flow = (await client.request('$/kode/rpc', {
      method: '$/kode/python/selfAttributeFlow',
      params: {
        lines: [
          'class Avatar:',
          '    def __init__(self):',
          '        self.hp = 100',
          '    def take_damage(self, n):',
          '        self.hp -= n'
        ],
        queryLine: 4,
        attr: 'hp'
      }
    })) as { flow: { types: string[] } };
    expect(flow.flow.types).toContain('int');
    // 未覆盖显式 incomplete:warming + 冷请求计数(真实 RPC 记账)。
    const warming = await client.warmState();
    expect(warming.state).toBe('warming');
    expect(warming.coldWhileWarming).toBeGreaterThanOrEqual(1);
    // 完成 → Warm;刷新循环:Warm 后再 begin = 全新入队。
    expect(await client.scanComplete(1000, 0)).toEqual({ state: 'warm', done: 1000, failed: 0 });
    expect((await client.warmState()).state).toBe('warm');
    expect((await client.beginBackgroundScan(5)).decision).toBe('queued');
    // 取消 → Idle 不留假 pending;迟到 complete 诚实拒(-32602)。
    expect(await client.scanCancel()).toEqual({ state: 'idle' });
    await expect(client.scanComplete(5, 0)).rejects.toThrow(/no background scan in progress/);
    const idle = await client.warmState();
    expect(idle.state).toBe('idle');
    expect(idle.coldWhileWarming).toBeGreaterThanOrEqual(1);
    expect(await client.scanCancel()).toEqual({ state: 'idle' });
    await client.dispose();
  }, 20_000);

  it('$/kode/rpc 信封:echo 直返值(不包 ok 信封),未知方法 -32601', async () => {
    const client = makeClient();
    await client.start();
    const echoed = await client.request('$/kode/rpc', {
      method: '$/kode/echo',
      params: { seq: 7, blob: 'x' }
    });
    // 直返 dispatch 值:无 ok/error 包裹层(包裹层属 TS 侧封装,不在线上)
    expect(sortedKeys(echoed)).toEqual(['blob', 'seq']);
    expect(echoed.seq).toBe(7);
    // TS 侧错误映射:server JSON-RPC error code → 字符串码(非 -32800 一律
    // SERVER_ERROR),原文码进 message——两侧契约都在钉
    await expect(client.request('$/kode/rpc', { method: '$/kode/no-such-method', params: {} }))
      .rejects.toMatchObject({ code: 'SERVER_ERROR' });
    await expect(client.request('$/kode/rpc', { method: '$/kode/no-such-method', params: {} }))
      .rejects.toThrow(/-32601.*method not found/);
    await client.dispose();
  }, 20_000);

  it('textDocument/diagnostic:full 面 item 键集钉死(未注册类型 Error 项)', async () => {
    const client = makeClient();
    await client.start();
    client.openDocument(URI, 'kbengine-def', 1, '<Entity><GroupName>mob</GroupName></Entity>');
    const result = (await client.request('textDocument/diagnostic', {
      textDocument: { uri: URI }
    })) as { kind: string; items: Array<Record<string, unknown>> };
    expect(sortedKeys(result)).toEqual(['items', 'kind']);
    expect(result.kind).toBe('full');
    expect(Array.isArray(result.items)).toBe(true);
    for (const item of result.items) {
      // LSP Diagnostic 形状:range/severity/message 必在;键集钉死防漂移
      expect(sortedKeys(item)).toEqual(['message', 'range', 'severity']);
      expect(sortedKeys(item.range)).toEqual(['end', 'start']);
      expect(sortedKeys(item.range.start)).toEqual(['character', 'line']);
    }
    await client.dispose();
  }, 20_000);

  it('textDocument/hover|definition|completion:打开文档上的未命中面形状(null/空集)', async () => {
    const client = makeClient();
    await client.start();
    client.openDocument(URI, 'kbengine-def', 1, '<Entity><GroupName>mob</GroupName></Entity>');
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri: URI }, position: { line: 0, character: 2 }
    });
    // 词不命中任何声明符号 → JSON null(不是空对象/空 contents)
    expect(hover).toBeNull();
    const definition = await client.request('textDocument/definition', {
      textDocument: { uri: URI }, position: { line: 0, character: 2 }
    });
    expect(definition === null || Array.isArray(definition)).toBe(true);
    const completion = await client.request('textDocument/completion', {
      textDocument: { uri: URI }, position: { line: 0, character: 2 }
    });
    // 未命中(词上下文判定不出)→ null,不是空数组(实测钉死,防 TS 侧
    // 把 null 当 [] 展开成假命中面)
    expect(completion === null || Array.isArray(completion)).toBe(true);
    for (const item of (completion as Array<Record<string, unknown>> | null) ?? []) {
      expect(typeof item.label).toBe('string');
    }
    await client.dispose();
  }, 20_000);
});

// RUST-055 第二增量:全协议面清单——TS 消费的 34 个 `$/kode/*` 请求方法逐一
// 入契约门(TS 侧方法字面量 grep 全集 vs Rust RpcRegistry 注册集零漂移已由
// 构建 probe 对齐;`$/kode/fileChanged` 是单向通知无应答面,`$/kode/rpc` 信封
// 与 health 已在上文钉)。方法级应答形状钉法:**递归形状指纹**(对象=排序键集
// 逐键递归,数组=首元素形状,叶子=JSON 类型),值不钉(值属各分析面单测);
// 复杂输入面(dbClone 家族)钉错误信封面(INVALID_PARAMS/-32602),深度往返
// 形状由 Rust dispatch 测试与 kode-kbengine cli_acceptance 承载。ruff/lint
// 因 ruff 可用性机器相关,只钉结构面不钉指纹。prove-red 面:改 Rust 任一应答
// 键名 → 本门红(由首条 lint/* 指纹承载)。
suite('全协议面:34 方法逐一形状钉(真实 kode-server)', () => {
  const PROBE = process.env.KODE_CONTRACT_PROBE === '1';

  /** 递归形状指纹:对象→{键:形状} 键排序;数组→[首元素形状] 或 [];叶子→JSON 类型名(null 单列,不与 object 混) */
  const shapeOf = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.length === 0 ? [] : [shapeOf(value[0])];
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = shapeOf((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value === null ? 'null' : typeof value;
  };

  const PY_FIXTURE = [
    'class Avatar:',
    '    def __init__(self):',
    '        self.hp = None',
    '        self.name = "avatar"',
    '',
    '    def onLevelUp(self, amount):',
    '        self.hp = (self.hp or 0) + amount',
    '        self.base.cellReq("teleport", 1)',
    '        self.client.onLevelOk()',
    '',
    '    @property',
    '    def level(self):',
    '        return 1',
    ''
  ].join('\n');
  const PY_LINES = PY_FIXTURE.split('\n');
  const DEF_FIXTURE =
    '<Entity><GroupName>mob</GroupName><Properties><Property name="level" type="UINT8"/></Properties></Entity>';

  interface SurfaceProbe {
    method: string;
    params: () => Record<string, unknown>;
    /** 'pin' = 全指纹钉;'ruff' = 结构面钉(ruff 可用性机器相关) */
    face: 'pin' | 'ruff';
  }

  const probes: SurfaceProbe[] = [
    { method: '$/kode/lint/analyzeDef', face: 'pin', params: () => ({ text: DEF_FIXTURE }) },
    { method: '$/kode/lint/analyzeAttributeNone', face: 'pin', params: () => ({ text: PY_FIXTURE }) },
    { method: '$/kode/lint/analyzePostDestroy', face: 'pin', params: () => ({ text: PY_FIXTURE }) },
    { method: '$/kode/lint/analyzePropertyDirection', face: 'pin', params: () => ({ text: PY_FIXTURE }) },
    { method: '$/kode/lint/analyzeReadOnlyWrite', face: 'pin', params: () => ({ text: PY_FIXTURE }) },
    { method: '$/kode/lint/analyzeReceiverNone', face: 'pin', params: () => ({ text: PY_FIXTURE }) },
    { method: '$/kode/lint/analyzeRoleMisuse', face: 'pin', params: () => ({ text: PY_FIXTURE, face: 'baseapp' }) },
    {
      method: '$/kode/lint/analyzeRpcArgCount', face: 'pin',
      params: () => ({ text: PY_FIXTURE, calls: [{ line: PY_LINES.findIndex(l => l.includes('cellReq')), character: 8, methodName: 'cellReq' }] })
    },
    { method: '$/kode/lint/analyzeSpaceNav', face: 'pin', params: () => ({ text: PY_FIXTURE }) },
    { method: '$/kode/lint/analyzeTraps', face: 'pin', params: () => ({ text: PY_FIXTURE }) },
    { method: '$/kode/python/symbols', face: 'pin', params: () => ({ files: [{ path: '/ws/Avatar.py', text: PY_FIXTURE }] }) },
    { method: '$/kode/python/callgraph', face: 'pin', params: () => ({ files: [{ path: '/ws/Avatar.py', text: PY_FIXTURE }], manifestXmlText: '' }) },
    { method: '$/kode/python/selfAttributeFlow', face: 'pin', params: () => ({ lines: PY_LINES, queryLine: 2, attr: 'hp' }) },
    { method: '$/kode/python/returnAnnotations', face: 'pin', params: () => ({ text: PY_FIXTURE }) },
    {
      method: '$/kode/python/localReturnType', face: 'pin',
      params: () => ({ lines: PY_LINES, hoverLine: 6, hoverColumn: 8 })
    },
    {
      method: '$/kode/python/userTypeContract', face: 'pin',
      params: () => ({ file: '/ws/Avatar.py', sources: { Avatar: PY_FIXTURE }, statuses: [{ name: 'onLevelOk' }] })
    },
    {
      method: '$/kode/config/resolve', face: 'pin',
      params: () => ({ defaultsXml: '<root/>', customXml: '<root/>' })
    },
    {
      method: '$/kode/config/derive', face: 'pin',
      params: () => ({ tree: { root: {} }, defaultsTree: { root: {} }, facts: { workspaceRoot: '/ws', customConfigPath: null, entryScripts: [] } })
    },
    {
      method: '$/kode/databaseSchema/build', face: 'pin',
      params: () => ({ entityName: 'Avatar', defFilePath: '/ws/entity_defs/Avatar.def', properties: [], hasCellContent: false, tablePrefix: 'tbl_' })
    },
    {
      method: '$/kode/def/md5', face: 'pin',
      params: () => ({ typesXml: '', entitiesXml: '', defs: {}, aliasXml: '', componentScripts: {} })
    },
    { method: '$/kode/def/format', face: 'pin', params: () => ({ content: DEF_FIXTURE }) },
    {
      method: '$/kode/dependency/graph', face: 'pin',
      params: () => ({
        entitiesXml: '', typesXml: '', defsRoot: '', entitiesXmlPath: '', typesXmlPath: '',
        defs: {}, paths: {}, categories: {}, pythonFiles: {}, typeImpls: {}
      })
    },
    {
      method: '$/kode/messageTable/build', face: 'pin',
      params: () => ({ entityName: 'Avatar', defText: DEF_FIXTURE, typesXml: '', defs: {}, paths: {}, aliasIdEnabled: false })
    },
    {
      method: '$/kode/processTopology/validate', face: 'pin',
      params: () => ({ manifestText: '<root/>', entitiesXmlText: '', defs: [] })
    },
    {
      method: '$/kode/sdk/generate', face: 'pin',
      params: () => ({ language: 'csharp', entities: [], defs: {}, typesXml: '', generatedAt: '2026-11-15T00:00:00Z', engineTrace: false, namespace: 'KbEngine.Client' })
    },
    {
      method: '$/kode/semantics/cellDataKeys', face: 'pin',
      params: () => ({ entity: 'Avatar', defs: [{ name: 'Avatar', text: DEF_FIXTURE }] })
    },
    {
      method: '$/kode/workspace/scanAnchors', face: 'pin',
      params: () => {
        const dir = mkdtempSync(join(tmpdir(), 'kode-scan-anchors-'));
        return { root: dir };
      }
    },
    { method: '$/kode/ruff/lint', face: 'ruff', params: () => ({ files: [] }) },
    { method: '$/kode/ruff/format', face: 'ruff', params: () => ({ content: '', fileName: '/w/a.py' }) },
    // dbClone 家族:输入面复杂(derivation/schema 由 CloneSchema::from_derivation
    // 解析),契约门钉错误信封面;深度往返由 Rust dispatch 测试承载
    { method: '$/kode/dbClone/planExport', face: 'pin', params: () => ({ derivation: {}, physicalTables: [] }) },
    { method: '$/kode/dbClone/planImport', face: 'pin', params: () => ({ path: '/nonexistent.kdpclone', target: {}, derivation: {}, physicalTables: [], snapshot: {} }) },
    { method: '$/kode/dbClone/inspectArchive', face: 'pin', params: () => ({ path: '/nonexistent.kdpclone', keyRoot: undefined }) },
    { method: '$/kode/dbClone/readArchiveRows', face: 'pin', params: () => ({ path: '/nonexistent.kdpclone', keyRoot: undefined }) },
    { method: '$/kode/dbClone/export', face: 'pin', params: () => ({ path: '', entity: '', rows: [], plan: {}, redactSensitive: true, keyRoot: undefined }) }
  ];

  it('方法清单完整:34 方法与 TS 侧调用全集逐一对齐(git 字面量全集)', () => {
    // TS 侧 `$/kode/...` 字面量全集(src/ 下 37 项)减去:信封 rpc、通知
    // fileChanged、health(上文已钉)= 34 请求方法,与本表一一对应。
    expect(probes).toHaveLength(34);
    expect(new Set(probes.map(probe => probe.method)).size).toBe(34);
  });

  it('fileChanged:单向通知跨语言字面量锁(TS KODE_FILE_CHANGED_METHOD = Rust FILE_CHANGED_NOTIFICATION)', () => {
    const rust = /FILE_CHANGED_NOTIFICATION:\s*&str\s*=\s*"([^"]+)"/.exec(
      readFileSync(join(repoRoot, 'crates', 'kode-protocol', 'src', 'lib.rs'), 'utf8')
    );
    expect(rust).not.toBeNull();
    expect(rust?.[1]).toBe(KODE_FILE_CHANGED_METHOD);
  });

  it('逐方法应答形状指纹(错误面钉 -32602 信封)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/contract', capabilities: {} },
      onStderr: () => undefined
    });
    await client.start();
    const shapes: Record<string, unknown> = {};
    const loose: Record<string, unknown> = {};

    for (const probe of probes) {
      const params = probe.params();
      if (probe.face === 'ruff') {
        const result = (await client.request('$/kode/rpc', { method: probe.method, params })) as Record<string, unknown>;
        // ruff 未装时响应只有 {available:false}——version/formatted(可用的)
        // 与 diags(lint 面)键随可用性/方法有无(CI/本机都可能两态),结构面
        // 只钉恒在键;extraKeys 白名单按方法分(lint=diags,format=formatted)
        const allow = probe.method === '$/kode/ruff/lint'
          ? ['available', 'diags', 'version']
          : ['available', 'version', 'formatted'];
        loose[probe.method] = {
          available: typeof result.available,
          ...(probe.method === '$/kode/ruff/lint'
            ? { diags: Array.isArray(result.diags) ? 'array' : typeof result.diags }
            : {}),
          extraKeys: Object.keys(result).filter(k => !allow.includes(k))
        };
        continue;
      }
      try {
        const result = await client.request('$/kode/rpc', { method: probe.method, params });
        shapes[probe.method] = shapeOf(result);
      } catch (error) {
        // 错误面也是契约:INVALID_PARAMS(-32602)信封,message 非空串
        shapes[probe.method] = { __error__: (error as { message: string }).message };
      }
      // scanAnchors 的临时目录用后即清
      const root = params.root;
      if (typeof root === 'string' && root.length > 0) {
        rmSync(root, { recursive: true, force: true });
      }
    }

    if (PROBE) {
      // 探针模式:指纹落盘供人工核对固化(vitest 吞 console.log,坑在案)
      writeFileSync('/tmp/kode-contract-shapes.json', JSON.stringify({ shapes, loose }, null, 2));
      return;
    }

    for (const [method, pinned] of Object.entries(SURFACE_PINS)) {
      expect(shapes[method], `形状漂移: ${method}`).toEqual(pinned);
    }
    expect(Object.keys(shapes).sort()).toEqual(Object.keys(SURFACE_PINS).sort());
    expect(loose['$/kode/ruff/lint']).toEqual({
      available: 'boolean',
      diags: 'array',
      extraKeys: []
    });
    expect(loose['$/kode/ruff/format']).toEqual({
      available: 'boolean',
      extraKeys: []
    });
    await client.dispose();
  }, 120_000);

  /**
   * 钉面:探针产物(2026-11-15,KODE_CONTRACT_PROBE=1 对真实 target/debug
   * kode-server 采集,人工核对后固化)。重生成:KODE_CONTRACT_PROBE=1 跑本
   * 文件,指纹落 /tmp/kode-contract-shapes.json。
   */
  const SURFACE_PINS: Record<string, unknown> = {
    "$/kode/config/derive": {"derive": {"database": {"available": "boolean", "characterSet": "string", "databaseName": "string", "dbType": "string", "encrypt": "boolean", "host": "string", "passwordAvailable": "boolean", "port": "number", "username": "string"}, "debug": {"ready": "boolean", "reasons": ["string"]}, "defScanRoots": {"degraded": "boolean", "fallback": "string", "roots": ["string"]}, "entryScripts": [], "telnet": {"enabled": "boolean", "endpoints": []}}, "diagnostics": [{"message": "string", "scope": "string", "severity": "string"}]},
    "$/kode/config/resolve": {"customTelnet": "null", "customTree": {"children": [{"children": [], "name": "string", "text": "string"}], "name": "string", "text": "string"}, "dbInterface": "null", "defaultsTree": {"children": [{"children": [], "name": "string", "text": "string"}], "name": "string", "text": "string"}, "merged": {"children": [{"children": [], "name": "string", "text": "string"}], "name": "string", "text": "string"}, "telnetDefaultPorts": {"baseapp": "number", "bots": "number", "cellapp": "number", "dbmgr": "number", "interfaces": "number", "logger": "number", "loginapp": "number"}, "telnetSummary": [{"component": "string", "password": "null", "port": "null"}]},
    "$/kode/databaseSchema/build": {"tableIndex": {"tbl_Avatar": {"fields": [{"identifier": "boolean", "indexType": "string", "name": "string", "source": {"category": "string", "filePath": "string", "line": "number", "path": "string"}, "sourcePath": "string", "synthetic": "boolean", "typeLabel": "string"}], "kind": "string", "name": "string", "propertyPath": "string", "source": {"category": "string", "filePath": "string", "line": "number", "path": "string"}, "title": "string"}}, "tables": [{"fields": [{"identifier": "boolean", "indexType": "string", "name": "string", "source": {"category": "string", "filePath": "string", "line": "number", "path": "string"}, "sourcePath": "string", "synthetic": "boolean", "typeLabel": "string"}], "kind": "string", "name": "string", "propertyPath": "string", "source": {"category": "string", "filePath": "string", "line": "number", "path": "string"}, "title": "string"}]},
    "$/kode/dbClone/export": {"__error__": "$/kode/rpc failed (-32602): missing field `entity_name`"},
    "$/kode/dbClone/inspectArchive": {"__error__": "$/kode/rpc failed (-32602): archive error: open archive: No such file or directory (os error 2)"},
    "$/kode/dbClone/planExport": {"__error__": "$/kode/rpc failed (-32602): invalid relation rule: cannot parse kode-server derivation output: missing field `tables` at line 1 column 2"},
    "$/kode/dbClone/planImport": {"__error__": "$/kode/rpc failed (-32602): missing field `uniqueKeys`"},
    "$/kode/dbClone/readArchiveRows": {"__error__": "$/kode/rpc failed (-32602): archive error: open archive: No such file or directory (os error 2)"},
    "$/kode/def/format": {"diagnostics": "number", "edits": [{"end": "number", "start": "number", "text": "string"}]},
    "$/kode/def/md5": {"algorithm": "string", "md5": "string", "streamHex": "string", "trace": [{"bytes": "string", "field": "string", "source": "string"}]},
    "$/kode/dependency/graph": {"edges": [], "nodes": [], "paths": {"defsRoot": "string", "entitiesXml": "string", "typesXml": "string"}, "reverseEdges": {}, "stats": {"componentCount": "number", "defCount": "number", "edgeCount": "number", "entityCount": "number", "interfaceCount": "number", "nodeCount": "number", "pythonCount": "number", "typeCount": "number"}},
    "$/kode/lint/analyzeAttributeNone": {"items": []},
    "$/kode/lint/analyzeDef": {"findings": [{"check": "string", "code": "string", "length": "number", "line": "number", "message": "string", "name": "string", "offset": "number", "range": {"length": "number", "offset": "number"}, "severity": "string"}]},
    "$/kode/lint/analyzePostDestroy": {"items": []},
    "$/kode/lint/analyzePropertyDirection": {"scan": {"accesses": [{"character": "number", "fullPath": "string", "line": "number"}], "cellDataAccesses": [], "initCellDataKeys": [], "initNames": ["string"], "initSites": [{"character": "number", "line": "number", "name": "string"}]}},
    "$/kode/lint/analyzeReadOnlyWrite": {"items": []},
    "$/kode/lint/analyzeReceiverNone": {"items": []},
    "$/kode/lint/analyzeRoleMisuse": {"items": []},
    "$/kode/lint/analyzeRpcArgCount": {"counts": ["null"]},
    "$/kode/lint/analyzeSpaceNav": {"items": []},
    "$/kode/lint/analyzeTraps": {"items": []},
    "$/kode/messageTable/build": {"aliasIdEnabled": "boolean", "clientMethods": [], "clientProperties": [], "fatalCount": "number", "generatedAt": "string", "issues": [{"fatal": "boolean", "kind": "string", "line": "number", "message": "string"}], "loadFailed": "boolean", "methods": [], "module": "string", "properties": [{"aliasID": "null", "declaredUtype": "null", "flags": "string", "hasClient": "boolean", "line": "number", "name": "string", "origin": "string", "originKind": "string", "persistent": "null", "typeName": "null", "utype": "null"}], "sources": [{"filePath": "string", "kind": "string", "name": "string"}], "types": [{"aliasedTo": "null", "kind": "string", "line": "null", "name": "string", "origin": "string", "utype": "number"}]},
    "$/kode/processTopology/validate": {"findings": []},
    "$/kode/python/callgraph": {"dataflow": [{"chains": [{"defLine": "number", "isParam": "boolean", "useLines": [], "var": "string"}], "class": "string", "filePath": "string", "method": "string"}], "edges": [{"callee": "string", "calleeId": "string", "caller": "string", "callerClass": "string", "callerId": "string", "callerLine": "number", "filePath": "string", "kind": "string", "receiver": "string"}], "nodes": [{"className": "string", "filePath": "string", "id": "string", "isAsync": "boolean", "kind": "string", "line": "number", "name": "string", "params": []}], "processRoles": [], "reverseIndex": {}, "stats": {"byKind": {"kbe-api": "number", "kbe-base-clients": "number", "kbe-broadcast": "number", "kbe-cross-process": "number", "local": "number", "method": "number", "self-method": "number", "unknown": "number"}, "dataflowCount": "number", "edgeCount": "number", "errorCount": "number", "fileCount": "number", "nodeCount": "number"}},
    "$/kode/python/localReturnType": {"ret": "null"},
    "$/kode/python/returnAnnotations": {"facts": [{"annotation": "null", "name": "string"}], "imports": {"names": [], "receivers": []}, "localAssignmentCalls": []},
    "$/kode/python/selfAttributeFlow": {"flow": {"annotation": "string", "hasNone": "boolean", "narrowed": "boolean", "types": ["string"]}},
    "$/kode/python/symbols": [{"classes": [{"attributes": [{"character": "number", "line": "number", "name": "string"}], "bases": [], "decorators": [], "endLine": "number", "methods": [{"calls": [], "character": "number", "decorators": [], "endLine": "number", "isAsync": "boolean", "line": "number", "name": "string", "params": []}], "name": "string", "qualifiedName": "string", "startLine": "number"}], "errors": [], "filePath": "string", "functions": [], "imports": [], "lineCount": "number"}],
    "$/kode/python/userTypeContract": {"items": [], "probes": {"Avatar": {"createObjFromDict": "boolean", "getDictFromObj": "boolean", "isSameType": "boolean"}}},
    "$/kode/sdk/generate": [],
    "$/kode/semantics/cellDataKeys": {"entity": "string", "keys": [], "status": "string"},
    "$/kode/workspace/scanAnchors": {"configRoots": [], "entitiesXml": [], "entityDefs": [], "kbeSourceRoots": [], "messagesXml": [], "scanTruncated": "boolean", "scanVisited": "number", "typesXml": []}
  };
});
