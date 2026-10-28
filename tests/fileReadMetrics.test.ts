import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import {
  getLanguageServiceSummaryReport,
  resetLanguageServiceMetrics
} from '../src/languageServiceMetrics';
import {
  FILE_READ_RING_LIMIT,
  getRecentFileReads,
  getFileReadTotals,
  readFileUtf8Recorded,
  readFileSyncUtf8Recorded,
  recordFileRead,
  resetFileReadMetrics,
  setFileReadVerbose
} from '../src/fileReadMetrics';
import { KBEngineHoverProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-MET-004:文件读取量与读取字节数记录。验收:一次普通 hover 可核对实际
// 读盘范围(路径+字节,全在工作区语境内),关闭详细记录时开销有界(明细
// 不保留,累计只做加法)。审计口径:reset → 操作 → getRecentFileReads/
// getFileReadTotals 对账;读失败不记账;环形明细满容量丢最旧。

const writeWs = (dir: string, relative: string, content: string): string => {
  const absolute = path.join(dir, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
  return absolute;
};

describe('文件读取量与字节数记录(IDE-MET-004)', () => {
  it('一次普通 hover 的读盘范围可核对:路径全在工作区内、字节数与盘上一致', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-fileread-'));
    const typesXml = writeWs(dir, path.join('scripts', 'entity_defs', 'types.xml'),
      '<root>\n  <TIMESTAMP> UINT64 </TIMESTAMP>\n</root>\n');
    writeWs(dir, path.join('scripts', 'entity_defs', 'Avatar.def'), [
      '<root>',
      '  <CellMethods>',
      '    <reqPos>',
      '      <Arg>TIMESTAMP</Arg>',
      '    </reqPos>',
      '  </CellMethods>',
      '</root>'
    ].join('\n'));
    const avatarPy = writeWs(dir, path.join('scripts', 'base', 'Avatar.py'),
      'class Avatar(kbe.KBEntity):\n    def reqPos(self, pos: int):\n        pass\n');

    stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'ws', index: 0 }];
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (glob?: string) =>
      glob === '**/*.def'
        ? [Uri.file(path.join(dir, 'scripts', 'entity_defs', 'Avatar.def'))]
        : []) as typeof stubWorkspace.findFiles;

    try {
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      // 暖 def 索引(等首扫落地;def 查询纯内存)。类型注册表快照此时仍是
      // miss——被审计 hover 的 schema 形参闸第一次解析 TIMESTAMP 注解,
      // 冷注册表构建必读 types.xml,读盘审计面可断言。
      await manager.waitForInitialScan();
      expect(await manager.resolveMethodDefinition(avatarPy, 'reqPos')).not.toBeNull();

      const provider = new KBEngineHoverProvider(manager);
      const doc = makeTextDocument(
        'class Avatar(kbe.KBEntity):\n    def reqPos(self, pos: int):\n        pass\n',
        { fileName: avatarPy, languageId: 'python' }
      ) as never;

      resetFileReadMetrics();
      setFileReadVerbose(true);
      const result = await provider.provideHoverTimed(
        doc as never,
        new Position(1, 8),
        undefined,
        undefined
      );
      expect(result).not.toBeNull();

      const recent = getRecentFileReads();
      expect(recent.length, '冷注册表 hover 必有实际读盘').toBeGreaterThan(0);
      for (const record of recent) {
        expect(
          record.path.startsWith(dir),
          `读盘越界出工作区: ${record.path}`
        ).toBe(true);
        expect(record.bytes, `零字节读盘: ${record.path}`).toBeGreaterThan(0);
      }
      // 冷类型注册表构建必读 types.xml,且字节数与盘上文件一致
      const typesRead = recent.find(record => record.path === typesXml);
      expect(typesRead, `types.xml 未进读盘审计: ${JSON.stringify(recent)}`).toBeDefined();
      expect(typesRead!.bytes).toBe(fs.statSync(typesXml).size);
      // 累计与明细对账一致(verbose 下无并发丢账)
      const totals = getFileReadTotals();
      expect(totals.reads).toBe(recent.length);
      expect(totals.bytes).toBe(recent.reduce((sum, record) => sum + record.bytes, 0));
    } finally {
      setFileReadVerbose(false);
      resetFileReadMetrics();
      stubWorkspace.workspaceFolders = [];
      stubWorkspace.findFiles = originalFindFiles;
    }
  });

  it('关闭详细记录时开销有界:明细恒空、累计计数照常、环形满容量丢最旧', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-fileread-ring-'));
    const target = writeWs(dir, 'sample.txt', 'abcdef');
    try {
      resetFileReadMetrics();
      setFileReadVerbose(false);
      const content = readFileSyncUtf8Recorded(target);
      expect(content).toBe('abcdef');
      expect(getRecentFileReads(), 'verbose 关:不保留任何逐次明细').toEqual([]);
      const totals = getFileReadTotals();
      expect(totals.reads).toBe(1);
      expect(totals.bytes).toBe(6);

      setFileReadVerbose(true);
      resetFileReadMetrics();
      for (let index = 0; index < FILE_READ_RING_LIMIT + 50; index += 1) {
        recordFileRead(`${dir}/f${index}.txt`, index + 1);
      }
      const ring = getRecentFileReads();
      expect(ring.length, '环形缓冲有界').toBe(FILE_READ_RING_LIMIT);
      expect(ring[0].path, '满容量丢最旧').toBe(`${dir}/f50.txt`);
      // 累计不受环形截断影响:300 次全在账上
      expect(getFileReadTotals().reads).toBe(FILE_READ_RING_LIMIT + 50);
    } finally {
      setFileReadVerbose(false);
      resetFileReadMetrics();
    }
  });

  it('读失败不记账:异常原样抛出,累计不变', () => {
    resetFileReadMetrics();
    const before = getFileReadTotals();
    expect(() => readFileSyncUtf8Recorded('/kode-met-004/no-such-file.txt')).toThrow();
    expect(getFileReadTotals()).toEqual(before);
    resetFileReadMetrics();
  });

  it('指标汇总报告含文件读取行:读盘账面可从既有 metrics 面核对', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-fileread-report-'));
    const target = writeWs(dir, 'sample.txt', 'hello world');
    try {
      resetLanguageServiceMetrics();
      resetFileReadMetrics();
      await readFileUtf8Recorded(target);
      const report = getLanguageServiceSummaryReport();
      expect(report).toContain('file reads:');
      expect(report).toContain('11 bytes');
    } finally {
      setFileReadVerbose(false);
      resetFileReadMetrics();
    }
  });
});
