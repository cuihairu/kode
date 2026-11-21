// KSEM-QA-01 人工真值语料闸:TS/Rust parity(golden.json)只证两侧一致,
// 本闸证「与引擎真值一致」。三道门:
// ①schema——每族 grounding 在场/HEAD 格式/条目结构完备/kind 与 load 一致/unknown 必写缺口;
// ②evidence containment——每条 evidence 逐字出现在该族依据档里(伪造锚点即红);
// ③execution——按族分发实测输出钉死(探针取真值后写进语料, drift 即红)。
// 族注册表:
// - def-property-flags → 分析面(defAnalyzer/flagDomains)+ 验证面(validateDocument);
// - cell-data-snapshot → 键面(cellDataWrongKey)+ 时序面(cellDataCallbackCheck)。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { propertyFlagDomainList } from '../src/backend/defAnalyzer';
import { normalizeFlagTokens } from '../src/generated/flagDomains';
import { validateDocument } from '../src/languageProviders';
import { cellDataWrongKeyFindings } from '../src/backend/cellDataWrongKey';
import { trackCellDataKeys, cellDataKeyWorldOpen } from '../src/backend/cellDataKeyTracking';
import { cellDataCallbackFindings } from '../src/backend/cellDataCallbackCheck';
import { cellScriptRoleAndEntity, type CellDataKeyEntry } from '../src/backend/cellDataCompletion';
import { getEntityBuiltinPropertiesForFace } from '../src/backend/entityBuiltinProperties';
import { analyzeTimerCleanupOnDestroy } from '../src/backend/timerCleanupDiagnostics';
import { pythonProcessFromPath, dataDictProcessDomain, dataDictSiteInDomain, processApiSymbols, type PythonProcess } from '../src/backend/pythonProcess';
import { KBENGINE_ENTRY_HOOKS } from '../src/backend/entryHooks';
import { buildRpcLinks } from '../src/backend/flowRpcLinks';
import { resolveFlowCallSites } from '../src/backend/flowCallResolver';
import { analyzeFixedDictMutations } from '../src/backend/fixedDictMutationDiagnostics';
import { analyzeFixedDictConstructWrites } from '../src/backend/fixedDictConstructCheck';
import type { CustomTypeInfo } from '../src/definitionWorkspace';
import { findRoleMisuseFindings } from '../src/backend/roleMisuseDiagnostics';
import { findEventCalls } from '../src/eventApi';
import { findReadOnlyWriteFindings } from '../src/backend/readOnlyWriteDiagnostics';
import { computeRpcArgCountFindings } from '../src/backend/rpcArgCountDiagnostics';
import { EntityMappingManager } from '../src/entityMapping';
import type { EntityMapping } from '../src/entityMapping';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import { ENGINE_SPI_METHODS } from '../src/engineSpiCodeLens';
import { KBENGINE_HOOKS, getHookByName } from '../src/hooks';
import {
  USER_TYPE_CONTRACT_CONSEQUENCE,
  USER_TYPE_CONTRACT_METHODS,
  collectUserTypeContractMissing,
  collectUserTypeContractMissingByImplFile,
  implFileHasContractMethod,
  type UserTypeContractStatus
} from '../src/backend/userTypeContract';
import { collectUserTypeContractStatuses } from '../src/backend/userTypeContractSource';
import { linearizeC3 } from '../src/backend/pythonClassIndex';
import { parsePythonFile } from '../src/backend/pythonParser';
import { findEntityScriptBaseClassFindings } from '../src/backend/entityScriptBaseClassDiagnostics';
import { findProxySessionFindings } from '../src/backend/proxySessionSemanticsDiagnostics';
import { lookupApiDoc } from '../src/backend/pythonApiHoverDocs';
import { computeReceiverNoneFindingsAsync, renderReceiverNoneMessage } from '../src/backend/receiverNoneDiagnostics';
import type { PythonClassDef } from '../src/backend/pythonParser';
import { Diagnostic, DiagnosticCollection, makeTextDocument } from './helpers/vscodeStub';

/** 族间公共信封(input/kode 细节由各族执行闸窄化)。 */
interface TruthEntryBase {
  id: string;
  kind: 'positive' | 'negative' | 'unknown';
  engine: { load: 'accept' | 'reject' | 'reject-silent'; truth: string };
  evidence: string[];
  kode: { status: 'pinned' | 'not-analyzed' | 'unverified' };
  finding?: string;
  reason?: string;
}

interface TruthFamily {
  family: string;
  grounding: { doc: string; engineHead: string };
  entries: Record<string, unknown>[];
}

