import { describe, expect, it } from 'vitest';
import {
  buildHistoryEntryLabel,
  buildHistoryEntryTooltipLines,
  HOT_RELOAD_HISTORY_EXPORT_FIELDS,
  projectHotReloadHistoryExportRow,
  type HotReloadHistoryEntry,
  type HotReloadHistoryInput
} from '../src/backend/hotReloadHistoryCore';
import { type HttpRequestOutcome } from '../src/backend/httpRequestExecutor';

/**
 * RUST-421(HR-QA-009):HTTP header/token 不得出现在 output、trace、history、
 * UI tooltip、导出数据表面。本测钉住纯核侧已验收面:
 * - history DTO(HotReloadHistoryInput/Entry)字段集=固定安全集,无 header/token;
 * - tooltip 投影行全部来自安全字段(若未来有人给 tooltip 加 `headers:`/`token:`
 *   行,前缀守卫必红,须有意识改动——防静默泄出回归);
 * - 传输 outcome DTO(HttpRequestOutcome,进 OUTPUT 面板面)字段集无 header/token
 *   (header 只存在于 OutgoingHttpRequest 出站传输 DTO 的合法出站点);
 * - 导出面(RUST-368 serializeHotReloadHistoryJson)白名单投影,行键集=固定
 *   安全十二字段集,无 header/token/body(不整体透传,防 DTO 加字段自动漏出)。
 *
 * 未在本测覆盖面(随接线批/主席在途文件收口):output 面板服务层流水行、
 * trace 面、导出数据(RUST-368 尚未实现,无导出表面)。
 */

/** 密钥形状字段名(子串匹配,防御未来加 header/token/secret 类字段) */
const SECRET_KEY_PATTERN = /header|token|secret|authorization|cookie|credential|api-?key|bearer/i;

/** 钉住:对象自身字段名不含密钥形状(有密钥字段=本测必红,须有意识改) */
const assertNoSecretKeys = (label: string, obj: object): void => {
  for (const key of Object.keys(obj)) {
    expect(SECRET_KEY_PATTERN.test(key), `${label} 含密钥形状字段名: ${key}`).toBe(false);
  }
};

const makeEntry = (overrides: Partial<HotReloadHistoryInput> = {}): HotReloadHistoryEntry => ({
  requestId: 'req-1',
  fullModule: 'entities.fight.FightAI',
  requestModule: 'fight.FightAI',
  fileUri: '/ws/scripts/entities/fight/FightAI.py',
  targetId: 'target-1',
  time: 1700000000000,
  status: 'applied',
  ...overrides
});

const makeOutcome = (overrides: Partial<HttpRequestOutcome> = {}): HttpRequestOutcome => ({
  correlationId: '00000000-0000-4000-8000-000000000001',
  kind: 'ok',
  transportOk: true,
  status: 200,
  durationMs: 42,
  body: '{"ok":true}',
  ...overrides
});

describe('RUST-421 密钥不泄出:history DTO 结构面', () => {
  it('history 输入/条目字段集无密钥形状字段(header/token 只允许在出站传输 DTO)', () => {
    // HR-STATE-007 补四字段(trigger/durationMs/errorCategory/hash)后全量行=12 字段
    const entry = makeEntry({
      errorSummary: 'HTTP 404',
      trigger: 'retry',
      durationMs: 50,
      errorCategory: 'target-restart',
      hash: 'a'.repeat(64)
    });
    assertNoSecretKeys('HotReloadHistoryEntry', entry);
    // 钉住字段集本身:安全十二字段,不多不少(加字段须有意识改此测)
    expect(Object.keys(entry).sort()).toEqual(
      [
        'fileUri',
        'fullModule',
        'requestId',
        'requestModule',
        'status',
        'targetId',
        'time',
        'errorSummary',
        'trigger',
        'durationMs',
        'errorCategory',
        'hash'
      ].sort()
    );
  });

  it('导出行(RUST-368)键集=安全十二字段白名单,无 header/token/body(不整体透传)', () => {
    const entry = makeEntry({
      errorSummary: 'HTTP 404',
      trigger: 'retry',
      durationMs: 50,
      errorCategory: 'target-restart',
      hash: 'a'.repeat(64)
    });
    const row = projectHotReloadHistoryExportRow(entry);
    assertNoSecretKeys('export row', row);
    expect(Object.keys(row).sort()).toEqual([...HOT_RELOAD_HISTORY_EXPORT_FIELDS].sort());
    expect('body' in row).toBe(false);
    // 白名单是闸:DTO 上额外密钥形状字段不透传进导出行
    const polluted = entry as unknown as Record<string, unknown>;
    polluted.header = 'Bearer x';
    polluted.token = 'abc';
    const clean = projectHotReloadHistoryExportRow(polluted as unknown as HotReloadHistoryEntry);
    expect('header' in clean).toBe(false);
    expect('token' in clean).toBe(false);
  });

  it('outcome DTO 字段集无密钥形状字段(进 OUTPUT 面板面不携带 header/token)', () => {
    const outcome = makeOutcome();
    assertNoSecretKeys('HttpRequestOutcome', outcome);
    expect(Object.keys(outcome).sort()).toEqual(
      ['body', 'correlationId', 'durationMs', 'kind', 'status', 'transportOk'].sort()
    );
  });
});

