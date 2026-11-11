/**
 * user_type 三契约探测/收集 Rust↔TS 对拍(RUST-MIGRATION-AUDIT-006 B1 车道
 * 批 4,沿 returnAnnotationsRustParity 先例):真实 kode-server 跑
 * `$/kode/python/userTypeContract`,两面与 TS 纯函数**全量深等**——
 * - items(缺方法诊断项+定位行)≡ collectUserTypeContractMissingByImplFile
 *   (TS 侧 methods 经 implFileHasContractMethod 同源探测;恒等路径过滤/
 *   `implLine ?? 1` 贴行/声明序);
 * - probes(逐源三方法探测)≡ implFileHasContractMethod 逐源(原始行正则
 *   保真:三引号体内形似 def 行同判命中、CRLF/孤立 \r/  行起点)。
 * 语料 = 合成源(全齐/缺一/缺全/tab/CRLF/孤立 \r/ /三引号体/同行串内
 * def)+ 真实 fixture .py 全量;statuses 覆盖 implementedBy 有/无/空串/尾点、
 * implLine 有/无、空 implFile 静默、异文件过滤。二进制缺失(未构建 Rust)
 * 整套 skip;二进制在场则首例先做直连 ok 断言(旧二进制缺方法显式红而非
 * 静默假绿)。生产装配切换另例:真实 client 注入 shadow gate 后
 * collectUserTypeContractMissingByImplFileFromRust ≡ TS 收集(装配读盘源,
 * 合成源落盘 tmpdir)。生产消费点=activate/diagnostics.ts computeAsync
 * (vscode 面不可 vitest 直测,装配面深等为其直接前提)。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import {
  collectUserTypeContractMissingByImplFile,
  implFileHasContractMethod,
  USER_TYPE_CONTRACT_METHODS,
  type UserTypeContractStatus
} from '../src/backend/userTypeContract';
import { collectUserTypeContractMissingByImplFileFromRust } from '../src/backend/userTypeContractRust';

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const binaryReady = existsSync(binaryPath);

const FIXTURE_ROOT = join(repoRoot, 'tests', 'fixtures');

function collectPythonFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectPythonFiles(full, out);
    } else if (entry.endsWith('.py')) {
      out.push(full);
    }
  }
  return out;
}

/** 语法素材(源文本 → 虚拟路径键) */
const SYNTHETIC_SOURCES: Record<string, string> = {
  '/v/complete.py': [
    'class Impl:',
    '    def createObjFromDict(self, dictData):',
    '        return dictData',
    '    def getDictFromObj(self, obj):',
    '        return {}',
    '    def isSameType(self, obj):',
    '        return True'
  ].join('\n'),
  '/v/no-is-same.py': [
    'class Impl:',
    '    def createObjFromDict(self, dictData):',
    '        return dictData',
    '    def getDictFromObj(self, obj):',
    '        return {}'
  ].join('\n'),
  '/v/all-missing.py': ['class Impl:', '    pass'].join('\n'),
  '/v/tab-indent.py':
    'class Impl:\n\tdef createObjFromDict(self, d):\n\t    pass\n\tdef isSameType(self, o):\n\t    pass\n',
  '/v/crlf.py': 'class Impl:\r\n    def createObjFromDict(self, d):\r\n        pass\r\n',
  '/v/lone-cr.py': 'a = 1\rdef getDictFromObj(self):\r    pass\r',
  '/v/unicode-sep.py': 'a = 1\u{2028}def isSameType(self):\u{2028}    pass',
  '/v/triple-quote-body.py': [
    'doc = """',
    'def isSameType(self):',
    '"""',
    'class Impl:',
    '    pass'
  ].join('\n'),
  '/v/same-line-string.py': 's = "def isSameType(self):"\nclass Impl:\n    pass\n',
  '/v/attribute-assign.py': 'isSameType = lambda obj: True\nclass Impl:\n    pass\n'
};

/** 源路径 → 该源上各契约方法存在性(TS 同源探测) */
function tsMethodsOf(source: string): Record<string, boolean> {
  const methods: Record<string, boolean> = {};
  for (const method of USER_TYPE_CONTRACT_METHODS) {
    methods[method] = implFileHasContractMethod(source, method);
  }
  return methods;
}

interface ContractStatusInput {
  name: string;
  implementedBy?: string;
  implFile?: string;
  implLine?: number;
}