// ---- 族装载:目录内每个 JSON = 一族 ----
const CORPUS_DIR = path.join(__dirname, 'fixtures', 'truth-corpus');
const families = fs
  .readdirSync(CORPUS_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8')) as TruthFamily);
const groundingTextOf = (family: TruthFamily): string =>
  fs.readFileSync(path.join(__dirname, '..', family.grounding.doc), 'utf8');

const PROJECT = path.join(__dirname, 'fixtures', 'parity-project');

// ---- def-property-flags 族形状与鞍具 ----
interface FlagsEntry extends TruthEntryBase {
  input: { spelling: string; path: 'xml' | 'decorator' };
  kode: TruthEntryBase['kode'] & {
    analysis?: { domains: string[]; tokens: string[] };
    validation?: { diagnostic: 'none' | 'pipe' | 'unknown' };
  };
}
const flagsFamily = families.find(f => f.family === 'def-property-flags')!;
const flagsEntries = flagsFamily.entries as unknown as FlagsEntry[];
const flagsGroundingText = groundingTextOf(flagsFamily);

const validationFlagsDiagnostics = (flags: string): Diagnostic[] => {
  const content = [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    `      <Flags>${flags}</Flags>`,
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n');
  const doc = makeTextDocument(content, {
    fileName: path.join(PROJECT, 'scripts', 'entity_defs', 'FlagProbe.def'),
    languageId: 'kbengine-def'
  });
  const collection = new DiagnosticCollection();
  validateDocument(doc, collection);
  return ((collection.get(doc.uri) as Diagnostic[]) ?? []).filter(d => d.message.includes('Flags'));
};

// ---- cell-data-snapshot 族形状与鞍具 ----
interface CellDataEntry extends TruthEntryBase {
  input: {
    path: 'base-script';
    method: string;
    body: string[];
    universe: { defFields: string[]; builtins: string[] };
  };
  kode: TruthEntryBase['kode'] & {
    validation?: {
      wrongKey: { line: number; key: string; kind: string; candidate: string }[];
      lifecycle: { line: number; character: number; length: number }[];
    };
  };
}
const cellDataFamily = families.find(f => f.family === 'cell-data-snapshot')!;
const cellDataEntries = cellDataFamily.entries as unknown as CellDataEntry[];
const cellDataGroundingText = groundingTextOf(cellDataFamily);

/** 键宇宙按 Rust cellDataKeys 契约形构造(CELL-01 def 字段 + CELL-02 内建封闭表;
 * Rust 侧组合面由 cargo cell 测试钉,此处钉的是消费面在给定宇宙下的行为)。 */
const cellDataUniverseOf = (input: CellDataEntry['input']): CellDataKeyEntry[] => [
  ...input.universe.defFields.map(key => ({
    key,
    kind: 'defField' as const,
    typeLabel: 'UINT8',
    sourceFile: 'Avatar.def',
    sourceLine: 4
  })),
  ...input.universe.builtins.map(key => ({
    key,
    kind: 'builtin' as const,
    typeLabel: 'Vector3Like',
    sourceFile: 'server/baseapp/entity.cpp:250',
    sourceLine: null
  }))
];
const cellDataSnippetOf = (input: CellDataEntry['input']): string =>
  ['class Avatar:', `    def ${input.method}(self):`, ...input.body.map(l => `        ${l}`)].join('\n');

// ---- cell-data-role-face 族形状与鞍具 ----
interface RoleFaceEntry extends TruthEntryBase {
  input: { path: string; roleProbes?: string[]; signature?: string };
  kode: TruthEntryBase['kode'] & {
    validation?: { roleGate: ({ role: string; entity: string } | null)[] };
  };
}
const roleFaceFamily = families.find(f => f.family === 'cell-data-role-face')!;
const roleFaceEntries = roleFaceFamily.entries as unknown as RoleFaceEntry[];

// ---- entity-builtin-props-cellapp 族形状与鞍具 ----
interface BuiltinPropEntry extends TruthEntryBase {
  input: { face: 'cellapp' | 'baseapp' | 'client'; prop?: string; roster?: boolean; absent?: boolean };
  kode: TruthEntryBase['kode'] & {
    analysis?: { name?: string; readonly?: boolean; names?: string[]; absent?: boolean };
  };
}
const builtinPropsFamily = families.find(f => f.family === 'entity-builtin-props-cellapp')!;
const builtinPropsEntries = builtinPropsFamily.entries as unknown as BuiltinPropEntry[];
const builtinPropsBaseappFamily = families.find(f => f.family === 'entity-builtin-props-baseapp')!;
const builtinPropsBaseappEntries = builtinPropsBaseappFamily.entries as unknown as BuiltinPropEntry[];
const builtinPropsClientFamily = families.find(f => f.family === 'entity-builtin-props-client')!;
const builtinPropsClientEntries = builtinPropsClientFamily.entries as unknown as BuiltinPropEntry[];

// ---- entity-timer-cleanup 族形状与鞍具 ----
interface TimerEntry extends TruthEntryBase {
  input: { path: string; method: string; signature?: string; body: string[] };
  kode: TruthEntryBase['kode'] & {
    validation?: { cleanup: { line: number; character: number; length: number }[] };
  };
}
const timerFamily = families.find(f => f.family === 'entity-timer-cleanup')!;
const timerEntries = timerFamily.entries as unknown as TimerEntry[];
const timerSnippetOf = (input: TimerEntry['input']): string =>
  ['class Avatar:', `    def ${input.method}(${input.signature ?? 'self'}):`, ...input.body.map(l => `        ${l}`)].join('\n');

// ---- script-role-path-matrix 族形状与鞍具 ----
interface RolePathEntry extends TruthEntryBase {
  input: { path: string };
  kode: TruthEntryBase['kode'] & {
    analysis?: { role: string | null };
  };
}
const rolePathFamily = families.find(f => f.family === 'script-role-path-matrix')!;
const rolePathEntries = rolePathFamily.entries as unknown as RolePathEntry[];

// ---- entry-script-spi-cellapp 族形状与鞍具 ----
interface EntrySpiEntry extends TruthEntryBase {
  input: { hook?: string; roster?: boolean };
  kode: TruthEntryBase['kode'] & {
    analysis?: { name?: string; signature?: string; names?: string[] };
  };
}
const entrySpiFamily = families.find(f => f.family === 'entry-script-spi-cellapp')!;
const entrySpiEntries = entrySpiFamily.entries as unknown as EntrySpiEntry[];

// ---- rpc-entitycall-links 族形状与鞍具 ----
interface RpcLinkEntry extends TruthEntryBase {
  input: {
    files: Record<string, string>;
    defs: {
      entity: string;
      section: 'BaseMethods' | 'CellMethods' | 'ClientMethods';
      method: string;
      defFile: string;
      line: number;
      declaredArgs?: string[];
      declaredReturnType?: string | null;
    }[];
    impls: {
      entity: string;
      section: 'BaseMethods' | 'CellMethods' | 'ClientMethods';
      method: string;
      filePath: string;
      line: number;
      signature: string;
      className: string;
      inheritedFrom?: string | null;
    }[];
  };
  kode: TruthEntryBase['kode'] & {
    analysis?: {
      link?: {
        sendLine: number;
        sendSyncAsync: string;
        sendEvidenceType: string;
        execSyncAsync: string;
        execMessageKind: string;
        execCallSite: null;
        execEvidenceType: string;
        defFile: string;
        defLine: number;
        defCharacter: number;
        implFilePath: string;
        callerEntity: string;
        declaredArgs: string[];
        declaredReturnType: string | null;
      };
      unresolved?: {
        code: string;
        sendLine: number;
        detailHas: string;
        evidenceHas: string;
        linked: false;
      };
      absentSendLine?: number;
    };
  };
}
const rpcLinkFamily = families.find(f => f.family === 'rpc-entitycall-links')!;
const rpcLinkEntries = rpcLinkFamily.entries as unknown as RpcLinkEntry[];

// ---- data-dictionary-domain 族形状与鞍具 ----
interface DictDomainEntry extends TruthEntryBase {
  input: { dict: string; file?: string };
  kode: TruthEntryBase['kode'] & {
    analysis?: { domain?: string[] | null; inDomain?: boolean };
  };
}
const dictDomainFamily = families.find(f => f.family === 'data-dictionary-domain')!;
const dictDomainEntries = dictDomainFamily.entries as unknown as DictDomainEntry[];

// ---- process-module-surface 族形状与鞍具 ----
interface ProcSurfaceEntry extends TruthEntryBase {
  input: { process: string; symbol?: string };
  kode: TruthEntryBase['kode'] & {
    analysis?: { present?: boolean | string[]; absent?: string[] };
  };
}
const procSurfaceFamily = families.find(f => f.family === 'process-module-surface')!;
const procSurfaceEntries = procSurfaceFamily.entries as unknown as ProcSurfaceEntry[];
const procSymbolNames = (process: string) => processApiSymbols(process as PythonProcess).map(s => s.name);

// ---- fixed-dict-sync-trap 族形状与鞍具 ----
interface FdSyncEntry extends TruthEntryBase {
  input: { fixedDictProperties: Record<string, string[]>; code: string };
  kode: TruthEntryBase['kode'] & {
    analysis?: {
      mutations: { line: number; character: number; length: number; property: string; key: string; kind: 'attr' | 'subscript' }[];
    };
  };
}
const fdSyncFamily = families.find(f => f.family === 'fixed-dict-sync-trap')!;
const fdSyncEntries = fdSyncFamily.entries as unknown as FdSyncEntry[];

// ---- builtin-prop-role-misuse 族形状与鞍具 ----
interface RoleMisuseEntry extends TruthEntryBase {
  input: { code: string; pathFace: 'baseapp' | 'cellapp' | 'client' | null; defFaces: string[] | null };
  kode: TruthEntryBase['kode'] & {
    analysis?: {
      findings: { line: number; character: number; length: number; propertyName: string; currentFace: string; registeredFaces: string[] }[];
    };
  };
}
const roleMisuseFamily = families.find(f => f.family === 'builtin-prop-role-misuse')!;
const roleMisuseEntries = roleMisuseFamily.entries as unknown as RoleMisuseEntry[];

// ---- entity-event-pubsub 族形状与鞍具 ----
interface EventPubsubEntry extends TruthEntryBase {
  input: { source: string };
  kode: TruthEntryBase['kode'] & {
    analysis?: { calls: { api: string; event: string; eventOffset: number; callback?: string; callbackOffset?: number }[] };
  };
}
const eventPubsubFamily = families.find(f => f.family === 'entity-event-pubsub')!;
const eventPubsubEntries = eventPubsubFamily.entries as unknown as EventPubsubEntry[];

// ---- entity-readonly-write-{cellapp,baseapp,client} 族形状与鞍具(三脸同构) ----
interface ReadOnlyWriteEntry extends TruthEntryBase {
  input: { code: string; pathFace: 'baseapp' | 'cellapp' | 'client' | null; defFaces: string[] | null };
  kode: TruthEntryBase['kode'] & {
    analysis?: { findings: { line: number; character: number; length: number; propertyName: string; kind: string; face: string }[] };
  };
}
const readOnlyWriteFamilies = ['entity-readonly-write-cellapp', 'entity-readonly-write-baseapp', 'entity-readonly-write-client']
  .map(name => families.find(f => f.family === name)!);
const readOnlyWriteEntries = readOnlyWriteFamilies.flatMap(f => f.entries as unknown as ReadOnlyWriteEntry[]);

// ---- entry-script-spi-roster 族形状与鞍具 ----
interface SpiRosterEntry extends TruthEntryBase {
  input: { component?: string; optionalRoster?: boolean };
  kode: TruthEntryBase['kode'] & {
    analysis?: { names?: string[]; optionalNames?: string[] };
  };
}
const spiRosterFamily = families.find(f => f.family === 'entry-script-spi-roster')!;
const spiRosterEntries = spiRosterFamily.entries as unknown as SpiRosterEntry[];

// ---- rpc-arg-count 族形状与鞍具 ----
interface RpcArgCountEntry extends TruthEntryBase {
  input: {
    source: string;
    methods: Record<string, { section: 'BaseMethods' | 'CellMethods' | 'ClientMethods'; declaredArgs?: string[] }[]>;
    callerFace?: 'base' | 'cell' | 'client';
  };
  kode: TruthEntryBase['kode'] & {
    analysis?: { findings: { line: number; character: number; methodName: string; receiver: string; declaredCount: number; actualCount: number }[] };
  };
}
const rpcArgCountFamily = families.find(f => f.family === 'rpc-arg-count')!;
/** 薄切片臂(methods 手喂)与全量映射臂(def 经真管理器实扫)分流;两形状互斥。 */
const rpcArgCountEntries = (rpcArgCountFamily.entries as unknown as RpcArgCountEntry[])
  .filter(entry => (entry.input as { methods?: unknown }).methods !== undefined);
/** 全量映射臂(第二十七增量):input 携 def 原文,映射不经手喂薄切片。 */
interface RpcArgCountFullMappingEntry extends TruthEntryBase {
  input: { def: string[]; source: string };
  kode: TruthEntryBase['kode'] & {
    analysis?: { findings: { line: number; character: number; methodName: string; receiver: string; declaredCount: number; actualCount: number }[] };
  };
}
const rpcArgCountFullMappingEntries = rpcArgCountFamily.entries.filter(
  (entry): entry is RpcArgCountFullMappingEntry => Array.isArray((entry.input as { def?: unknown }).def)
);
const hookSigFamily = families.find(f => f.family === 'writetodb-hook-signature')!;
/** 条目 methods 薄切片 → EntityMapping 快照(identity 薄桩;mapping 生产装配不属本族钉域)。 */
const rpcArgCountMappingOf = (entry: RpcArgCountEntry): EntityMapping =>
  ({
    name: 'Avatar',
    defFile: 'scripts/entity_defs/Avatar.def',
    pythonFile: 'scripts/entity/Avatar.py',
    pythonFiles: ['scripts/entity/Avatar.py'],
    properties: {},
    methods: Object.fromEntries(
      Object.entries(entry.input.methods).map(([name, decls]) => [
        name,
        decls.map(decl => ({
          defFile: 'scripts/entity_defs/Avatar.def',
          line: 3,
          section: decl.section,
          exposed: true,
          identity: {
            ownerKind: 'entity',
            ownerName: 'Avatar',
            sourceKind: 'local',
            sourceChain: [],
            section: decl.section,
            symbolName: name
          },
          declaredArgs: decl.declaredArgs,
          declaredReturnType: null
        }))
      ])
    )
  }) as EntityMapping;
/** 发送边走真解析(resolveFlowCallSites),def/impl 注册表来自条目自身。 */
const rpcLinksOf = (entry: RpcLinkEntry) =>
  buildRpcLinks({
    rootKey: '/ws',
    files: Object.keys(entry.input.files),
    resolveFile: filePath => {
      const text = entry.input.files[filePath];
      return text === undefined ? null : resolveFlowCallSites({ text, filePath, rootKey: '/ws' });
    },
    resolveDefMethod: (entity, section, methodName) =>
      entry.input.defs.find(d => d.entity === entity && d.section === section && d.method === methodName) ?? null,
    resolveImplementation: (entity, section, methodName) =>
      entry.input.impls.find(d => d.entity === entity && d.section === section && d.method === methodName) ?? null
  });

// ---- ① schema 门(全族) ----
describe('真值语料 schema 门(KSEM-QA-01)', () => {
  it('每族 grounding 依据档真实存在且带引擎 HEAD', () => {
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) {
      const docPath = path.join(__dirname, '..', family.grounding.doc);
      expect(fs.existsSync(docPath), family.grounding.doc).toBe(true);
      expect(family.grounding.engineHead).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  it('全族条目结构完备:id 唯一/kind 合法且与 engine.load 一致/unknown 必有 reason', () => {
    for (const family of families) {
      expect(family.entries.length).toBeGreaterThan(0);
      const ids = family.entries.map(e => (e as TruthEntryBase).id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const raw of family.entries) {
        const entry = raw as TruthEntryBase;
        expect(['positive', 'negative', 'unknown']).toContain(entry.kind);
        expect(['accept', 'reject', 'reject-silent']).toContain(entry.engine.load);
        expect(['pinned', 'not-analyzed', 'unverified']).toContain(entry.kode.status);
        if (entry.kind === 'positive') {
          expect(entry.engine.load).toBe('accept');
        }
        if (entry.kind === 'negative') {
          expect(['reject', 'reject-silent']).toContain(entry.engine.load);
        }
        if (entry.kind === 'unknown') {
          // 未知例必须写明缺口与下一步(诚实,不用推测填)
          expect(entry.reason?.length ?? 0).toBeGreaterThan(0);
        }
        expect(entry.engine.truth.length).toBeGreaterThan(0);
      }
    }
  });

  it('evidence containment:每条依据逐字出现在该族依据档(伪造锚点即红)', () => {
    for (const family of families) {
      const docText = groundingTextOf(family);
      for (const raw of family.entries) {
        const entry = raw as TruthEntryBase;
        expect(entry.evidence.length).toBeGreaterThan(0);
        for (const fragment of entry.evidence) {
          expect(docText.includes(fragment)).toBe(
            true,
            `evidence 不在 ${family.grounding.doc}: ${JSON.stringify(fragment)} (entry ${entry.id})`
          );
        }
      }
    }
  });
});

// ---- ② def-property-flags 执行门 ----
describe('真值语料 execution 门:def-flags 分析面(defAnalyzer/flagDomains 生成镜像)', () => {
  const pinnedXml = flagsEntries.filter(
    e => e.kode.status === 'pinned' && e.input.path === 'xml'
  );

  it('每条 pinned xml 条目的域位与词元实测等于语料钉值(drift 即红)', () => {
    expect(pinnedXml.length).toBeGreaterThan(0);
    for (const entry of pinnedXml) {
      expect(propertyFlagDomainList(entry.input.spelling)).toEqual(
        entry.kode.analysis?.domains,
        `analysis domains drift: ${entry.id}`
      );
      expect(normalizeFlagTokens(entry.input.spelling)).toEqual(
        entry.kode.analysis?.tokens,
        `normalizeFlagTokens drift: ${entry.id}`
      );
    }
  });
});

describe('真值语料 execution 门:def-flags 验证面(语言侧实时诊断)', () => {
  const pinnedXml = flagsEntries.filter(
    e => e.kode.status === 'pinned' && e.input.path === 'xml'
  );

  it('诊断面按语料钉值出/不出(pipe 组合/未知拼写/静默三类)', () => {
    for (const entry of pinnedXml) {
      const diags = validationFlagsDiagnostics(entry.input.spelling);
      const wanted = entry.kode.validation?.diagnostic ?? 'none';
      if (wanted === 'none') {
        expect(diags, `validation 应静默: ${entry.id}`).toEqual([]);
      } else if (wanted === 'pipe') {
        expect(diags.some(d => d.message.includes("不支持 '|' 组合形态"))).toBe(true);
      } else {
        expect(diags.some(d => d.message.includes('未知的 KBEngine Flags 值'))).toBe(true);
      }
    }
  });
});

// ---- ③ cell-data-snapshot 执行门 ----
describe('真值语料 execution 门:cell-data 键面+时序面(封闭世界双面)', () => {
  const pinned = cellDataEntries.filter(e => e.kode.status === 'pinned');

  it('每条 pinned 条目的 wrongKey/lifecycle 实测等于语料钉值(drift 即红)', () => {
    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      const snippet = cellDataSnippetOf(entry.input);
      const universe = cellDataUniverseOf(entry.input);
      const worldOpen = cellDataKeyWorldOpen(snippet);
      expect(worldOpen, `worldOpen: ${entry.id}`).toBe(false);
      const facts = trackCellDataKeys(snippet, universe);
      const wrongKey = cellDataWrongKeyFindings(facts, universe, worldOpen).map(f => ({
        line: f.line,
        key: f.key,
        kind: f.kind,
        candidate: f.candidate
      }));
      const lifecycle = cellDataCallbackFindings(snippet).map(f => ({
        line: f.line,
        character: f.character,
        length: f.length
      }));
      expect(wrongKey, `wrongKey drift: ${entry.id}`).toEqual(entry.kode.validation?.wrongKey ?? []);
      expect(lifecycle, `lifecycle drift: ${entry.id}`).toEqual(
        entry.kode.validation?.lifecycle ?? []
      );
    }
  });
});

// ---- ④ cell-data-role-face 执行门 ----
describe('真值语料 execution 门:cell-data 角色闸接管矩阵(KR-AUD-74 布局)', () => {
  const pinned = roleFaceEntries.filter(
    e => e.kode.status === 'pinned' && (e.input.roleProbes?.length ?? 0) > 0
  );

  it('每条 pinned 条目的角色闸实测等于语料钉值(drift 即红)', () => {
    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      const actual = entry.input.roleProbes!.map(p => cellScriptRoleAndEntity(p));
      expect(actual, `roleGate drift: ${entry.id}`).toEqual(entry.kode.validation?.roleGate);
    }
  });
});

// ---- ⑤ entity-builtin-props-cellapp/baseapp 执行门(逐项对账+roster 完备性) ----
describe('真值语料 execution 门:内建属性面逐项对账(cellapp §6 / baseapp §1 注册表 / client §4.3)', () => {
  const all = [...builtinPropsEntries, ...builtinPropsBaseappEntries, ...builtinPropsClientEntries];

  it('每条 pinned 单属性条目的名字+读写性实测等于语料钉值(drift 即红)', () => {
    const single = all.filter(e => e.kode.status === 'pinned' && e.input.prop && !e.input.absent);
    expect(single.length).toBeGreaterThan(0);
    for (const entry of single) {
      const table = getEntityBuiltinPropertiesForFace(entry.input.face);
      const hit = table.find(p => p.name === entry.input.prop);
      expect(hit, `属性缺席 ${entry.input.face} 面: ${entry.id} (${entry.input.prop})`).toBeDefined();
      expect(hit!.readonly, `readonly drift: ${entry.id}`).toBe(entry.kode.analysis?.readonly);
    }
  });

  it('缺席条目:fork 未注册脚本 getset 的属性不得出现在面上(混入即红)', () => {
    const absent = all.filter(e => e.kode.status === 'pinned' && e.input.absent && e.input.prop);
    expect(absent.length).toBeGreaterThan(0);
    for (const entry of absent) {
      const table = getEntityBuiltinPropertiesForFace(entry.input.face);
      expect(table.find(p => p.name === entry.input.prop), `应缺席: ${entry.id} (${entry.input.prop})`).toBeUndefined();
    }
  });

  it('roster 完备性条目:面名单逐项等于语料钉值(多出/缺席/改序即红)', () => {
    for (const entries of [builtinPropsEntries, builtinPropsBaseappEntries, builtinPropsClientEntries]) {
      const rosterEntry = entries.find(e => e.input.roster);
      expect(rosterEntry).toBeDefined();
      const table = getEntityBuiltinPropertiesForFace(rosterEntry!.input.face);
      expect(table.map(p => p.name), `roster drift: ${rosterEntry!.id}`).toEqual(
        rosterEntry!.kode.analysis?.names
      );
    }
  });
});

// ---- ⑥ entity-timer-cleanup 执行门 ----
describe('真值语料 execution 门:定时器清理面(KBE-PY-017 冗余/合法双向)', () => {
  const pinned = timerEntries.filter(e => e.kode.status === 'pinned');

  it('每条 pinned 条目的 cleanup findings 实测等于语料钉值(drift 即红)', () => {
    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      const findings = analyzeTimerCleanupOnDestroy(timerSnippetOf(entry.input)).map(f => ({
        line: f.line,
        character: f.character,
        length: f.length
      }));
      expect(findings, `cleanup drift: ${entry.id}`).toEqual(entry.kode.validation?.cleanup ?? []);
    }
  });
});

// ---- ⑦ script-role-path-matrix 执行门 ----
describe('真值语料 execution 门:脚本角色路径矩阵(引擎目录清单 vs kode 别名面)', () => {
  const pinned = rolePathEntries.filter(e => e.kode.status === 'pinned');

  it('每条 pinned 条目的角色判定实测等于语料钉值(含 null 缺席臂,drift 即红)', () => {
    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      expect(pythonProcessFromPath(entry.input.path), `role drift: ${entry.id}`).toBe(
        entry.kode.analysis?.role ?? null
      );
    }
  });
});

