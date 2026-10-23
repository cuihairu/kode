import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DiagnosticScheduler,
  isDiagnosticsConfigSection,
  resetDiagnosticSchedulerForTests,
  type DiagnosticLayer
} from '../src/diagnosticScheduler';
import { validateDocument, validateEntitiesXmlDocument } from '../src/languageProviders';
import { releaseAllDocumentSnapshots } from '../src/documentStore';
import {
  getOperationSummary,
  resetLanguageServiceMetrics
} from '../src/languageServiceMetrics';
import {
  configurationOverrides,
  DiagnosticCollection,
  Uri,
  makeTextDocument
} from './helpers/vscodeStub';

// PR6 诊断一致性(A6-1~A6-4):
// - A6-1 诊断任务版本化:连续编辑合并过期任务,只发布匹配当前版本的结果;
// - A6-2 分层与隔离:local/semantic 分层记账;无关文件变更/无关配置变更
//   不重算任何打开文档;同一事件脚本下重算次数 before/after 指标断言;
// - A6-3 entities.xml 诊断入口同版本失效约束:同版本零重分析,版本前进旧槽作废;
// - A6-4 诊断开关配置切换正确清理/重算。

// 带版本的测试文档替身(makeTextDocument 无 version 字段,补挂)
interface VersionedDocument extends ReturnType<typeof makeTextDocument> {
  version: number;
}

const makeVersionedDefDocument = (
  text: string,
  fileName: string,
  version: number
): VersionedDocument => {
  const document = makeTextDocument(text, {
    fileName,
    languageId: 'kbengine-def',
    uri: Uri.file(fileName)
  }) as VersionedDocument;
  document.version = version;
  return document;
};

const makeVersionedEntitiesDocument = (
  text: string,
  fileName: string,
  version: number
): VersionedDocument => {
  const document = makeTextDocument(text, {
    fileName,
    languageId: 'xml',
    uri: Uri.file(fileName)
  }) as VersionedDocument;
  document.version = version;
  return document;
};

const VALID_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE</Flags>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

const BAD_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>NOT_A_KNOWN_TYPE</Type>',
  '      <Flags>NOT_A_KNOWN_FLAG</Flags>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

const DUPLICATE_ENTITIES = [
  '<root>',
  '  <Hero/>',
  '  <Hero/>',
  '</root>'
].join('\n');

beforeEach(() => {
  resetDiagnosticSchedulerForTests();
  resetLanguageServiceMetrics();
  releaseAllDocumentSnapshots();
});

afterEach(() => {
  releaseAllDocumentSnapshots();
});