/** statuses(带 methods 的 TS 全快照;methods=对源 TS 探测) */
function tsStatusesOf(inputs: readonly ContractStatusInput[]): UserTypeContractStatus[] {
  return inputs.map(input => {
    const methods: Record<string, boolean> = {
      createObjFromDict: false,
      getDictFromObj: false,
      isSameType: false
    };
    if (input.implFile) {
      const source = SYNTHETIC_SOURCES[input.implFile] ?? '';
      for (const method of USER_TYPE_CONTRACT_METHODS) {
        methods[method] = implFileHasContractMethod(source, method);
      }
    }
    return {
      name: input.name,
      implementedBy: input.implementedBy,
      implFile: input.implFile,
      implLine: input.implLine,
      methods: methods as UserTypeContractStatus['methods']
    };
  });
}

/** 直连一批 statuses(裸 RPC;虚拟路径) */
async function rpcCall(
  client: KodeCoreClient,
  file: string,
  statuses: readonly ContractStatusInput[],
  sources: Record<string, string> = SYNTHETIC_SOURCES
): Promise<{
  items: Array<{
    message: string;
    method: string;
    typeName: string;
    symbolName: string;
    symbolLength: number;
    line: number;
    related: { targetFile: string; label: string };
  }>;
  probes: Record<string, Record<string, boolean>>;
}> {
  const wireStatuses = statuses.map(status => {
    const wire: Record<string, unknown> = { name: status.name };
    if (status.implementedBy !== undefined) {
      wire.implementedBy = status.implementedBy;
    }
    if (status.implFile !== undefined) {
      wire.implFile = status.implFile;
    }
    if (status.implLine !== undefined) {
      wire.implLine = status.implLine;
    }
    return wire;
  });
  return (await client.request('$/kode/rpc', {
    method: '$/kode/python/userTypeContract',
    params: { file, sources, statuses: wireStatuses }
  })) as {
    items: Array<{
      message: string;
      method: string;
      typeName: string;
      symbolName: string;
      symbolLength: number;
      line: number;
      related: { targetFile: string; label: string };
    }>;
    probes: Record<string, Record<string, boolean>>;
  };
}

const STATUS_CORPUS: ContractStatusInput[] = [
  { name: 'Complete', implementedBy: 'pkg.Complete', implFile: '/v/complete.py', implLine: 1 },
  { name: 'NoIsSame', implementedBy: 'pkg.NoIsSame', implFile: '/v/no-is-same.py', implLine: 7 },
  { name: 'AllMissing', implementedBy: 'pkg.AllMissing', implFile: '/v/all-missing.py' },
  { name: 'TabIndent', implementedBy: 'pkg.TabIndent', implFile: '/v/tab-indent.py', implLine: 2 },
  { name: 'Crlf', implementedBy: 'pkg.Crlf', implFile: '/v/crlf.py', implLine: 3 },
  { name: 'LoneCr', implementedBy: 'pkg.LoneCr', implFile: '/v/lone-cr.py', implLine: 4 },
  { name: 'UnicodeSep', implementedBy: 'pkg.UnicodeSep', implFile: '/v/unicode-sep.py', implLine: 5 },
  { name: 'TripleQuote', implementedBy: 'pkg.TripleQuote', implFile: '/v/triple-quote-body.py', implLine: 6 },
  { name: 'SameLineStr', implementedBy: 'pkg.SameLineStr', implFile: '/v/same-line-string.py', implLine: 8 },
  { name: 'AttrAssign', implementedBy: 'pkg.AttrAssign', implFile: '/v/attribute-assign.py', implLine: 9 },
  { name: 'NoImplBy', implFile: '/v/all-missing.py', implLine: 10 },
  { name: 'EmptyImplBy', implementedBy: '', implFile: '/v/all-missing.py', implLine: 11 },
  { name: 'TrailingDot', implementedBy: 'pkg.', implFile: '/v/all-missing.py', implLine: 12 },
  { name: 'Elsewhere', implementedBy: 'pkg.Elsewhere', implFile: '/v/other.py', implLine: 1 },
  { name: 'SilentEmpty', implementedBy: 'pkg.Silent', implFile: '', implLine: 1 },
  { name: 'NoFile' }
];

const suite = binaryReady ? describe : describe.skip;