// ---- ⑧ entry-script-spi-cellapp 执行门 ----
describe('真值语料 execution 门:入口 SPI 面(cellapp 三件套 roster+签名)', () => {
  const pinned = entrySpiEntries.filter(e => e.kode.status === 'pinned');
  const hooksOf = (name: string) => KBENGINE_ENTRY_HOOKS.find(h => h.name === name && h.component === 'cellapp');

  it('每条 pinned 单钩条目的名字+签名实测等于语料钉值(drift 即红)', () => {
    const singles = pinned.filter(e => e.input.hook);
    expect(singles.length).toBeGreaterThan(0);
    for (const entry of singles) {
      const hook = hooksOf(entry.input.hook!);
      expect(hook, `钩子缺席: ${entry.id} (${entry.input.hook})`).toBeDefined();
      expect(hook!.signature, `signature drift: ${entry.id}`).toBe(entry.kode.analysis?.signature);
    }
  });

  it('roster 条目:cellapp 收录名单实测等于语料钉值(SP-1 范围漂移即红)', () => {
    const roster = pinned.find(e => e.input.roster);
    expect(roster).toBeDefined();
    const names = KBENGINE_ENTRY_HOOKS.filter(h => h.component === 'cellapp').map(h => h.name);
    expect(names, `spi roster drift: ${roster!.id}`).toEqual(roster!.kode.analysis?.names);
  });
});

// ---- ⑨ rpc-entitycall-links 执行门 ----
describe('真值语料 execution 门:EntityCall 跨进程连接面(两段建模/def 闸/诚实落点)', () => {
  const pinned = rpcLinkEntries.filter(e => e.kode.status === 'pinned');

  it('连线臂:def 已声明+实现在场=两段装配逐标量钉(发送 async-send/执行 sync-rpc)', () => {
    const entries = pinned.filter(e => e.kode.analysis?.link);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const a = entry.kode.analysis!.link!;
      const link = rpcLinksOf(entry).links.find(l => l.sendEdge.callSite?.line === a.sendLine);
      expect(link, `link 缺席: ${entry.id}`).toBeDefined();
      expect(link!.sendEdge.syncAsync, `sendSyncAsync drift: ${entry.id}`).toBe(a.sendSyncAsync);
      expect(link!.sendEdge.evidence.type, `sendEvidence drift: ${entry.id}`).toBe(a.sendEvidenceType);
      expect(link!.execEdge.syncAsync, `execSyncAsync drift: ${entry.id}`).toBe(a.execSyncAsync);
      expect(link!.execEdge.messageKind, `execMessageKind drift: ${entry.id}`).toBe(a.execMessageKind);
      expect(link!.execEdge.callSite, `execCallSite drift: ${entry.id}`).toBeNull();
      expect(link!.execEdge.evidence.type, `execEvidence drift: ${entry.id}`).toBe(a.execEvidenceType);
      expect(link!.rpcNode.declaration?.file, `defFile drift: ${entry.id}`).toBe(a.defFile);
      expect(link!.rpcNode.declaration?.line, `defLine drift: ${entry.id}`).toBe(a.defLine);
      expect(link!.rpcNode.declaration?.character, `defCharacter drift: ${entry.id}`).toBe(a.defCharacter);
      expect(link!.implNode.fn?.filePath, `implFilePath drift: ${entry.id}`).toBe(a.implFilePath);
      expect(link!.callerEntity, `callerEntity drift: ${entry.id}`).toBe(a.callerEntity);
      expect(link!.declaredArgs, `declaredArgs drift: ${entry.id}`).toEqual(a.declaredArgs);
      expect(link!.declaredReturnType, `declaredReturnType drift: ${entry.id}`).toBe(a.declaredReturnType);
    }
  });

  it('未解析臂:def 闸双臂+引擎引用发送(原因码/证据串钉,有发送无连线)', () => {
    const entries = pinned.filter(e => e.kode.analysis?.unresolved);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const a = entry.kode.analysis!.unresolved!;
      const result = rpcLinksOf(entry);
      const record = result.unresolvedLinks.find(
        u => u.code === a.code && u.sendEdge.callSite?.line === a.sendLine
      );
      expect(record, `unresolved 缺席: ${entry.id}`).toBeDefined();
      expect(record!.detail.includes(a.detailHas), `detail drift: ${entry.id}`).toBe(true);
      expect(
        record!.execUnresolvedEdge.evidence.detail.includes(a.evidenceHas),
        `evidence drift: ${entry.id}`
      ).toBe(true);
      if (!a.linked) {
        expect(
          result.links.find(l => l.sendEdge.callSite?.line === a.sendLine),
          `不应连线: ${entry.id}`
        ).toBeUndefined();
      }
    }
  });

  it('缺席臂:face-invalid/广播发送不得出现在链接面(混入即红)', () => {
    const entries = pinned.filter(e => e.kode.analysis?.absentSendLine != null);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const line = entry.kode.analysis!.absentSendLine!;
      const result = rpcLinksOf(entry);
      const all = [...result.links.map(l => l.sendEdge), ...result.unresolvedLinks.map(u => u.sendEdge)];
      expect(all.find(edge => edge.callSite?.line === line), `应缺席: ${entry.id} (line ${line})`).toBeUndefined();
    }
  });
});

// ---- ⑩ data-dictionary-domain 执行门 ----
describe('真值语料 execution 门:数据字典进程域(域化双函数直钉)', () => {
  const pinned = dictDomainEntries.filter(e => e.kode.status === 'pinned');

  it('字典域臂:四字典的进程域实测等于语料钉值(null=全进程不收窄)', () => {
    const entries = pinned.filter(e => !e.input.file);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const domain = dataDictProcessDomain(entry.input.dict);
      const actual = domain ? [...domain] : null;
      expect(actual, `dict domain drift: ${entry.id}`).toEqual(entry.kode.analysis?.domain ?? null);
    }
  });

  it('进程域臂:域内真/域外假/角色不可知诚实不判(漂移即红)', () => {
    const entries = pinned.filter(e => e.input.file);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(dataDictSiteInDomain(entry.input.file!, entry.input.dict), `site drift: ${entry.id}`).toBe(
        entry.kode.analysis?.inDomain
      );
    }
  });
});

// ---- ⑪ process-module-surface 执行门 ----
describe('真值语料 execution 门:进程模块面(共享清单/单符号/divergence 现状钉)', () => {
  const pinned = procSurfaceEntries.filter(e => e.kode.status === 'pinned');

  it('单符号臂:presence 实测等于语料钉值(cell address 条目钉住 divergence 现状)', () => {
    const entries = pinned.filter(e => e.input.symbol && typeof e.kode.analysis?.present === 'boolean');
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const hit = procSymbolNames(entry.input.process).includes(entry.input.symbol);
      expect(hit, `symbol presence drift: ${entry.id}`).toBe(entry.kode.analysis!.present);
    }
  });

  it('在场清单臂:名单逐名实测在场(缺一即红)', () => {
    const entries = pinned.filter(e => Array.isArray(e.kode.analysis?.present));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const names = procSymbolNames(entry.input.process);
      const wanted = entry.kode.analysis!.present as string[];
      for (const sym of wanted) {
        expect(names.includes(sym), `在场清单缺名 ${sym}: ${entry.id}`).toBe(true);
      }
    }
  });

  it('缺席清单臂:名单逐名实测不在场(混入即红)', () => {
    const entries = pinned.filter(e => (e.kode.analysis?.absent?.length ?? 0) > 0);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const names = procSymbolNames(entry.input.process);
      for (const sym of entry.kode.analysis!.absent!) {
        expect(names.includes(sym), `缺席清单混入 ${sym}: ${entry.id}`).toBe(false);
      }
    }
  });
});

// ---- ⑫ fixed-dict-sync-trap 执行门 ----
describe('真值语料 execution 门:FIXED_DICT 子键同步陷阱(四形态报/三形态沉默)', () => {
  const pinned = fdSyncEntries.filter(e => e.kode.status === 'pinned');

  it('每条条目的 mutation findings 实测等于语料钉值(陷阱报/正确姿势沉默,drift 即红)', () => {
    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      const props = new Map(Object.entries(entry.input.fixedDictProperties).map(([k, v]) => [k, v]));
      const findings = analyzeFixedDictMutations(entry.input.code, props).map(f => ({
        line: f.line,
        character: f.character,
        length: f.length,
        property: f.property,
        key: f.key,
        kind: f.kind
      }));
      expect(findings, `fd sync drift: ${entry.id}`).toEqual(entry.kode.analysis?.mutations ?? []);
    }
  });
});

// ---- ⑬ builtin-prop-role-misuse 执行门 ----
describe('真值语料 execution 门:内建属性角色错用面(错面报/正确与不明沉默)', () => {
  const pinned = roleMisuseEntries.filter(e => e.kode.status === 'pinned');

  it('每条条目的错用 findings 实测等于语料钉值(含 registeredFaces 引证,drift 即红)', () => {
    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      const findings = findRoleMisuseFindings(
        entry.input.code,
        entry.input.pathFace,
        entry.input.defFaces as unknown as Parameters<typeof findRoleMisuseFindings>[2]
      ).map(f => ({
        line: f.line,
        character: f.character,
        length: f.length,
        propertyName: f.propertyName,
        currentFace: f.currentFace,
        registeredFaces: [...f.registeredFaces]
      }));
      expect(findings, `role misuse drift: ${entry.id}`).toEqual(entry.kode.analysis?.findings ?? []);
    }
  });
});