describe('A6-1 诊断任务版本化:连续编辑合并过期任务', () => {
  it('连续 10 次编辑合并为 1 次计算:只发布匹配当前版本(v10)的结果', () => {
    const scheduler = new DiagnosticScheduler();
    const collection = new DiagnosticCollection();
    const versions: number[] = [];
    let computeCount = 0;
    const document = makeVersionedDefDocument(BAD_DEF, '/burst/hero.def', 1);

    for (let version = 1; version <= 10; version += 1) {
      document.version = version;
      scheduler.requestQueued(document, {
        layer: 'local',
        compute: () => {
          computeCount += 1;
          versions.push(document.version);
          return [{ version: document.version }];
        },
        publish: items => {
          collection.set(document.uri, items as never);
        }
      });
    }
    expect(scheduler.hasQueuedTasks()).toBe(true);
    scheduler.flushQueued();

    const stats = scheduler.getStats();
    expect(stats.requested).toBe(10);
    expect(stats.coalescedStale).toBe(9);
    expect(stats.computed).toBe(1);
    expect(stats.published).toBe(1);
    // 只有最终版本被计算并发布:过期版本从未执行、从未落 collection
    expect(computeCount).toBe(1);
    expect(versions).toEqual([10]);
    expect((collection.get(document.uri) as unknown as Array<{ version: number }>)[0].version).toBe(10);
  });

  it('冲刷前文档已前进:执行时过期任务丢弃,不发布(staleDropped)', () => {
    const scheduler = new DiagnosticScheduler();
    const collection = new DiagnosticCollection();
    const document = makeVersionedDefDocument(BAD_DEF, '/stale/hero.def', 5);

    scheduler.requestQueued(document, {
      layer: 'local',
      compute: () => [{ stale: true }],
      publish: items => collection.set(document.uri, items as never)
    });
    // 排队后文档前进到 v6(下一次编辑先到)
    document.version = 6;
    scheduler.flushQueued();

    const stats = scheduler.getStats();
    expect(stats.computed).toBe(0);
    expect(stats.published).toBe(0);
    expect(stats.staleDropped).toBe(1);
    expect(collection.get(document.uri)).toEqual([]);
  });

  it('立即通道同版本+同代重复请求零重算;invalidateAll 迫使重算', () => {
    const scheduler = new DiagnosticScheduler();
    const document = makeVersionedDefDocument(VALID_DEF, '/skip/hero.def', 3);
    const options = {
      layer: 'local' as DiagnosticLayer,
      compute: () => [{ v: document.version }],
      publish: () => undefined
    };

    scheduler.request(document, options);
    scheduler.request(document, options);
    scheduler.request(document, options);
    let stats = scheduler.getStats();
    expect(stats.computed).toBe(1);
    expect(stats.published).toBe(1);
    expect(stats.skippedCurrentVersion).toBe(2);

    // 诊断输入代变更(子开关/索引失效):同版本也要重算
    scheduler.invalidateAll();
    scheduler.request(document, options);
    stats = scheduler.getStats();
    expect(stats.computed).toBe(2);
    expect(stats.skippedCurrentVersion).toBe(2);
  });

  it('跨文档隔离:A 文档编辑不触发 B 文档任何计算(A6-2 per-URI 键控)', () => {
    const scheduler = new DiagnosticScheduler();
    let computeA = 0;
    let computeB = 0;
    const docA = makeVersionedDefDocument(VALID_DEF, '/iso/a.def', 1);
    const docB = makeVersionedDefDocument(VALID_DEF, '/iso/b.def', 1);
    const optionsFor = (document: VersionedDocument, counter: { n: number }) => ({
      layer: 'local' as DiagnosticLayer,
      compute: () => {
        counter.n += 1;
        return [];
      },
      publish: () => undefined
    });
    const counterA = { n: 0 };
    const counterB = { n: 0 };
    scheduler.request(docA, optionsFor(docA, counterA));
    scheduler.request(docB, optionsFor(docB, counterB));

    // 只编辑 B:A 零重算
    for (let version = 2; version <= 6; version += 1) {
      docB.version = version;
      scheduler.request(docB, optionsFor(docB, counterB));
    }
    expect(counterA.n).toBe(1);
    expect(counterB.n).toBe(6); // B:首次 1 次 + 5 个新版本各 1 次
    expect(computeA).toBe(0);
    expect(computeB).toBe(0);
  });
});