suite('userTypeContract Rust↔TS 探测/收集核对拍(真实 kode-server)', () => {
  it('直连断言:Rust 方法在场且两面形状合法(旧二进制缺方法 → 显式红)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined
    });
    await client.start();
    try {
      const resp = (await client.request('$/kode/rpc', {
        method: '$/kode/python/userTypeContract',
        params: {
          file: '/v/complete.py',
          sources: { '/v/complete.py': SYNTHETIC_SOURCES['/v/complete.py'] },
          statuses: [{ name: 'T', implementedBy: 'pkg.Impl', implFile: '/v/complete.py', implLine: 1 }]
        }
      })) as { items?: unknown; probes?: unknown };
      expect(Array.isArray(resp.items), '旧二进制缺方法/畸形 → 显式红').toBe(true);
      expect(resp.probes && typeof resp.probes === 'object').toBe(true);
    } finally {
      await client.dispose().catch(() => undefined);
    }
  });

  it('items+probes 全量深等:合成源 statuses 语料 + 逐源探测 + fixture .py 全量', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined
    });
    await client.start();
    try {
      const targets = ['/v/complete.py', '/v/no-is-same.py', '/v/all-missing.py'];
      for (const target of targets) {
        const resp = await rpcCall(client, target, STATUS_CORPUS);
        const tsStatuses = tsStatusesOf(STATUS_CORPUS);
        expect(
          resp.items,
          `${target}: items ≠ TS(消息文案/定位行/过滤/静默漂移)`
        ).toEqual(collectUserTypeContractMissingByImplFile(tsStatuses, target));
        expect(
          resp.probes,
          `${target}: probes ≠ TS(行起点/掩码语义漂移)`
        ).toEqual(
          Object.fromEntries(
            Object.entries(SYNTHETIC_SOURCES).map(([file, source]) => [
              file,
              tsMethodsOf(source)
            ])
          )
        );
      }
      // fixture .py 全量作源:探测面逐源深等(TS implFileHasContractMethod 同源)
      const fixtureSources: Record<string, string> = {};
      for (const file of collectPythonFiles(FIXTURE_ROOT)) {
        fixtureSources[`fixture:${file.slice(FIXTURE_ROOT.length + 1)}`] = readFileSync(file, 'utf8');
      }
      expect(Object.keys(fixtureSources).length).toBeGreaterThan(0);
      const resp = await rpcCall(client, 'fixture:none', [], fixtureSources);
      expect(
        resp.probes,
        'fixture probes ≠ TS(真实 .py 语料漂移)'
      ).toEqual(
        Object.fromEntries(
          Object.entries(fixtureSources).map(([file, source]) => [file, tsMethodsOf(source)])
        )
      );
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 120000);

  describe('生产装配切换(真实 client 门注入;装配读盘源 → 合成源落盘 tmpdir)', () => {
    let root = '';
    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-utcr-parity-'));
      for (const [index, source] of Object.values(SYNTHETIC_SOURCES).entries()) {
        const target = path.join(root, `impl-${index}.py`);
        fs.writeFileSync(target, source, 'utf8');
      }
    });
    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('装配收集 ≡ TS 收集(双目标)+ 无门 null 兜底', async () => {
      const client = new KodeCoreClient({
        binaryPath,
        initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
        onStderr: () => undefined
      });
      await client.start();
      setKodeCoreShadowGate({
        runInRust: async (method: string, params: unknown) => {
          const result = await client.request('$/kode/rpc', { method, params });
          return { ok: true as const, result };
        }
      } as unknown as KodeCoreGate);
      try {
        const diskFiles = fs.readdirSync(root).map(file => path.join(root, file));
        const statuses: UserTypeContractStatus[] = diskFiles.map((file, index) => {
          const source = fs.readFileSync(file, 'utf8');
          const methods: UserTypeContractStatus['methods'] = {
            createObjFromDict: false,
            getDictFromObj: false,
            isSameType: false
          };
          for (const method of USER_TYPE_CONTRACT_METHODS) {
            methods[method] = implFileHasContractMethod(source, method);
          }
          return {
            name: `Type${index}`,
            implementedBy: `pkg.Impl${index}`,
            implFile: file,
            implLine: index + 1,
            methods
          };
        });
        statuses.push({
          name: 'Elsewhere',
          implementedBy: 'pkg.Elsewhere',
          implFile: path.join(root, 'does-not-exist.py'),
          implLine: 1,
          methods: { createObjFromDict: false, getDictFromObj: false, isSameType: false }
        });
        for (const target of diskFiles) {
          const rustItems = await collectUserTypeContractMissingByImplFileFromRust(
            statuses,
            target
          );
          expect(
            rustItems,
            `${path.basename(target)}: 装配收集 ≠ TS`
          ).toEqual(collectUserTypeContractMissingByImplFile(statuses, target));
        }
        // 无绑定目标的 status → 合法空面(不空发 RPC)
        const stray = statuses.slice(0, 1);
        expect(
          await collectUserTypeContractMissingByImplFileFromRust(
            [stray[0]],
            path.join(root, 'unbound.py')
          )
        ).toEqual([]);
      } finally {
        setKodeCoreShadowGate(null);
        await client.dispose().catch(() => undefined);
      }
    }, 120000);
  });
});