// ---- ⑮ entity-event-pubsub 执行门 ----
describe('真值语料 execution 门:事件面(findEventCalls 识别表直钉)', () => {
  const pinned = eventPubsubEntries.filter(e => e.kode.status === 'pinned');

  it('每条条目的 EventCall 实测等于语料钉值(逐标量含 offset,drift 即红)', () => {
    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      const calls = findEventCalls(entry.input.source).map(c => ({
        api: c.api,
        event: c.event,
        eventOffset: c.eventOffset,
        callback: c.callback,
        callbackOffset: c.callbackOffset
      }));
      expect(calls, `event drift: ${entry.id}`).toEqual(entry.kode.analysis?.calls ?? []);
    }
  });

  it('fireEvent 缺席臂:引擎真实发送名在 kode 输出中零命中(漏检分歧钉现状)', () => {
    const missed = eventPubsubEntries.find(e => e.id === 'event-emit-fireEvent-missed');
    expect(missed?.kode.analysis?.calls).toEqual([]);
    expect(findEventCalls(missed!.input.source)).toEqual([]);
  });
});

// ---- ⑯ entity-readonly-write-cellapp 执行门 ----
describe('真值语料 execution 门:内建属性只读写面(findReadOnlyWriteFindings 直钉)', () => {
  const pinned = readOnlyWriteEntries.filter(e => e.kode.status === 'pinned');

  it('每条条目的只读写 findings 实测等于语料钉值(逐标量含 span/kind/face,drift 即红)', () => {
    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      const findings = findReadOnlyWriteFindings(
        entry.input.code,
        entry.input.pathFace,
        entry.input.defFaces as unknown as Parameters<typeof findReadOnlyWriteFindings>[2]
      ).map(f => ({
        line: f.line,
        character: f.character,
        length: f.length,
        propertyName: f.propertyName,
        kind: f.kind,
        face: f.face
      }));
      expect(findings, `readonly write drift: ${entry.id}`).toEqual(entry.kode.analysis?.findings ?? []);
    }
  });

  it('非实体脸沉默臂:四个负臂同文本 pathFace=null 全沉默(无实体身份不判)', () => {
    for (const entry of pinned.filter(e => e.kind === 'negative')) {
      const findings = findReadOnlyWriteFindings(entry.input.code, null, null);
      expect(findings, `null face drift: ${entry.id}`).toEqual([]);
    }
  });
});

// ---- ⑲ entry-script-spi-roster 执行门 ----
describe('真值语料 execution 门:入口 SPI 全组件名册(ENGINE_SPI_METHODS 对档表)', () => {
  const pinned = spiRosterEntries.filter(e => e.kode.status === 'pinned');

  it('每组件名册+可选旗实测等于语料钉值(缺一多一即红)', () => {
    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      if (entry.input.component) {
        const roster = Object.entries(ENGINE_SPI_METHODS)
          .filter(([, m]) => m.components.includes(entry.input.component!))
          .map(([n]) => n).sort();
        const optional = Object.entries(ENGINE_SPI_METHODS)
          .filter(([, m]) => m.components.includes(entry.input.component!) && !m.required)
          .map(([n]) => n).sort();
        expect(roster, `spi roster drift: ${entry.id}`).toEqual(entry.kode.analysis?.names ?? []);
        expect(optional, `spi optional drift: ${entry.id}`).toEqual(entry.kode.analysis?.optionalNames ?? []);
      } else if (entry.input.optionalRoster) {
        const all = Object.entries(ENGINE_SPI_METHODS).filter(([, m]) => !m.required).map(([n]) => n).sort();
        expect(all, `spi optional-four drift: ${entry.id}`).toEqual(entry.kode.analysis?.names ?? []);
        expect(all.length).toBe(4);
      }
    }
  });
});

// ---- ⑳ rpc-arg-count 执行门 ----
describe('真值语料 execution 门:RPC 实参数对账面(computeRpcArgCountFindings 直钉)', () => {
  it('十三臂逐标量钉:mismatch 三报/沉默十臂全 silent', () => {
    expect(rpcArgCountEntries.length).toBe(13);
    for (const entry of rpcArgCountEntries) {
      const findings = computeRpcArgCountFindings(
        entry.input.source,
        rpcArgCountMappingOf(entry),
        entry.input.callerFace
      );
      const actual = findings.map(f => ({
        line: f.line,
        character: f.character,
        methodName: f.methodName,
        receiver: f.receiver,
        declaredCount: f.declaredCount,
        actualCount: f.actualCount
      }));
      expect(actual, `rpc arg count drift: ${entry.id}`).toEqual(entry.kode.analysis?.findings ?? []);
    }
  });
});