describe('A6-2 分层与指标断言:同一事件脚本重算次数 before/after', () => {
  // 事件脚本(与真实 extension.ts 事件面同构):
  //   开档 A/B/C(.def) → A 连续 10 次编辑 → 无关 .py 文件变更 ×1
  //   → 无关配置变更(kbengine.hover.*)×2 → 诊断配置变更 ×1
  const OPEN_COUNT = 3;
  const EDIT_BURST = 10;
  const UNRELATED_CONFIG_CHANGES = 2;
  const DIAGNOSTICS_CONFIG_CHANGES = 1;
  // 无关事件(无关文件变更 ×1、无关配置变更 ×2)在两个模型中都发生在脚本
  // 中段,不产生任何额外诊断任务(旧 wiring 本就无文档联动;调度器 per-URI
  // 键控天然隔离),期望值推导里以 0 计。

  const makeOpenDocs = (): VersionedDocument[] => [
    makeVersionedDefDocument(VALID_DEF, '/scenario/a.def', 1),
    makeVersionedDefDocument(BAD_DEF, '/scenario/b.def', 1),
    makeVersionedDefDocument(VALID_DEF, '/scenario/c.def', 1)
  ];

  const countWrap = (document: VersionedDocument, counter: { n: number }, collection: DiagnosticCollection) => {
    counter.n += 1;
    validateDocument(document, collection);
  };

  it('before(PR6 前接线模型):任意 kbengine.* 配置变更全量重扫 + 逐键重算', () => {
    // 旧 wiring 字面模型(extension.ts PR6 前):每次 kbengine 配置变更
    // 无差别 forEach 全部打开文档重算;每次编辑直接重算该文档。
    const counter = { n: 0 };
    const collection = new DiagnosticCollection();
    const docs = makeOpenDocs();
    const revalidateAll = () => docs.forEach(doc => countWrap(doc, counter, collection));

    // 开档 ×3
    revalidateAll();
    // A 连续 10 次编辑
    for (let version = 2; version <= 1 + EDIT_BURST; version += 1) {
      docs[0].version = version;
      countWrap(docs[0], counter, collection);
    }
    // 无关文件变更 ×1:旧 wiring 无文档联动(为 0)
    // 无关配置变更 ×2 + 诊断配置变更 ×1:旧 wiring 一律全量重扫
    const totalConfigChanges = UNRELATED_CONFIG_CHANGES + DIAGNOSTICS_CONFIG_CHANGES;
    for (let i = 0; i < totalConfigChanges; i += 1) {
      revalidateAll();
    }

    const legacyRecomputes = counter.n;
    // 3(开档)+ 10(逐键)+ 3×3(每次配置变更全量重扫)
    expect(legacyRecomputes).toBe(OPEN_COUNT + EDIT_BURST + totalConfigChanges * OPEN_COUNT);
    return { legacyRecomputes };
  });

  it('after(PR6 调度器):合并 + 同版本跳过 + 无关事件零重算', () => {
    const scheduler = new DiagnosticScheduler();
    const counter = { n: 0 };
    const collection = new DiagnosticCollection();
    const docs = makeOpenDocs();
    const revalidateAll = () => docs.forEach(doc => scheduler.request(doc, {
      layer: 'local',
      compute: () => {
        counter.n += 1;
        return [];
      },
      publish: () => undefined
    }));

    // 开档 ×3(立即通道,各 1 次)
    revalidateAll();
    // A 连续 10 次编辑:排队合并,冲刷只算最终版本
    for (let version = 2; version <= 1 + EDIT_BURST; version += 1) {
      docs[0].version = version;
      scheduler.requestQueued(docs[0], {
        layer: 'local',
        compute: () => {
          counter.n += 1;
          return [];
        },
        publish: () => undefined
      });
    }
    scheduler.flushQueued();
    // 无关文件变更 ×1 + 无关配置变更 ×2:零诊断任务
    // 诊断配置变更 ×1:invalidateAll + 全量重算(3 文档)
    scheduler.invalidateAll();
    revalidateAll();

    const stats = scheduler.getStats();
    const schedulerRecomputes = stats.computed;
    // 3(开档)+ 1(合并后的编辑)+ 3(诊断配置重算);无关事件零贡献
    expect(schedulerRecomputes).toBe(OPEN_COUNT + 1 + DIAGNOSTICS_CONFIG_CHANGES * OPEN_COUNT);
    expect(stats.coalescedStale).toBe(EDIT_BURST - 1);
    expect(stats.skippedCurrentVersion).toBe(0);
    // 发布次数 = 计算次数:没有过期结果落 collection
    expect(stats.published).toBe(schedulerRecomputes);
    return { schedulerRecomputes };
  });
});

