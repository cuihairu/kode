import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  renderHotReloadBatchSummary,
  runHotReloadBatchSummaryCommand
} from '../src/hotReloadBatchSummaryCommand';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';

// IDE-REV-025 多目标批次聚合展示入口:台账全量按目标归并——一成一败=
// partial 点名失败目标与原因,每个目标(不论成败)的逐文件明细都渲染,
// 不以最后一个结果覆盖整批(归并遍历台账全部目标,与最近一次发到谁无关);
//无记录如实「无投递记录」;成功只到发出面口径,不冒充 applied。

const seedStore = (): HotReloadTargetStateStore => new HotReloadTargetStateStore({ now: () => 1000 });

describe('renderHotReloadBatchSummary(IDE-REV-025)', () => {
  it('一成一败:显示 partial,失败目标原因点名,成功目标明细同样可查', () => {
    const store = seedStore();
    // 目标 A:失败(带原因)
    store.record({ rootId: '/ws', targetId: 'inst-a' }, '/ws/a.py', 'failed', { detail: 'ECONNREFUSED 21345' });
    // 目标 B:发出面成功
    store.record({ rootId: '/ws', targetId: 'inst-b' }, '/ws/a.py', 'sent-unverified', {
      detail: 'HTTP 200:已送达,应用层未证实(回执不在此级解读)'
    });

    const text = renderHotReloadBatchSummary(store);
    expect(text).toContain('部分成功:1/2 个目标失败');
    expect(text).toContain('inst-a');
    expect(text).toContain('ECONNREFUSED 21345');
    expect(text).toContain('inst-b');
    expect(text).toContain('/ws/a.py → sent-unverified');
  });

  it('不以最后一个结果覆盖整批:后发的成功目标不抹掉先前失败目标', () => {
    const store = seedStore();
    store.record({ rootId: '/ws', targetId: 'old-a' }, '/ws/old.py', 'failed', { detail: 'boom' });
    // 之后又发了另一个目标(recordedAt 更晚)——归并仍要看全部目标
    store.record({ rootId: '/ws', targetId: 'new-b' }, '/ws/new.py', 'sent-unverified', { now: 2000 });

    const text = renderHotReloadBatchSummary(store);
    expect(text).toContain('部分成功');
    expect(text).toContain('old-a');
    expect(text).toContain('boom');
    expect(text).toContain('new-b');
  });

  it('同目标一文件失败一文件 applied:目标按最差面 failed,绿灯不盖红灯', () => {
    const store = seedStore();
    store.record({ rootId: '/ws', targetId: 'inst-a' }, '/ws/bad.py', 'failed', { detail: 'timeout' });
    store.record({ rootId: '/ws', targetId: 'inst-a' }, '/ws/good.py', 'applied', { detail: 'digest 一致' });

    const text = renderHotReloadBatchSummary(store);
    expect(text).toContain('全部失败(1 个目标)');
    expect(text).toContain('/ws/bad.py → failed');
    expect(text).toContain('/ws/good.py → applied');
  });

  it('全部失败:all-failed 文案点名全部目标;无记录:如实「无投递记录」', () => {
    const empty = seedStore();
    expect(renderHotReloadBatchSummary(empty)).toContain('无投递记录');

    const store = seedStore();
    store.record({ rootId: '/r1', targetId: 't1' }, '/r1/x.py', 'failed', { detail: 'e1' });
    store.record({ rootId: '/r2', targetId: 't2' }, '/r2/y.py', 'failed', { detail: 'e2' });
    const text = renderHotReloadBatchSummary(store);
    expect(text).toContain('全部失败(2 个目标)');
    expect(text).toContain('t1');
    expect(text).toContain('t2');
  });

  it('全部发出面成功:不冒充 applied,确认态以逐目标明细为准', () => {
    const store = seedStore();
    store.record({ rootId: '/ws', targetId: 't1' }, '/ws/a.py', 'sent-unverified', {});
    store.record({ rootId: '/ws', targetId: 't2' }, '/ws/a.py', 'accepted', { detail: '回执 accepted' });

    const text = renderHotReloadBatchSummary(store);
    expect(text).toContain('全部目标发出面成功(2 个)');
    expect(text).toContain('不以批次文案冒充');
    // t2 单文件 accepted:目标归并 accepted,逐文件明细如实展示
    expect(text).toContain('/ws::t2(accepted)');
  });
});

describe('runHotReloadBatchSummaryCommand(IDE-REV-025)', () => {
  it('命令体:渲染块落日志并打开通道,空台账也如实打开', () => {
    const blocks: string[] = [];
    const shown: boolean[] = [];
    const view = {
      logBlock: (text: string): void => {
        blocks.push(text);
      },
      show: (): void => {
        shown.push(true);
      }
    };
    const store = seedStore();
    store.record({ rootId: '/ws', targetId: 'inst-a' }, '/ws/a.py', 'failed', { detail: 'boom' });

    runHotReloadBatchSummaryCommand(store, view);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('全部失败');
    expect(shown).toEqual([true]);

    runHotReloadBatchSummaryCommand(seedStore(), view);
    expect(blocks[1]).toContain('无投递记录');
    expect(shown).toHaveLength(2);
  });

  it('源锁:extension.ts 注册命令并显式装配状态控制器,package.json 在册', () => {
    const extension = readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    expect(extension).toContain("'kbengine.hotReload.showBatchSummary'");
    expect(extension).toContain('runHotReloadBatchSummaryCommand');
    expect(extension).toContain('new HotReloadStatusController');

    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string }> };
      activationEvents: string[];
    };
    expect(pkg.contributes.commands.some(entry => entry.command === 'kbengine.hotReload.showBatchSummary')).toBe(true);
    expect(pkg.activationEvents).toContain('onCommand:kbengine.hotReload.showBatchSummary');
  });
});
