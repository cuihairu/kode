import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import * as proto from '../src/backend/kbengineProtocol';

/**
 * RUST-184 诚实面钉:Space/Watcher 协议面只做真实引擎协议的查询只读,
 * 在 mutation/subscription 支持不存在时绝不宣称支持。
 *
 * 两层:
 * ① 协议面形状——kbengineProtocol.ts 导出的 watcher/space 消息常量全是
 *    查询/回包形状(协议号审计见 src/watcherProtocolAudit.ts,IDE-LIV-002
 *    逐条钉到引擎 f85ad81);出现任何携带 mutation 动词的导出常量即红
 *    (协议面悄悄长出写通道却没有对应的引擎审计=未验证宣称)。
 * ② 文档宣称面——features 文档(英/中/指南)里任何含 space/watcher 的行
 *    不得宣称支持 mutation/subscription/订阅/写回;「尚未完成 logger
 *    watcher 协议适配」这类诚实非宣称不受影响。
 */

const REPO_ROOT = path.resolve(__dirname, '..');

const MUTATION_VERBS = [
  'set',
  'write',
  'create',
  'delete',
  'modify',
  'remove',
  'subscribe',
  'mutate',
  'update'
];

describe('RUST-184 watcher/space 协议面 query-only', () => {
  it('导出消息常量零 mutation 动词,查询面在册', () => {
    const messageNames = Object.keys(proto).filter(
      name => name.endsWith('MSG_ID') || name.endsWith('MSG_IDS')
    );
    // 非空守卫:协议模块是真导出了消息面
    expect(messageNames.length).toBeGreaterThanOrEqual(5);

    for (const name of messageNames) {
      for (const verb of MUTATION_VERBS) {
        expect(
          name.toLowerCase().includes(verb),
          `协议导出 ${name} 携带 mutation 动词 ${verb}:watcher/space 协议面只做查询只读,写通道必须先过引擎协议审计`
        ).toBe(false);
      }
    }

    // 查询面正控:watcher 逐组件查询表 + 空间快照查询在册
    expect(Object.keys(proto.WATCHER_QUERY_MSG_IDS).length).toBe(8);
    expect(proto.CELLAPPMGR_QUERY_SPACES_MSG_ID).toBe(50003);
    expect(proto.CONSOLE_WATCHER_CB_MSG_ID).toBe(65502);
  });
});

describe('RUST-184 文档不宣称 mutation/subscription', () => {
  const DOC_FILES = [
    'docs/features.md',
    'docs/zh/features.md',
    'docs/guide/features.md',
    'docs/zh/guide/features.md'
  ];

  // 宣称句式:支持/提供/启用 + mutation/subscription/订阅/写回,出现在
  // 同一段含 space/watcher 的行里。英文动词加词边界——设置名里的
  // `runtimeQuery.enabled` 不是宣称动词;诚实非宣称(「尚未完成协议适配」
  // /「不依赖 logger watcher 协议」)不匹配此句式。
  const CLAIM_PATTERN = /(?:\b(?:supports?|provides?|enables?)\b|支持)[^.]{0,48}(?:mutation|subscription|订阅|写回)/i;

  it('features 文档零 space/watcher 写面宣称', () => {
    const offenders: string[] = [];
    for (const rel of DOC_FILES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const line of text.split('\n')) {
        if (!/space|watcher/i.test(line)) {
          continue;
        }
        if (CLAIM_PATTERN.test(line)) {
          offenders.push(`${rel}: ${line.slice(0, 120)}`);
        }
      }
    }
    // 非空守卫:四个文档都在且读到了内容(防静默读空造假绿)
    expect(DOC_FILES.length).toBe(4);
    expect(
      offenders,
      `space/watcher 写面宣称回潮: ${offenders.join(' | ')}`
    ).toEqual([]);
  });
});
