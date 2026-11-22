// RUST-429（旧 HR-QA-017）「性能不达标时允许关 Watch 和回退至手动 Quick
// Requests；设置可恢复且无状态数据破坏」的**结构钉增量**。
//
// 行为面已让位于 peer 收口(2026-11-23,d20f05cf+675f54b9):关 Watch 后手动按名
// 命令经真 TCP 服务端照发(tests/httpRequestWiring.test.ts)+关分支零数据清写+
// toggle 可恢复(hotReloadStatus.test.ts 既钉)+关分支不读历史面。此处不重做行为面,
// 只补 peer 收口里**停留在散文 grep 证据、未落成可漂移门禁**的两面:
// ①手动发送面(httpRequestService/httpRequestExecutor/httpRequests/quickActions)
//   零热更配置读——把「grep 实证零耦合」升成会随代码漂移翻红的门禁;
// ②watch 生命周期面(src/hotReload.ts)零历史状态键引用——关 Watch/开关/重建
//   路径不触台账,「无状态数据破坏」由结构不成立而非由读码目测保证。
//
// 结构钉判例同 tests/hotReloadIndexIndependence.test.ts:必须配「真实耦合面」
// 自证臂,否则命中集为空时测试恒绿,守卫名存实亡。

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..', 'src');

/**
 * 热更自动面配置读/写探针(纯字符串字面匹配,`.` 即文件里真实字面点)。
 * 手动发送面命中任一探针 = 回退路径被开关面闸住,结构钉即红。
 */
const HOT_RELOAD_CONFIG_PROBES = [
  'readHotReloadSettings',
  'readHotReloadEnabled',
  'writeHotReloadEnabled',
  'hotReload.enabled',
  'hotReload.globs',
  'hotReload.triggerMode',
  'hotReload.actionName',
  'hotReload.debounceMs',
  'hotReload.tempEdit',
  'hotReload.notify'
];

/** 台账状态键:活在工作区装配面,关 Watch 与开关路径必须不触 */
const HOT_RELOAD_HISTORY_TOKENS = [
  'HOT_RELOAD_HISTORY_STATE_KEY',
  'hotReloadHistoryFeed',
  'HotReloadHistoryCore'
];

/** 手动 Quick Requests 发送面:不得读热更开关面 */
const MANUAL_SEND_SURFACE = [
  'backend/httpRequestService.ts',
  'backend/httpRequestExecutor.ts',
  'backend/httpRequests.ts',
  'quickActions.ts'
];

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
}

describe('RUST-429 结构钉:关 Watch 回退面与热更自动面零耦合(增量)', () => {
  it('手动发送面零热更配置读(自证臂=src/hotReload.ts 命中)', () => {
    const hits: Record<string, string[]> = {};
    for (const rel of MANUAL_SEND_SURFACE) {
      hits[rel] = HOT_RELOAD_CONFIG_PROBES.filter(token => read(rel).includes(token));
    }
    expect(
      Object.fromEntries(Object.entries(hits).filter(([, list]) => list.length > 0)),
      '手动发送面不得读热更开关面:关 Watch 会误伤回退面'
    ).toEqual({});

    // 自证臂:扫描器非恒绿——热更自动面必命中同一批探针
    const selfProof = HOT_RELOAD_CONFIG_PROBES.filter(token => read('hotReload.ts').includes(token));
    expect(selfProof.length, '自证臂:src/hotReload.ts 应命中热更配置探针').toBeGreaterThan(0);
  });

  it('watch 生命周期面零历史状态键引用(自证臂=src/activate/hotReload.ts 命中)', () => {
    const watchTokens = HOT_RELOAD_HISTORY_TOKENS.filter(token => read('hotReload.ts').includes(token));
    expect(
      watchTokens,
      'watch 开关/重建路径不得触历史:关 Watch 不能破坏台账状态'
    ).toEqual([]);

    // 自证臂:历史状态键确实活在装配面,证明探针不是空串自嗨
    const hostTokens = HOT_RELOAD_HISTORY_TOKENS.filter(
      token => read('activate/hotReload.ts').includes(token)
    );
    expect(hostTokens).toContain('HOT_RELOAD_HISTORY_STATE_KEY');
  });
});