describe('RUST-421 密钥不泄出:UI tooltip 投影面', () => {
  it('tooltip 行全部来自安全字段前缀,无 header/token 形状行', () => {
    const lines = buildHistoryEntryTooltipLines(
      makeEntry({ errorSummary: 'HTTP 404: Not Found' })
    );
    const SAFE_PREFIX = /^(requestModule:|module:|file:|target:|time:|requestId:|status:|error:|trigger:|duration:|errorCategory:|hash:)/;
    for (const line of lines) {
      expect(line).toMatch(SAFE_PREFIX);
      expect(SECRET_KEY_PATTERN.test(line.split(':')[0]), `tooltip 行含密钥形状标签: ${line}`).toBe(false);
    }
  });

  it('HR-STATE-007 四新字段 tooltip 行安全前缀,在即列且值如实', () => {
    const lines = buildHistoryEntryTooltipLines(
      makeEntry({
        errorSummary: 'HTTP 404',
        trigger: 'retry',
        durationMs: 50,
        errorCategory: 'endpoint-unreachable',
        hash: 'a'.repeat(64)
      })
    );
    const SAFE_PREFIX = /^(requestModule:|module:|file:|target:|time:|requestId:|status:|error:|trigger:|duration:|errorCategory:|hash:)/;
    for (const line of lines) {
      expect(line).toMatch(SAFE_PREFIX);
      expect(SECRET_KEY_PATTERN.test(line.split(':')[0]), `tooltip 行含密钥形状标签: ${line}`).toBe(false);
    }
    expect(lines).toContain('trigger: retry');
    expect(lines).toContain('duration: 50ms');
    expect(lines).toContain('errorCategory: endpoint-unreachable');
    expect(lines).toContain(`hash: ${'a'.repeat(64)}`);
  });

  it('规范条目投影=已知安全行集(缺 errorSummary 无 error 行;label=fullModule)', () => {
    const lines = buildHistoryEntryTooltipLines(makeEntry());
    expect(lines).toEqual([
      'requestModule: fight.FightAI',
      'module: entities.fight.FightAI',
      'file: /ws/scripts/entities/fight/FightAI.py',
      'target: target-1',
      'time: 2023-11-14T22:13:20.000Z',
      'requestId: req-1',
      'status: applied'
    ]);
    expect(lines.some(line => line.startsWith('error:'))).toBe(false);
    expect(buildHistoryEntryLabel(makeEntry())).toBe('entities.fight.FightAI');
  });

  it('同字段集错误摘要只以 error: 前缀出现,不额外注入 header/token 行', () => {
    const lines = buildHistoryEntryTooltipLines(makeEntry({ errorSummary: 'Connection refused' }));
    const errorLines = lines.filter(line => line.startsWith('error:'));
    expect(errorLines).toEqual(['error: Connection refused']);
    expect(lines.length).toBe(8); // 7 安全字段行 + 1 error 行
  });
});