// ---- ⑳b rpc-arg-count 全量映射臂(第二十七增量,2026-11-18) ----
// undeclared 真反例解封:映射不经手写薄切片,由 EntityMappingManager 实扫
// mkdtemp 工作区真 Avatar.def 产出(definitionSemantics→collectMethodDefinitions
// 生产线);双臂=控制臂(真映射下 mismatch 照报,证 fixture 活)+真反例臂
// (def 真未声明方法零警告=漏报向分歧登记,只钉现状不冒充修复)。
describe('真值语料 execution 门:RPC 实参数对账面全量映射臂(mkdtemp 真管理器)', () => {
  const originalFolders = stubWorkspace.workspaceFolders;
  const originalFindFiles = stubWorkspace.findFiles;
  const rpcFullMappingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-rpc-fullmap-'));
  let manager: EntityMappingManager | undefined;
  let fullMapping: EntityMapping | undefined;

  beforeAll(() => {
    fs.mkdirSync(path.join(rpcFullMappingRoot, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(
      path.join(rpcFullMappingRoot, 'scripts', 'entity_defs', 'Avatar.def'),
      rpcArgCountFullMappingEntries[0]!.input.def.join('\n') + '\n'
    );
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(rpcFullMappingRoot), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = async () => [
      Uri.file(path.join(rpcFullMappingRoot, 'scripts', 'entity_defs', 'Avatar.def'))
    ];
    manager = new EntityMappingManager({ subscriptions: [] });
  });
  afterAll(() => {
    manager?.dispose();
    stubWorkspace.workspaceFolders = originalFolders;
    stubWorkspace.findFiles = originalFindFiles;
    fs.rmSync(rpcFullMappingRoot, { recursive: true, force: true });
  });

  it('真管理器实扫产出 Avatar 全量映射(def 成员闸=真解析)', async () => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (manager!.getAllMappings().length > 0) { break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const mapping = manager!.getAllMappings().find(m => m.name === 'Avatar');
    expect(mapping, 'manager scan should produce Avatar mapping').toBeDefined();
    expect(Object.keys(mapping!.methods)).toEqual(['doMove']);
    expect(mapping!.methods.doMove![0]!.declaredArgs).toEqual(['UINT8', 'VECTOR3']);
    expect(mapping!.methods.doMove![0]!.section).toBe('CellMethods');
    fullMapping = mapping!;
  });

  it('双臂逐标量钉:控制臂真映射 mismatch 照报/真反例臂真未声明零警告', () => {
    expect(rpcArgCountFullMappingEntries.length).toBe(2);
    expect(fullMapping, '前置 fixture it 必须先行').toBeDefined();
    for (const entry of rpcArgCountFullMappingEntries) {
      const findings = computeRpcArgCountFindings(entry.input.source, fullMapping);
      const actual = findings.map(f => ({
        line: f.line,
        character: f.character,
        methodName: f.methodName,
        receiver: f.receiver,
        declaredCount: f.declaredCount,
        actualCount: f.actualCount
      }));
      expect(actual, `rpc arg count full-mapping drift: ${entry.id}`)
        .toEqual(entry.kode.analysis?.findings ?? []);
    }
  });
});

// ==================== writetodb-hook-signature 族(第二十一增量,2026-11-18) ====================
// 向导 hooks 签名面探针:onWriteToDB 双面真值(cellapp 零参/baseapp cellData 快照)
// 下,向导签名兼容性不变量与 documentation 同向性逐条实测;dbContext 参数命名
// 分歧只在 finding 登记(不进断言,不冒充修复);cellapp writeToDB 默认值缺口
// 走 unknown(闸=全 hooks 零主张探针)。
describe('truth-corpus: writetodb-hook-signature 族执行闸(向导 hooks 签名面探针)', () => {
  it('pinned 正例:onWriteToDB 向导签名双侧兼容(=None 默认下 cellapp 零参存活+baseapp 位置传参存活)', () => {
    const hook = getHookByName('onWriteToDB');
    expect(hook).toBeDefined();
    const entry = hookSigFamily.entries.find(e => e.id === 'writetodb-hook-dual-compat')!;
    expect(entry.kode.status).toBe('pinned');
    const analysis = entry.kode.analysis as { signatureContains: string[]; hookExists: boolean };
    expect(Boolean(hook)).toBe(analysis.hookExists);
    for (const token of analysis.signatureContains) {
      expect(hook!.signature, `signature drift: missing ${token}`).toContain(token);
    }
  });

  it('pinned 正例:documentation 双侧描述与档真值同向(baseapp 附参/cellapp 无参)', () => {
    const hook = getHookByName('onWriteToDB')!;
    const entry = hookSigFamily.entries.find(e => e.id === 'writetodb-hook-doc-face')!;
    const analysis = entry.kode.analysis as { documentationSaysBaseappArg: boolean; documentationSaysCellappNoArg: boolean };
    expect(hook.documentation.includes('baseapp 侧调用时附带')).toBe(analysis.documentationSaysBaseappArg);
    expect(hook.documentation.includes('cellapp 侧无参数')).toBe(analysis.documentationSaysCellappNoArg);
    // 分歧登记面在档:finding 注记 dbContext 命名误导(兼容性不变,不冒充修复)
    expect(entry.kode.finding).toContain('dbContext');
  });

  it('unknown 缺口闸:全 hooks 对 cellapp writeToDB 默认值零主张(零参调用仅现于 baseapp 面钩子)', () => {
    const entry = hookSigFamily.entries.find(e => e.id === 'writetodb-cellapp-defaults-gap')!;
    expect(entry.kind).toBe('unknown');
    expect(entry.kode.status).toBe('unverified');
    expect(entry.kode.analysis as { writeToDBZeroArgCallSites: number }).toEqual({ writeToDBZeroArgCallSites: 1 });
    const callers = KBENGINE_HOOKS.filter(h => h.example.includes('self.writeToDB()'));
    expect(callers.length).toBe(1);
    for (const hook of callers) {
      expect(hook.sourceLocation, 'writeToDB() 零参调用只允许出现在 baseapp 面钩子示例').toContain('baseapp');
    }
  });
});

// ==================== user-type-contract 族(第二十二增量,2026-11-18) ====================
// user_type 三契约面探针:implFileHasContractMethod/collectUserTypeContractMissing
// 直钉(setImplModule 装载硬闸:三属性 GetAttrString 全过才装载成功);赋值/
// lambda 形态误报只在 finding 登记(不冒充修复);组件范围闸走 unknown(收集
// 半宿主绑定,纯函数探针不可达)。
interface UserTypeContractEntry extends TruthEntryBase {
  input: {
    face: string;
    typeName?: string;
    implementedBy?: string;
    implFile?: string;
    implLine?: number;
    implSource?: string;
  };
  kode: TruthEntryBase['kode'] & {
    analysis?: {
      methods?: string[];
      missingCount?: number;
      missingMethods?: string[];
      consequence?: string;
      byImplFileLine?: number;
      implFileAbsentMissingItems?: number;
      detectedCount?: number;
      missingReported?: number;
      collectionFace?: string;
    };
  };
}
const utContractFamily = families.find(f => f.family === 'user-type-contract')!;
const utContractEntries = utContractFamily.entries as unknown as UserTypeContractEntry[];

/** 由 impl 源码按生产面口径扫出契约方法存在表(def 形态静态扫描)。 */
const utContractStatusOf = (input: UserTypeContractEntry['input']): UserTypeContractStatus => ({
  name: input.typeName ?? 'ProbeType',
  implementedBy: input.implementedBy,
  implFile: input.implFile,
  implLine: input.implLine,
  methods: {
    createObjFromDict: implFileHasContractMethod(input.implSource ?? '', 'createObjFromDict'),
    getDictFromObj: implFileHasContractMethod(input.implSource ?? '', 'getDictFromObj'),
    isSameType: implFileHasContractMethod(input.implSource ?? '', 'isSameType')
  }
});

describe('truth-corpus: user-type-contract 族执行闸(user_type 三契约面探针)', () => {
  it('roster 臂:三契约方法名册与声明序钉死(setImplModule GetAttrString 链)', () => {
    const entry = utContractEntries.find(e => e.id === 'usertype-contract-roster')!;
    expect(entry.kode.status).toBe('pinned');
    expect([...USER_TYPE_CONTRACT_METHODS]).toEqual(entry.kode.analysis!.methods);
  });

  it('缺一臂:缺 isSameType 报一条,后果文案与序列化契约同向,按 impl 文件聚合贴行', () => {
    const entry = utContractEntries.find(e => e.id === 'usertype-missing-isSameType')!;
    const status = utContractStatusOf(entry.input);
    const items = collectUserTypeContractMissing(status);
    expect(items.map(m => m.method)).toEqual(entry.kode.analysis!.missingMethods);
    expect(items).toHaveLength(entry.kode.analysis!.missingCount!);
    expect(items[0].message).toContain(entry.kode.analysis!.consequence!);
    expect(items[0].message).toContain(USER_TYPE_CONTRACT_CONSEQUENCE.isSameType);
    expect(items[0].typeName).toBe('AvatarProfile');
    expect(items[0].symbolName).toBe('AvatarProfile');
    const byFile = collectUserTypeContractMissingByImplFile([status], entry.input.implFile!);
    expect(byFile).toHaveLength(1);
    expect(byFile[0].line).toBe(entry.kode.analysis!.byImplFileLine);
  });

  it('缺二臂:两缺口各报一条,顺序=声明序(createObjFromDict → getDictFromObj)', () => {
    const entry = utContractEntries.find(e => e.id === 'usertype-missing-two-order')!;
    const items = collectUserTypeContractMissing(utContractStatusOf(entry.input));
    expect(items.map(m => m.method)).toEqual(entry.kode.analysis!.missingMethods);
    expect(items).toHaveLength(entry.kode.analysis!.missingCount!);
  });

  it('齐备臂:三契约俱全零诊断(引擎装载成功,合法实现沉默)', () => {
    const entry = utContractEntries.find(e => e.id === 'usertype-complete-silent')!;
    const items = collectUserTypeContractMissing(utContractStatusOf(entry.input));
    expect(items).toHaveLength(entry.kode.analysis!.missingCount!);
    expect(items).toHaveLength(0);
  });

  it('文件缺席面分工臂:implFile 缺席时缺方法面静默(兜底诊断另报,不重复)', () => {
    const entry = utContractEntries.find(e => e.id === 'usertype-impl-file-missing-face-split')!;
    const status = utContractStatusOf(entry.input);
    expect(status.implFile).toBeUndefined();
    expect(collectUserTypeContractMissing(status)).toHaveLength(
      entry.kode.analysis!.implFileAbsentMissingItems!
    );
  });

  it('赋值/lambda 形态臂:引擎属性存在性闸全过而 kode def 形态扫描全不识别=误报(finding 登记)', () => {
    const entry = utContractEntries.find(e => e.id === 'usertype-assignment-form-gap')!;
    const src = entry.input.implSource!;
    const detected = [...USER_TYPE_CONTRACT_METHODS].filter(m => implFileHasContractMethod(src, m));
    expect(detected).toHaveLength(entry.kode.analysis!.detectedCount!);
    const items = collectUserTypeContractMissing(utContractStatusOf(entry.input));
    expect(items).toHaveLength(entry.kode.analysis!.missingReported!);
    // 分歧登记面在档:误报方向,修复归独立批
    expect(entry.kode.finding).toContain('误报方向登记');
    expect(entry.kode.finding).toContain('赋值');
  });

  it('组件范围臂(解封取证):fixture workspace 直调收集半,跨组件统一收集=对齐非分歧', async () => {
    const entry = utContractEntries.find(e => e.id === 'usertype-component-scope')!;
    expect(entry.kind).toBe('positive');
    expect(entry.kode.status).toBe('pinned');
    // fixture workspace 直调(definitionWorkspaceBranches.test.ts 先例模式):
    // mkdtemp 摆 types.xml+impl 文件 → collectUserTypeContractStatuses 实测。
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join, dirname, basename } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'kode-utscope-corpus-'));
    const write = (rel: string, content: string) => {
      const target = join(root, ...rel.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf-8');
    };
    try {
      write('scripts/entity_defs/types.xml', entry.input.typesXml);
      write(entry.input.implFile, entry.input.implFileContent);
      const statuses = collectUserTypeContractStatuses(root);
      expect(statuses).toHaveLength(entry.kode.analysis!.collectedTypes.length);
      const expected = entry.kode.analysis!.collectedTypes[0];
      const got = statuses.find(s => s.name === expected.name)!;
      expect(got.implementedBy).toBe(expected.implementedBy);
      expect(basename(got.implFile ?? '')).toBe(expected.implFileBasename);
      expect(got.implLine).toBe(expected.implLine);
      expect(got.methods).toEqual(expected.methods);
      expect(entry.kode.analysis!.componentFilter).toBe('none');
      expect(entry.kode.finding).toContain('对齐非分歧');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ==================== entity-script-base-class 族(第二十三增量,2026-11-18) ====================
// 实体脚本基类面探针:parsePythonFile(类名/bases 表达式)+ linearizeC3(MRO 链)
// 直钉引擎两条硬闸(类名==模块名/isSubClass 对组件名册)的对应 kode 面;
// kode 无基类验证面与类名一致性检查面=漏报方向缺口,只在 finding 登记。
interface EntityBaseClassEntry extends TruthEntryBase {
  input: { face: string; fileName?: string; script?: string };
  kode: TruthEntryBase['kode'] & {
    analysis?: {
      className?: string;
      bases?: string[];
      directBases?: string[];
      mro?: string[];
    };
  };
}
const entityBaseFamily = families.find(f => f.family === 'entity-script-base-class')!;
const entityBaseEntries = entityBaseFamily.entries as unknown as EntityBaseClassEntry[];

/** 按名寻类(双类文件 classes[0] 不一定是目标;缺省回落文件名词干)。 */
const entityBaseClassOf = (
  input: EntityBaseClassEntry['input'],
  className?: string
): PythonClassDef | undefined => {
  const parsed = parsePythonFile(input.script ?? '', '/w/scripts/' + (input.fileName ?? 'Avatar.py'));
  const wanted = className ?? input.fileName?.replace(/\.py$/, '');
  return parsed.classes.find(c => c.name === wanted) ?? parsed.classes[0];
};

describe('truth-corpus: entity-script-base-class 族执行闸(实体脚本基类面探针)', () => {
  // QA-001a 检查面(纯)对语料如实产出:输入 roleFace + 实体名(fileName 词干)
  const runCheckFace = (entry: EntityBaseClassEntry) =>
    findEntityScriptBaseClassFindings(
      entry.input.script ?? '',
      entry.input.fileName ?? 'Avatar.py',
      (entry.input.fileName ?? 'Avatar.py').replace(/\.py$/, ''),
      (entry.input as { roleFace?: 'cellapp' | 'baseapp' | 'client' }).roleFace ?? null
    );

  it('类名闸臂:engine 要求类名==模块名;QA-001a 检查面已收编,同类名不一致报 Warning', () => {
    const entry = entityBaseEntries.find(e => e.id === 'entity-class-name-gate')!;
    const cls = entityBaseClassOf(entry.input, entry.kode.analysis?.className);
    expect(cls?.name).toBe(entry.kode.analysis!.className);
    expect(entry.kode.status).toBe('pinned');
    expect(entry.kode.finding).toContain('类名一致性检查面已收编');
    // 检查面如实产出类名闸发现(不再漏报)
    expect(runCheckFace(entry).map(f => f.kind)).toEqual(['class-name-gate']);
  });

  it('合法基类臂:bases 表达式被 parse 面如实捕获(含 import 来源);检查面零产出', () => {
    const entry = entityBaseEntries.find(e => e.id === 'entity-class-legal-base')!;
    const cls = entityBaseClassOf(entry.input);
    expect(cls?.bases).toEqual(entry.kode.analysis!.bases);
    expect(entry.kode.status).toBe('pinned');
    expect(runCheckFace(entry)).toHaveLength(0);
  });

  it('无基类臂:engine 对名册全假拒载;QA-001a 基类闸已收编,报 Warning', () => {
    const entry = entityBaseEntries.find(e => e.id === 'entity-class-no-base')!;
    const cls = entityBaseClassOf(entry.input);
    expect(cls?.bases).toEqual(entry.kode.analysis!.bases);
    expect(entry.kode.status).toBe('pinned');
    expect(entry.kode.finding).toContain('基类合法性检查面已收编');
    expect(runCheckFace(entry).map(f => f.kind)).toEqual(['base-class-gate']);
  });

  it('间接基类臂:engine MRO 间接子类过闸;kode 直取基类表达式+linearizeC3 全链可算;检查面零产出', () => {
    const entry = entityBaseEntries.find(e => e.id === 'entity-class-indirect-base')!;
    const cls = entityBaseClassOf(entry.input);
    expect(cls?.bases).toEqual(entry.kode.analysis!.directBases);
    const resolver = (base: string): PythonClassDef[] => {
      if (base === 'Avatar') {
        return [{ name: 'Avatar', bases: ['AccountBase'], filePath: entry.input.fileName!, startLine: 0, endLine: 0, methods: new Map() }];
      }
      if (base === 'AccountBase') {
        return [{ name: 'AccountBase', bases: ['Base'], filePath: entry.input.fileName!, startLine: 0, endLine: 0, methods: new Map() }];
      }
      if (base === 'Base') {
        return [{ name: 'Base', bases: ['KBEngine.Entity'], filePath: entry.input.fileName!, startLine: 0, endLine: 0, methods: new Map() }];
      }
      return [];
    };
    expect(linearizeC3('Avatar', resolver)).toEqual(entry.kode.analysis!.mro);
    expect(runCheckFace(entry)).toHaveLength(0);
  });

  it('baseapp 组件域臂:无基类 + baseapp 名册(含 Proxy)→ 基类闸报,名册与引擎一致', () => {
    const entry = entityBaseEntries.find(e => e.id === 'entity-base-gate-baseapp-no-base')!;
    expect(entry.kind).toBe('negative');
    const findings = runCheckFace(entry);
    expect(findings.map(f => f.kind)).toEqual(['base-class-gate']);
    expect(findings[0].roster).toEqual(entry.kode.analysis!.roster);
    expect(entry.kode.analysis!.roster).toContain('KBEngine.Proxy');
  });

  it('组件名册映射:QA-001a 经 SCRIPT_BASE_ROSTER 收编,cellapp/baseapp 钉', () => {
    const entry = entityBaseEntries.find(e => e.id === 'entity-base-roster-component-scope')!;
    expect(entry.kind).toBe('unknown');
    expect(entry.kode.status).toBe('pinned');
    expect(entry.kode.analysis!.roleFace).toContain('SCRIPT_BASE_ROSTER');
    expect((entry.reason ?? '').length).toBeGreaterThan(0);
  });

  it('client 名册未取证:基类闸不跑(不猜),类名闸照跑', () => {
    const entry = entityBaseEntries.find(e => e.id === 'entity-base-roster-client-unverified')!;
    expect(entry.kind).toBe('unknown');
    expect(entry.kode.status).toBe('unverified');
    expect(entry.kode.analysis!.roster).toBe('null(未取证)');
    expect((entry.reason ?? '').length).toBeGreaterThan(0);
  });
});

// ==================== fixed-dict-construction-site 族(第二十四增量,2026-11-18;翻案纠正版) ====================
// FD 构造点面探针:真面=KSEM-STRUCT-04 analyzeFixedDictConstructWrites(kbengine.fixedDictConstruct,
// diagnostics.ts 接线)。初版误探 analyzeFixedDictMutations(mutation 面,只旗子键赋值)误判构造点
// 零覆盖=漏报缺口登记;以真面探针实测翻案:引擎三道响闸(键数/键缺失/键值类型,datatype.cpp
// 2528/2546/2555)=kode missing/extra/type 三 kind 逐面对齐。齐备臂沉默对齐;下标已知键类型不符
// 臂双面钉=构造面不接管下标(0)+mutation 面旗子键(1),「构造点响/下标静默」不对称对照保留
// (family-13 陷阱面行为重钉)。
interface FdConstructEntry extends TruthEntryBase {
  input: {
    fixedDictProperties: Record<string, string[]>;
    fieldTypes: Record<string, string>;
    code: string;
  };
  kode: TruthEntryBase['kode'] & {
    analysis?: {
      constructionFindings?: number;
      constructionKind?: string;
      constructionKey?: string;
      expected?: string;
      actual?: string;
      subscriptFindings?: number;
      subscriptKind?: string;
    };
  };
}
const fdConstructFamily = families.find(f => f.family === 'fixed-dict-construction-site')!;
const fdConstructEntries = fdConstructFamily.entries as unknown as FdConstructEntry[];

/** 真面探针夹具:input.fieldTypes → 内联 PROFILE(types.xml:10),声明序=键序。 */
const fdConstructProfileOf = (input: FdConstructEntry['input']): CustomTypeInfo => ({
  name: 'PROFILE',
  filePath: '/entity_defs/types.xml',
  line: 10,
  implementedByLine: 10,
  startOffset: 0,
  endOffset: 0,
  aliasType: 'FIXED_DICT',
  rawValue: '',
  structure: { name: 'FIXED_DICT', rawValue: 'FIXED_DICT', children: [], line: 10 },
  properties: Object.entries(input.fieldTypes).map(([name, typeName], i) => ({
    name,
    typeName,
    line: 12 + i * 2
  }))
});

const fdConstructFindingsOf = (input: FdConstructEntry['input']) =>
  analyzeFixedDictConstructWrites(
    input.code,
    prop => Promise.resolve(prop === 'profile' ? 'PROFILE' : null),
    [fdConstructProfileOf(input)]
  );
const fdMutationFindingsOf = (input: FdConstructEntry['input']) =>
  analyzeFixedDictMutations(input.code, new Map(Object.entries(input.fixedDictProperties)));

describe('truth-corpus: fixed-dict-construction-site 族执行闸(FD 构造点面探针,真面=KSEM-STRUCT-04 construct)', () => {
  it('缺键臂:engine 键缺失响闸;kode 构造面 kind=missing 对齐(翻案纠正)', async () => {
    const entry = fdConstructEntries.find(e => e.id === 'fd-construct-missing-key')!;
    const findings = await fdConstructFindingsOf(entry.input);
    expect(findings).toHaveLength(entry.kode.analysis!.constructionFindings!);
    expect(findings[0].kind).toBe(entry.kode.analysis!.constructionKind);
    expect(findings[0].key).toBe(entry.kode.analysis!.constructionKey);
    expect(findings[0].message).toContain('missing field(s)');
    expect(entry.kode.status).toBe('pinned');
  });

  it('多键臂:engine 键数不符响闸;kode 构造面 kind=extra 逐键对齐(粒度差异非分歧)', async () => {
    const entry = fdConstructEntries.find(e => e.id === 'fd-construct-extra-key')!;
    const findings = await fdConstructFindingsOf(entry.input);
    expect(findings).toHaveLength(entry.kode.analysis!.constructionFindings!);
    expect(findings[0].kind).toBe(entry.kode.analysis!.constructionKind);
    expect(findings[0].key).toBe(entry.kode.analysis!.constructionKey);
    expect(findings[0].message).toContain('is not a field of PROFILE');
  });

  it('键值类型不符臂:engine at key 响闸;kode 构造面 kind=type 附期望/实际对齐', async () => {
    const entry = fdConstructEntries.find(e => e.id === 'fd-construct-wrong-type')!;
    const findings = await fdConstructFindingsOf(entry.input);
    expect(findings).toHaveLength(entry.kode.analysis!.constructionFindings!);
    expect(findings[0].kind).toBe(entry.kode.analysis!.constructionKind);
    expect(findings[0].key).toBe(entry.kode.analysis!.constructionKey);
    expect(findings[0].expected).toBe(entry.kode.analysis!.expected);
    expect(findings[0].actual).toBe(entry.kode.analysis!.actual);
  });

  it('齐备臂:逐键全过合法构造,kode 沉默=对齐(整赋值推荐姿势)', async () => {
    const entry = fdConstructEntries.find(e => e.id === 'fd-construct-exact')!;
    const findings = await fdConstructFindingsOf(entry.input);
    expect(findings).toHaveLength(entry.kode.analysis!.constructionFindings!);
    expect(findings).toHaveLength(0);
    expect(entry.kode.status).toBe('pinned');
  });

  it('下标不对称对照臂:engine 已知键类型不符静默 drop;kode 双面=构造面不接管下标(0)+mutation 面旗子键(1)', async () => {
    const entry = fdConstructEntries.find(e => e.id === 'fd-subscript-known-key-wrong-type-silent')!;
    const construct = await fdConstructFindingsOf(entry.input);
    expect(construct).toHaveLength(entry.kode.analysis!.constructionFindings!);
    expect(construct).toHaveLength(0);
    const mutation = fdMutationFindingsOf(entry.input);
    expect(mutation).toHaveLength(entry.kode.analysis!.subscriptFindings!);
    expect(mutation[0].kind).toBe(entry.kode.analysis!.subscriptKind);
    expect(mutation[0].key).toBe('level');
  });
});

// ==================== fixed-dict-decorator-binding 族(第二十五增量,2026-11-18) ====================
// FD 装饰器路径探针:@EntityDef.fixed_dict() 绑定闸(三属性存在性+静默不绑)+处理链
// 后段三道响闸(self 参数/模块域一段/未知 optionName),fork py_entitydef.cpp:1178-1302。
// kode 零装饰器分析面(parsePythonFile 只收类)——登记型家族(同 family-23 模式):
// 四负臂=漏报方向缺口登记,两段调用正臂=implFileHasContractMethod def 形态约束的
// 误报镜像登记(family-22 装饰器侧)。探针面=parsePythonFile+implFileHasContractMethod。
interface FdDecEntry extends TruthEntryBase {
  input: { code: string };
  kode: TruthEntryBase['kode'] & {
    analysis?: {
      parsedClasses?: number;
      parsedMethods?: string[];
      contractDefForm?: boolean[];
    };
  };
}
const fdDecFamily = families.find(f => f.family === 'fixed-dict-decorator-binding')!;
const fdDecEntries = fdDecFamily.entries as unknown as FdDecEntry[];

const fdDecParsedOf = (input: FdDecEntry['input']) =>
  parsePythonFile(input.code, '/w/entity_defs/types_impl.py');
const fdDecContractOf = (input: FdDecEntry['input']): boolean[] => [
  implFileHasContractMethod(input.code, 'createObjFromDict'),
  implFileHasContractMethod(input.code, 'getDictFromObj'),
  implFileHasContractMethod(input.code, 'isSameType')
];

describe('truth-corpus: fixed-dict-decorator-binding 族执行闸(FD 装饰器路径探针)', () => {
  it('后置属性附加臂:engine 求值序=静默不绑;kode 零装饰器面(parse 只收类,def 正则对赋值形态恒 false)', () => {
    const entry = fdDecEntries.find(e => e.id === 'fddec-attr-attach-after-decorator')!;
    const parsed = fdDecParsedOf(entry.input);
    expect(parsed.classes).toHaveLength(entry.kode.analysis!.parsedClasses!);
    expect(fdDecContractOf(entry.input)).toEqual(entry.kode.analysis!.contractDefForm!);
    expect(entry.kode.status).toBe('not-analyzed');
    expect(entry.kode.finding).toContain('漏报方向缺口登记');
  });

  it('两段调用正臂:engine 存在性绑定(赋值形态合法);kode def 形态约束=误报镜像登记(family-22 装饰器侧)', () => {
    const entry = fdDecEntries.find(e => e.id === 'fddec-explicit-two-phase-bind')!;
    const parsed = fdDecParsedOf(entry.input);
    expect(parsed.classes).toHaveLength(entry.kode.analysis!.parsedClasses!);
    expect(fdDecContractOf(entry.input)).toEqual(entry.kode.analysis!.contractDefForm!);
    expect(entry.kode.finding).toContain('误报方向镜像登记');
  });

  it('self 参数闸臂:engine 零参 AssertionError 响;kode 零诊断(缺口登记)', () => {
    const entry = fdDecEntries.find(e => e.id === 'fddec-no-self-param')!;
    const parsed = fdDecParsedOf(entry.input);
    expect(parsed.classes).toHaveLength(entry.kode.analysis!.parsedClasses!);
    expect(entry.kode.finding).toContain('self 参数闸');
  });

  it('嵌套两段臂:engine 模块域一段闸 AssertionError 响;kode parse 面只见类与方法、嵌套定义位置零判定', () => {
    const entry = fdDecEntries.find(e => e.id === 'fddec-nested-two-segment')!;
    const parsed = fdDecParsedOf(entry.input);
    expect(parsed.classes).toHaveLength(entry.kode.analysis!.parsedClasses!);
    expect(parsed.classes[0] ? [...parsed.classes[0].methods.keys()] : []).toEqual(entry.kode.analysis!.parsedMethods!);
    expect(entry.kode.finding).toContain('模块域闸');
  });

  it('未知 optionName 臂:engine not support AssertionError 响;kode 装饰器名名册检查缺席(缺口登记)', () => {
    const entry = fdDecEntries.find(e => e.id === 'fddec-unknown-option')!;
    const parsed = fdDecParsedOf(entry.input);
    expect(parsed.classes).toHaveLength(entry.kode.analysis!.parsedClasses!);
    expect(entry.kode.finding).toContain('名册检查缺席');
  });
});

// ==================== proxy-session-semantics 族(第二十六增量,2026-11-18) ====================
// Proxy 会话语义探针:客户端通道所有权与仲裁(fork proxy.cpp+baseapp.cpp,
// 知识档 docs/knowledge/proxy-session-semantics.md)。kode 面=悬停文档表
// (lookupApiDoc,generated/apiDocs.ts base 域)+receiverNone 诊断+parse 方法表。
// 对齐臂 4+分歧登记 1(onLogOnAttempt WAIT_FOR_DESTROY 文案 vs 源码同支拒绝,
// 方法学第六命中)+文档稀薄登记 1(onGiveClientToFailure 行号零语义)。
interface ProxySessionEntry extends TruthEntryBase {
  input: {
    script: string;
    hoverMembers?: string[];
    hoverMember?: string;
    hoverClaim?: string;
    scriptPath?: string;
    receiver?: string;
    parsedMethod?: string;
    faces?: string[];
  };
  kode: TruthEntryBase['kode'] & {
    analysis?: {
      hoverHits?: number;
      hoverHit?: boolean;
      hoverClaimPresent?: boolean;
      lifecycleMisreport?: number;
      parsedMethodVisible?: boolean;
      receiverNoneFindings?: number;
      receiver?: string;
      messageContains?: string;
      summarySemantic?: boolean;
      checkFaceFindings?: string[];
    };
  };
}
const proxySessionFamily = families.find(f => f.family === 'proxy-session-semantics')!;
const proxySessionEntries = proxySessionFamily.entries as unknown as ProxySessionEntry[];

describe('truth-corpus: proxy-session-semantics 族执行闸(Proxy 会话语义探针)', () => {
  it('悬停名册覆盖臂:Proxy 会话十成员 lookupApiDoc(base 域)全 hit——文档面名册完备对齐', () => {
    const entry = proxySessionEntries.find(e => e.id === 'proxy-hover-roster-coverage')!;
    const hits = entry.input.hoverMembers!.filter(
      name => lookupApiDoc(name, ['base']).kind === 'hit'
    );
    expect(hits).toHaveLength(entry.kode.analysis!.hoverHits!);
    expect(hits).toHaveLength(entry.input.hoverMembers!.length);
    expect(entry.kode.status).toBe('pinned');
  });

  it('onLogOnAttempt 分歧臂:engine WAIT_FOR_DESTROY 与 default 同支=同拒绝;kode hover 文案声称独立排队流程(登记不修)', async () => {
    const entry = proxySessionEntries.find(e => e.id === 'proxy-onlogonattempt-waitfordestroy-divergence')!;
    const lookup = lookupApiDoc(entry.input.hoverMember!, ['base']);
    expect(lookup.kind).toBe('hit');
    if (lookup.kind !== 'hit') { return; }
    expect(lookup.hit.entry.owner).toBe('proxy');
    expect(lookup.hit.entry.summaryEn).toContain(entry.input.hoverClaim!);
    expect(entry.kode.analysis!.hoverClaimPresent).toBe(true);
    expect(entry.kode.finding).toContain('分歧登记');
    expect(entry.kode.finding).toContain('不冒充修复');
  });

  it('onClientDeath 臂:engine 会话解绑后 clientEntityCall 返 None;kode receiverNone 消息含 onClientDeath 语义对齐', async () => {
    const entry = proxySessionEntries.find(e => e.id === 'proxy-onclientdeath-receiver-none')!;
    const findings = await computeReceiverNoneFindingsAsync(entry.input.script, entry.input.scriptPath!);
    expect(findings).toHaveLength(entry.kode.analysis!.receiverNoneFindings!);
    expect(findings[0]?.receiver).toBe(entry.kode.analysis!.receiver!);
    expect(renderReceiverNoneMessage('client')).toContain(entry.kode.analysis!.messageContains!);
    expect(renderReceiverNoneMessage('client')).toContain('entity.cpp:800');
    expect(entry.kode.status).toBe('pinned');
  });

  it('disconnect 臂:engine 只 condemn 通道不断实体生命周期;kode hover 文案同向无实体销毁误述', () => {
    const entry = proxySessionEntries.find(e => e.id === 'proxy-disconnect-not-destroy')!;
    const lookup = lookupApiDoc(entry.input.hoverMember!, ['base']);
    expect(lookup.kind).toBe('hit');
    if (lookup.kind !== 'hit') { return; }
    expect(lookup.hit.entry.summaryEn).toContain(entry.input.hoverClaim!);
    expect(lookup.hit.entry.summaryEn).not.toMatch(/destro(y|ed)|delete/i);
    expect(entry.kode.analysis!.lifecycleMisreport).toBe(0);
    expect(entry.kode.status).toBe('pinned');
  });

  it('onClientGetCell 臂:engine=客户端可访问 Cell 阶段;kode hover 文案同向+parse 方法表可见', () => {
    const entry = proxySessionEntries.find(e => e.id === 'proxy-onclientgetcell-stage')!;
    const lookup = lookupApiDoc(entry.input.hoverMember!, ['base']);
    expect(lookup.kind).toBe('hit');
    if (lookup.kind !== 'hit') { return; }
    expect(lookup.hit.entry.summaryEn).toContain(entry.input.hoverClaim!);
    const parsed = parsePythonFile(entry.input.script, '/w/assets/scripts/base/Avatar.py');
    const methods = parsed.classes[0] ? [...parsed.classes[0].methods.keys()] : [];
    expect(methods).toContain(entry.input.parsedMethod!);
    expect(entry.kode.status).toBe('pinned');
  });

  it('onGiveClientToFailure 臂:engine 前置校验边界语义;kode 回调条目文案零语义(稀薄登记,giveClientTo 本体已详尽)', () => {
    const entry = proxySessionEntries.find(e => e.id === 'proxy-giveclienttofailure-doc-thin')!;
    const lookup = lookupApiDoc(entry.input.hoverMember!, ['base']);
    expect(lookup.kind).toBe('hit');
    if (lookup.kind !== 'hit') { return; }
    // 零语义判定:summary 去除行号引用后无剩余内容
    const semantic = lookup.hit.entry.summaryEn.replace(/proxy\.cpp:[\d-]+\.?/g, '').trim().length > 0;
    expect(semantic).toBe(entry.kode.analysis!.summarySemantic!);
    expect(semantic).toBe(false);
    expect(entry.kode.finding).toContain('文档稀薄登记');
  });

  // QA-001b:检查面(findProxySessionFindings)对语料脚本的真实产出即真值。
  it('QA-001b 检查面:两分歧臂报/稳定值零产出/面不明零产出(不猜)', () => {
    const waitEntry = proxySessionEntries.find(
      e => e.id === 'proxy-session-check-logonwaitfordestroy'
    )!;
    const waitFindings = findProxySessionFindings(waitEntry.input.script, waitEntry.input.faces);
    expect(waitFindings.map(f => f.kind)).toEqual(waitEntry.kode.analysis!.checkFaceFindings);
    expect(waitFindings[0]?.message).toContain('LOG_ON_WAIT_FOR_DESTROY');
    expect(waitFindings[0]?.message).toContain('4020-4021');
    expect(waitEntry.kode.status).toBe('pinned');

    const giveEntry = proxySessionEntries.find(
      e => e.id === 'proxy-session-check-giveclienttoself'
    )!;
    const giveFindings = findProxySessionFindings(giveEntry.input.script, giveEntry.input.faces);
    expect(giveFindings.map(f => f.kind)).toEqual(giveEntry.kode.analysis!.checkFaceFindings);
    expect(giveFindings[0]?.message).toContain('giveClientTo(self)');
    expect(giveFindings[0]?.message).toContain('onGiveClientToFailure');
    expect(giveEntry.kode.status).toBe('pinned');

    const acceptEntry = proxySessionEntries.find(
      e => e.id === 'proxy-session-check-accept-stable'
    )!;
    const acceptFindings = findProxySessionFindings(acceptEntry.input.script, acceptEntry.input.faces);
    expect(acceptFindings.map(f => f.kind)).toEqual(acceptEntry.kode.analysis!.checkFaceFindings);
    expect(acceptFindings).toHaveLength(0);
    // 面不明(null)=不猜,零产出
    expect(findProxySessionFindings(waitEntry.input.script, null)).toHaveLength(0);
    expect(acceptEntry.kode.status).toBe('pinned');
  });
});

// ---- entity-lifecycle-hook-roster 族:引擎脚本回调名册面(36 条 KBENGINE_HOOKS) ----
// 探针实测后钉(getHookByName 真值):正例=档里以脚本回调形态出现的名字全解析,
// 负例=档明说「引擎无」的谓词与档里不存在的回调名册全不解析。
interface LifecycleRosterEntry extends TruthEntryBase {
  input: { path: string; name: string; roster: boolean };
  kode: TruthEntryBase['kode'] & {
    analysis?: {
      resolved?: boolean;
      category?: string;
      signature?: string;
      sourceLocation?: string;
      lifecycleNames?: string[];
    };
  };
}
const lifecycleRosterFamily = families.find(f => f.family === 'entity-lifecycle-hook-roster')!;
const lifecycleRosterEntries = lifecycleRosterFamily.entries as unknown as LifecycleRosterEntry[];

describe('truth-corpus: entity-lifecycle-hook-roster 族执行闸(脚本回调名册面探针)', () => {
  it('正例臂:档内脚本回调逐标量钉(解析在场+分类+签名+引擎调用点,drift 即红)', () => {
    for (const entry of lifecycleRosterEntries) {
      if (entry.kode.status !== 'pinned' || entry.input.roster) { continue; }
      if (entry.kode.analysis!.resolved !== true) { continue; }
      const hook = getHookByName(entry.input.name)!;
      expect(hook, entry.id).toBeDefined();
      expect(hook.category).toBe(entry.kode.analysis!.category);
      expect(hook.signature).toBe(entry.kode.analysis!.signature);
      expect(hook.sourceLocation).toBe(entry.kode.analysis!.sourceLocation);
    }
  });

  it('名册臂:lifecycle 分类名单逐名钉(改名/改分类/新收录即红)', () => {
    const entry = lifecycleRosterEntries.find(e => e.input.roster)!;
    expect(KBENGINE_HOOKS.filter(h => h.category === 'lifecycle').map(h => h.name)).toEqual(
      entry.kode.analysis!.lifecycleNames!
    );
    expect(entry.kode.status).toBe('pinned');
  });

  it('负例臂:引擎无谓词/档内不存在的回调名册不解析(混入即红)', () => {
    for (const entry of lifecycleRosterEntries) {
      if (entry.kode.status !== 'pinned' || entry.input.roster) { continue; }
      if (entry.kode.analysis!.resolved !== false) { continue; }
      expect(getHookByName(entry.input.name), entry.id).toBeUndefined();
    }
  });

  it('未知臂:onRestore 签名已解析但引擎实参集合未取证,保持 unverified 不冒充已核', () => {
    const entry = lifecycleRosterEntries.find(e => e.kode.status === 'unverified')!;
    expect(getHookByName(entry.input.name)).toBeDefined();
    expect(entry.reason).toBeTruthy();
  });
});

// ---- baseapp-module-face 族:baseapp KBEngine 模块面(档 §1 五登记点/§9 属性/§10 常量/§8 回调) ----
// 探针实测后钉(processApiSymbols('base') 真值):登记点名册在场+kind、引擎注册而
// kode 缺席的常量(漏报方向)、引擎无注册而 kode 有行的 MemoryStream(误导方向)、
// 源码文本假回调名不进 SPI 表。
interface ModuleFaceEntry extends TruthEntryBase {
  input: { path: string; process: string; roster?: string; name?: string; spi?: string };
  kode: TruthEntryBase['kode'] & {
    analysis?: {
      site1Names?: string[];
      functions?: string[];
      variables?: string[];
      kind?: string;
      presentInKode?: boolean;
      absentNames?: string[];
      resolved?: boolean;
      realName?: string;
    };
  };
}
const moduleFaceFamily = families.find(f => f.family === 'baseapp-module-face')!;
const moduleFaceEntries = moduleFaceFamily.entries as unknown as ModuleFaceEntry[];
const baseFaceSymbols = new Map(processApiSymbols('base').map(s => [s.name, s.kind]));

describe('truth-corpus: baseapp-module-face 族执行闸(baseapp 模块面探针)', () => {
  it('登记点名册臂:§1 site1 二十二字法名=function 行;共享/watcher/script/url 名册与属性常量按 role 钉 kind', () => {
    for (const entry of moduleFaceEntries) {
      if (entry.kode.status !== 'pinned' || !entry.input.roster) { continue; }
      const a = entry.kode.analysis!;
      for (const name of a.site1Names ?? []) {
        expect(baseFaceSymbols.get(name), `${entry.id}:${name}`).toBe('function');
      }
      for (const name of a.functions ?? []) {
        expect(baseFaceSymbols.get(name), `${entry.id}:${name}`).toBe('function');
      }
      for (const name of a.variables ?? []) {
        expect(baseFaceSymbols.get(name), `${entry.id}:${name}`).toBe('variable');
      }
    }
  });

  it('单符号臂:time 以该名注册=function 行在场(kind 钉,改表即红)', () => {
    const entry = moduleFaceEntries.find(e => e.input.name === 'time')!;
    expect(baseFaceSymbols.get(entry.input.name!)).toBe(entry.kode.analysis!.kind);
  });

  it('漏报分歧臂:引擎注册的 APP_FLAGS_* 常量在 kode 表缺席(收编即红,证现状未变)', () => {
    const entry = moduleFaceEntries.find(e => e.kode.analysis?.absentNames)!;
    expect(entry.kode.analysis!.absentNames!.length).toBeGreaterThan(0);
    for (const name of entry.kode.analysis!.absentNames!) {
      expect(baseFaceSymbols.has(name), name).toBe(false);
    }
    expect(entry.finding).toContain('漏报方向');
  });

  it('误导分歧臂:MemoryStream 引擎 baseapp 链无注册而 kode 表有 class 行(收窄即红)', () => {
    const entry = moduleFaceEntries.find(e => e.input.name === 'MemoryStream')!;
    expect(baseFaceSymbols.get(entry.input.name!)).toBe(entry.kode.analysis!.kind);
    expect(entry.kode.analysis!.presentInKode).toBe(true);
    expect(entry.finding).toContain('误导方向');
  });

  it('负例臂:onFini/onDelBaseAppData 名册不进 SPI 表;引擎真名 onBaseAppDataDel 在场', () => {
    for (const entry of moduleFaceEntries) {
      if (!entry.input.spi || entry.kode.analysis?.resolved !== false) { continue; }
      expect(ENGINE_SPI_METHODS[entry.input.spi], entry.input.spi).toBeUndefined();
    }
    const real = moduleFaceEntries.find(e => e.kode.analysis?.realName)!;
    expect(ENGINE_SPI_METHODS[real.kode.analysis!.realName!]).toBeDefined();
    expect(ENGINE_SPI_METHODS[real.kode.analysis!.realName!].components).toContain('baseapp');
  });

  it('未知臂:SERVER_ERR_* 数值集档内未枚举,符号在场但按未核钉不冒充已核', () => {
    const entry = moduleFaceEntries.find(e => e.kode.status === 'unverified')!;
    expect(baseFaceSymbols.get(entry.input.name!)).toBeDefined();
    expect(entry.reason).toBeTruthy();
  });
});

// ── 第二十九族 loginapp-dbmgr-logger-face(KB-API-006 三工具面)────────────
// 三面符号表(loginapp 67/dbmgr 68/logger 28)存在性+kind+签名直钉;SPI 名册面
// 六+七回调 required/components 钉;两处误导分歧(SERVER_ERR_MAX/Vector 族)按
// 现状钉——kode 侧收编或收窄即红,触发重钉,不冒充修复。
interface ToolFaceEntry extends TruthEntryBase {
  input: { path: string; process: string; roster?: string; name?: string };
  kode: TruthEntryBase['kode'] & {
    analysis?: {
      faces?: string[];
      functions?: string[];
      variables?: string[];
      classes?: string[];
      urlopenCallbackParams?: number;
      tableCount?: number;
      valuePins?: Record<string, number>;
      absentNamesOnLogger?: string;
      presentInKode?: boolean;
      pinnedSignature?: string;
      extraClasses?: string[];
      onlyOn?: string;
      absentOn?: string[];
      defaultDbInterfaceInSignature?: string;
      names?: string[];
      required?: boolean;
      component?: string;
      dbmgrNames?: string[];
      loggerNames?: string[];
      onReadyForShutDownComponents?: string[];
      onReadyForShutDownRequired?: boolean;
      onLogWroteRequired?: boolean;
      addTimerSignature?: string;
      delTimerSignature?: string;
    };
  };
}
const toolFaceFamily = families.find(f => f.family === 'loginapp-dbmgr-logger-face')!;
const toolFaceEntries = toolFaceFamily.entries as unknown as ToolFaceEntry[];
const toolFaceSymbols = new Map(
  (['loginapp', 'dbmgr', 'logger'] as const).map(
    p => [p, new Map(processApiSymbols(p).map(s => [s.name, s]))] as const
  )
);
describe('truth-corpus: loginapp-dbmgr-logger-face 族执行闸(三工具面探针)', () => {
  it('登记点名册臂:§1 共享面 24 名三面逐名钉 kind;urlopen 回调五参元组入签名', () => {
    const roster = toolFaceEntries.find(e => e.input.roster === 'pythonapp')!;
    const a = roster.kode.analysis!;
    expect(a.faces).toEqual(['loginapp', 'dbmgr', 'logger']);
    for (const face of a.faces!) {
      const syms = toolFaceSymbols.get(face as 'loginapp')!;
      for (const n of a.functions!) { expect(syms.get(n), `${face}:${n}`).toMatchObject({ kind: 'function' }); }
      for (const n of a.variables!) { expect(syms.get(n), `${face}:${n}`).toMatchObject({ kind: 'variable' }); }
      for (const n of a.classes!) { expect(syms.get(n), `${face}:${n}`).toMatchObject({ kind: 'class' }); }
      // D8:五参回调元组 (httpcode, data, headers, success, url) 固化进签名
      expect(a.urlopenCallbackParams).toBe(5);
      expect((syms.get('urlopen') as { signature: string }).signature)
        .toContain('Callable[[int, str, str, bool, str], Any]');
    }
  });

  it('D2 值钉臂:SERVER_ERR 38 表名在 loginapp+dbmgr,逐值=server_errors.h 表序', () => {
    const values = toolFaceEntries.find(e => e.id === 'pos-d2-serverErr-values')!;
    const a = values.kode.analysis!;
    expect(a.faces).toEqual(['loginapp', 'dbmgr']);
    for (const face of a.faces!) {
      const syms = toolFaceSymbols.get(face as 'loginapp')!;
      const serverNames = [...syms.keys()].filter(n => n.startsWith('SERVER_'));
      // 38 表名 + SERVER_ERR_MAX(误导分歧另钉)=39
      expect(serverNames.length, face).toBe(a.tableCount! + 1);
      for (const [name, value] of Object.entries(a.valuePins!)) {
        expect((syms.get(name) as { signature: string }).signature, `${face}:${name}`).toBe(`${name}: int = ${value}`);
      }
    }
  });

  it('D2 logger 负例臂:logger 面零 SERVER_*(loginapp 全集反查零命中)', () => {
    const neg = toolFaceEntries.find(e => e.id === 'neg-d2-serverErr-logger')!;
    expect(neg.kind).toBe('negative');
    expect(neg.kode.analysis!.absentNamesOnLogger).toBe('ALL_SERVER_STAR');
    const loggerNames = new Set(toolFaceSymbols.get('logger')!.keys());
    for (const n of toolFaceSymbols.get('loginapp')!.keys()) {
      if (n.startsWith('SERVER_')) { expect(loggerNames.has(n), n).toBe(false); }
    }
  });

  it('SERVER_ERR_MAX 误导臂:kode 两面带 =38 行(现状钉,收窄即红重钉)', () => {
    const div = toolFaceEntries.find(e => e.id === 'div-serverErrMax-extra')!;
    expect(div.kode.analysis!.presentInKode).toBe(true);
    for (const face of div.kode.analysis!.faces!) {
      const syms = toolFaceSymbols.get(face as 'loginapp')!;
      expect((syms.get('SERVER_ERR_MAX') as { signature: string }).signature, face)
        .toBe(div.kode.analysis!.pinnedSignature);
    }
  });

  it('Vector/FixedArray 误导臂:三面各带四条 class 行(Math 模块面/FixedArray 引擎面皆无)', () => {
    const div = toolFaceEntries.find(e => e.id === 'div-vector-fixedarray-extra')!;
    expect(div.kode.analysis!.presentInKode).toBe(true);
    for (const face of div.kode.analysis!.faces!) {
      const syms = toolFaceSymbols.get(face as 'loginapp')!;
      for (const n of div.kode.analysis!.extraClasses!) { expect(syms.get(n), `${face}:${n}`).toMatchObject({ kind: 'class' }); }
    }
  });

  it('executeRawDatabaseCommand 独占臂:dbmgr 有+两面无+签名默认接口 default', () => {
    const raw = toolFaceEntries.find(e => e.input.name === 'executeRawDatabaseCommand')!;
    const a = raw.kode.analysis!;
    expect(toolFaceSymbols.get(a.onlyOn as 'dbmgr')!.get('executeRawDatabaseCommand')).toBeDefined();
    for (const face of a.absentOn!) {
      expect(toolFaceSymbols.get(face as 'loginapp')!.get('executeRawDatabaseCommand')).toBeUndefined();
    }
    const sig = (toolFaceSymbols.get('dbmgr')!.get('executeRawDatabaseCommand') as { signature: string }).signature;
    expect(sig).toContain(a.defaultDbInterfaceInSignature!);
  });

  it('SPI 名册臂:loginapp 六回调必需;dbmgr/logger 名册+onReadyForShutDown 三组件精确+onLogWrote 可选', () => {
    const loginappRoster = toolFaceEntries.find(e => e.input.process === 'loginapp' && e.input.path === 'spi-roster')!;
    const a = loginappRoster.kode.analysis!;
    for (const n of a.names!) {
      expect(ENGINE_SPI_METHODS[n], n).toBeDefined();
      expect(ENGINE_SPI_METHODS[n].required, n).toBe(a.required);
      expect(ENGINE_SPI_METHODS[n].components, n).toContain(a.component);
    }
    const rosters = toolFaceEntries.find(e => e.input.process === 'dbmgr' && e.input.path === 'spi-roster')!;
    const b = rosters.kode.analysis!;
    for (const n of [...b.dbmgrNames!, ...b.loggerNames!]) {
      expect(ENGINE_SPI_METHODS[n], n).toBeDefined();
      expect(ENGINE_SPI_METHODS[n].components, n).toContain(n.startsWith('onDBMgr') || n === 'onSelectAccountDBInterface' ? 'dbmgr' : 'logger');
    }
    expect(ENGINE_SPI_METHODS.onReadyForShutDown.components).toEqual(b.onReadyForShutDownComponents);
    expect(ENGINE_SPI_METHODS.onReadyForShutDown.required).toBe(b.onReadyForShutDownRequired);
    expect(ENGINE_SPI_METHODS.onLogWrote.required).toBe(b.onLogWroteRequired);
  });

  it('D1 定时器签名臂:三面 addTimer/delTimer 精确签名(ffO 回调必需已固化)', () => {
    const timer = toolFaceEntries.find(e => e.input.name === 'addTimer')!;
    const a = timer.kode.analysis!;
    for (const face of a.faces!) {
      const syms = toolFaceSymbols.get(face as 'loginapp')!;
      expect((syms.get('addTimer') as { signature: string }).signature, face).toBe(a.addTimerSignature);
      expect((syms.get('delTimer') as { signature: string }).signature, face).toBe(a.delTimerSignature);
    }
    // D1 对齐面:kode 签名无 callbackObj 默认值,与 fork "ffO" 必需口径一致
    expect(a.addTimerSignature).not.toContain('callbackObj=');
  });
});

// ── 第三十族 cellapp-module-face(KB-API-004 cell 模块面)────────────
// cellapp 符号表(94)存在性+kind+签名直钉;SPI 名册九回调 components/required 钉;
// MemoryStream 误导分歧与 APP_FLAGS 漏报分歧按现状钉——kode 侧收编或收窄即红,
// 触发重钉,不冒充修复。address 跨族翻案:process-module-surface 族的 cell address
// 负例 divergence 被 fork cellapp.cpp:187 源码仲裁推翻(官方 3.7 材料口径不适用
// fork),两族条目同刻翻正;raycast 双 overload 对齐 fork currargsSize 3/4 双形态。
interface CellFaceEntry extends TruthEntryBase {
  input: { path: string; process: string; roster?: string; name?: string };
  kode: TruthEntryBase['kode'] & {
    analysis?: {
      site1Names?: string[];
      functions?: string[];
      variables?: string[];
      signatures?: string[];
      absentNames?: string[];
      presentInKode?: boolean;
      overloadCount?: number;
      resolved?: boolean;
      names?: string[];
      requiredFlags?: Record<string, boolean>;
    };
  };
}
const cellFaceFamily = families.find(f => f.family === 'cellapp-module-face')!;
const cellFaceEntries = cellFaceFamily.entries as unknown as CellFaceEntry[];
const cellFaceSymbols = new Map(processApiSymbols('cell').map(s => [s.name, s]));
describe('truth-corpus: cellapp-module-face 族执行闸(cell 模块面探针)', () => {
  it('登记点名册臂:site1 十八名+共享十五名=function 行;属性常量十名=variable 行', () => {
    for (const entry of cellFaceEntries) {
      if (entry.kode.status !== 'pinned' || !entry.input.roster || entry.input.roster === 'spi') { continue; }
      const a = entry.kode.analysis!;
      for (const name of a.site1Names ?? []) {
        expect(cellFaceSymbols.get(name), `${entry.id}:${name}`).toMatchObject({ kind: 'function' });
      }
      for (const name of a.functions ?? []) {
        expect(cellFaceSymbols.get(name), `${entry.id}:${name}`).toMatchObject({ kind: 'function' });
      }
      for (const name of a.variables ?? []) {
        expect(cellFaceSymbols.get(name), `${entry.id}:${name}`).toMatchObject({ kind: 'variable' });
      }
    }
  });

  it('SPI 名册臂:九回调 components 含 cellapp;required 旗逐名钉(onReadyForLogin 唯一可选)', () => {
    const entry = cellFaceEntries.find(e => e.input.roster === 'spi')!;
    const a = entry.kode.analysis!;
    expect(a.names!.length).toBe(9);
    for (const n of a.names!) {
      expect(ENGINE_SPI_METHODS[n], n).toBeDefined();
      expect(ENGINE_SPI_METHODS[n].components, n).toContain('cellapp');
      expect(ENGINE_SPI_METHODS[n].required, n).toBe(a.requiredFlags![n]);
    }
  });

  it('spaceData 签名臂:三函数 str 注解签名逐字钉(Iss/Is 契约同向,drift 即红)', () => {
    const entry = cellFaceEntries.find(e => e.id === 'pos-spacedata-str-signatures')!;
    for (const sig of entry.kode.analysis!.signatures!) {
      const name = sig.slice('def '.length, sig.indexOf('('));
      expect((cellFaceSymbols.get(name) as { signature: string }).signature, name).toBe(sig);
    }
  });

  it('raycast 双 overload 臂:恰 2 签名且 3 参/4 参形都在(fork currargsSize 3/4 同向)', () => {
    const entry = cellFaceEntries.find(e => e.id === 'pos-raycast-dual-overload')!;
    const a = entry.kode.analysis!;
    const sigs = (cellFaceSymbols.get('raycast') as { signature: string }).signature.split('\n');
    expect(sigs.length).toBe(a.overloadCount);
    for (const sig of a.signatures!) { expect(sigs).toContain(sig); }
  });

  it('address 翻案臂:fork 登记在场,kode=function 行;第十二族 cell 负例条目已翻正', () => {
    const entry = cellFaceEntries.find(e => e.id === 'pos-address-fork-arbitration')!;
    expect(cellFaceSymbols.get('address')).toMatchObject({ kind: 'function' });
    expect(entry.kode.analysis!.presentInKode).toBe(true);
    expect(entry.finding).toContain('跨族对账翻案');
    const flipped = procSurfaceFamily.entries.find(
      e => (e as ProcSurfaceEntry).id === 'proc-cell-address-absent-divergence'
    ) as ProcSurfaceEntry;
    expect(flipped.kind).toBe('positive');
    expect(flipped.engine.load).toBe('accept');
  });

  it('MemoryStream 误导臂:引擎 cell 链无注册而 kode 表有 class 行(收窄即红)', () => {
    const entry = cellFaceEntries.find(e => e.input.name === 'MemoryStream')!;
    expect(cellFaceSymbols.get('MemoryStream')).toMatchObject({ kind: 'class' });
    expect(entry.kode.analysis!.presentInKode).toBe(true);
    expect(entry.finding).toContain('误导方向');
  });

  it('APP_FLAGS 漏报臂:引擎注册的 APP_FLAGS_* 常量在 kode 表缺席(收编即红)', () => {
    const entry = cellFaceEntries.find(e => (e.kode.analysis?.absentNames?.length ?? 0) > 0)!;
    for (const name of entry.kode.analysis!.absentNames!) {
      expect(cellFaceSymbols.has(name), name).toBe(false);
    }
    expect(entry.finding).toContain('漏报方向');
  });

  it('createSpace 负例臂:两侧皆缺席(对齐钉,混入即红)', () => {
    const entry = cellFaceEntries.find(e => e.input.name === 'createSpace')!;
    expect(entry.kind).toBe('negative');
    expect(cellFaceSymbols.has('createSpace')).toBe(false);
    expect(entry.kode.analysis!.presentInKode).toBe(false);
  });

  it('未知臂:createEntity 三运行期 TypeError 条件未核,按未核钉不冒充已核', () => {
    const entry = cellFaceEntries.find(e => e.kode.status === 'unverified')!;
    expect(cellFaceSymbols.get(entry.input.name!)).toBeDefined();
    expect(entry.reason).toBeTruthy();
  });
});