describe('A6-3 entities.xml 诊断入口同版本失效约束', () => {
  it('同版本重复校验命中分析缓存(零重分析),版本前进旧槽作废重分析', () => {
    const document = makeVersionedEntitiesDocument(DUPLICATE_ENTITIES, '/entities/entities.xml', 1);
    const collection = new DiagnosticCollection();

    validateEntitiesXmlDocument(document, collection);
    expect(collection.get(document.uri)).toHaveLength(1);

    // 同版本重复校验:分析结果来自 documentStore 版本槽(document-parse 命中)
    validateEntitiesXmlDocument(document, collection);
    expect(collection.get(document.uri)).toHaveLength(1);
    let summary = getOperationSummary('document-parse');
    expect(summary?.cacheHits).toBe(1);
    expect(summary?.cacheMisses).toBe(1);

    // 版本前进:旧槽作废,重分析且发现仍在(行为一致)
    document.version = 2;
    validateEntitiesXmlDocument(document, collection);
    summary = getOperationSummary('document-parse');
    expect(summary?.cacheHits).toBe(1);
    expect(summary?.cacheMisses).toBe(2);
    expect(collection.get(document.uri)).toHaveLength(1);
  });

  it('版本不可知替身每次现算(与旧行为同价,不引入 staleness)', () => {
    const document = makeTextDocument(DUPLICATE_ENTITIES, {
      fileName: '/legacy/entities.xml',
      languageId: 'xml'
    });
    const collection = new DiagnosticCollection();
    validateEntitiesXmlDocument(document, collection);
    validateEntitiesXmlDocument(document, collection);
    const summary = getOperationSummary('document-parse');
    expect(summary?.cacheMisses).toBe(2);
    expect(summary?.cacheHits).toBe(0);
  });
});

describe('A6-4 诊断开关配置切换:正确清理/重算', () => {
  it('关闭:清空 collection、停算后续请求;重开:迫使已发布文档重算', () => {
    const scheduler = new DiagnosticScheduler();
    const collection = new DiagnosticCollection();
    let clearCount = 0;
    let computeCount = 0;
    const document = makeVersionedDefDocument(BAD_DEF, '/toggle/hero.def', 1);
    const options = {
      layer: 'local' as DiagnosticLayer,
      compute: () => {
        computeCount += 1;
        return [{ msg: `v${document.version}` }];
      },
      publish: items => collection.set(document.uri, items as never)
    };

    scheduler.request(document, options);
    expect(computeCount).toBe(1);

    // 关闭:清空一次,此后请求只记账不计算
    expect(scheduler.setEnabled(false, () => {
      clearCount += 1;
      collection.clear();
    })).toBe(true);
    expect(clearCount).toBe(1);
    expect(collection.get(document.uri)).toEqual([]);
    scheduler.request(document, options);
    expect(computeCount).toBe(1);
    expect(scheduler.getStats().disabledSkipped).toBe(1);

    // 重开:同版本也重算一次(关闭期间发布的标记已作废)
    expect(scheduler.setEnabled(true, () => undefined)).toBe(true);
    scheduler.request(document, options);
    expect(computeCount).toBe(2);
    // 重复开关:无变化返回 false,不误清
    expect(scheduler.setEnabled(true, () => undefined)).toBe(false);
    expect(clearCount).toBe(1);
  });

  it('isDiagnosticsConfigSection 精确裁断:诊断面放行,无关 kbengine.* 拒绝', () => {
    expect(isDiagnosticsConfigSection('kbengine.enableDiagnostics')).toBe(true);
    expect(isDiagnosticsConfigSection('kbengine.enableStructureDiagnostics')).toBe(true);
    expect(isDiagnosticsConfigSection('kbengine.diagnostics')).toBe(true);
    expect(isDiagnosticsConfigSection('kbengine.diagnostics.checkUnknownTypes')).toBe(true);
    expect(isDiagnosticsConfigSection('kbengine.hover.showTagDocs')).toBe(false);
    expect(isDiagnosticsConfigSection('kbengine.jumpLog')).toBe(false);
    expect(isDiagnosticsConfigSection('kbengine.codeLens.rpc')).toBe(false);
    expect(isDiagnosticsConfigSection('kbengine')).toBe(false);
    expect(isDiagnosticsConfigSection('kbengine.diagnosticFoo')).toBe(false);
  });

  it('validateDocument 尊重关闭开关:删除既有诊断(真实配置切换路径)', () => {
    const document = makeVersionedDefDocument(BAD_DEF, '/disabled/hero.def', 1);
    const collection = new DiagnosticCollection();
    validateDocument(document, collection);
    expect(collection.get(document.uri).length).toBeGreaterThan(0);

    // 开关关闭:validateDocument 早退并删除既有诊断(清理路径)
    configurationOverrides.set('kbengine', { enableDiagnostics: false });
    try {
      validateDocument(document, collection);
      expect(collection.get(document.uri)).toEqual([]);
    } finally {
      configurationOverrides.delete('kbengine');
    }
  });
});
