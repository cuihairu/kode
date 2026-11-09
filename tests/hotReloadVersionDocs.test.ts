import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { matchesHotReloadGlob } from '../src/backend/hotReloadFileVersion';
import { formatHotReloadVersionSuffix } from '../src/hotReloadStatus';
import { HOT_RELOAD_VERSION_EVENT_CAP } from '../src/backend/hotReloadTargetState';

// HOT-VER 文档对账锁:设计稿状态栏版本号节(中英)、配置指南(中英)、命令
// 指南(中英)与 src 导出互相印证——文案示例由源码格式化函数现算,防止文档与
// 实现漂移;红线表述(不新增状态/不暴露原始 token/版本号不声称已生效/版本
// 台账独立于 watcher)不得回潮或被改写。

const root = join(__dirname, '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

const design = read('docs/design/hot-reload-design.md');
const configEn = read('docs/guide/configuration.md');
const configZh = read('docs/zh/guide/configuration.md');
const commandsEn = read('docs/guide/commands.md');
const commandsZh = read('docs/zh/guide/commands.md');

describe('hot-reload-design.md 状态栏版本号节(中英)对账', () => {
  it('章节存在且中英两段都在', () => {
    expect(design).toContain('### 3.6 状态栏文件版本号(HOT-VER)');
    expect(design).toContain('> **English (status bar version badge).**');
  });

  it('状态栏文案示例由源码格式化函数现算,逐字对上', () => {
    expect(formatHotReloadVersionSuffix(3, 3)).toBe('v3');
    expect(formatHotReloadVersionSuffix(2, 3)).toBe('v2→v3');
    expect(design).toContain(`热更: 就绪 ${formatHotReloadVersionSuffix(3, 3)}`);
    expect(design).toContain(`热更: 已发送(未确认) ${formatHotReloadVersionSuffix(2, 3)}`);
    expect(design).toContain('基线/上次发送版本 → 盘上当前版本');
  });

  it('五种既有状态与版本号正交、不新增状态的表述在', () => {
    expect(design).toContain('watch-off / ready / sending / sent-unverified / failed');
    expect(design).toContain('不新增状态、不改五态原文案');
    expect(design).toContain('版本号与五种状态正交,不构成新状态');
  });

  it('版本口径:单调递增、不暴露 mtime:size 原始 token、回退不倒退', () => {
    expect(design).toContain('每文件单调递增整数');
    expect(design).toContain('`mtimeMs:size`');
    expect(design).toContain('src/sharedFileEvents.ts');
    expect(design).toContain('版本**绝不倒退**');
    expect(design).toContain('原始 token 不上屏');
  });

  it('基线随台账、applied 且 digest 与当前盘上一致才追平', () => {
    expect(design).toContain('HotReloadTargetStateStore');
    expect(design).toContain('不新开存储');
    expect(design).toContain('回执 `applied` 且 digest 与**当前盘上内容**一致时');
  });

  it('红线:未校验回执不标成功、版本号不声称已生效', () => {
    expect(design).toContain('未校验回执不标成功');
    expect(design).toContain('版本号也不声称已生效');
    expect(design).toContain('they never claim a reload took effect');
  });

  it('版本台账独立于 watcher(中英),手动触发路径点名', () => {
    expect(design).toContain('**版本台账独立于 watcher**');
    expect(design).toContain('**independent of the watcher switch**');
    expect(design).toContain('kbengine.hotReload.showFileState');
    expect(design).toContain('kbengine.hotReload.retryFailed');
    expect(design).toContain('同文件同版本逐字相等');
    expect(design).toContain('produce the same numbers for the same file as');
    expect(design).toContain('watcher 只是版本簿的默认事件来源,不是它的前提');
  });

  it('状态栏呈现:活动文档优先、回落最近变更、tooltip 多文件、点击出台账', () => {
    expect(design).toContain('「最近变更文件」');
    expect(design).toContain('tooltip 列出全部待同步文件及其版本对');
    expect(design).toContain('attempt、digest 前 8 位');
  });
});

describe('配置指南(中英)与命令指南(中英)对账', () => {
  it('中英配置指南都写明版本号与 enabled 开关正交、globs 定范围', () => {
    expect(configEn).toContain('Status-bar version numbers (HOT-VER)');
    expect(configEn).toContain('**independent of the `enabled` switch**');
    expect(configEn).toContain('byte-identical to the watched path');
    expect(configZh).toContain('状态栏版本号(HOT-VER)');
    expect(configZh).toContain('**独立于 `enabled` 开关**');
    for (const doc of [configEn, configZh]) {
      expect(doc).toContain('kbengine.hotReload.showFileState');
      expect(doc).toContain('kbengine.hotReload.retryFailed');
    }
    expect(configEn).toContain('never claim a reload took effect');
    expect(configZh).toContain('绝不声称重载已生效');
  });

  it('中英命令指南都写明点击状态栏追加版本台账', () => {
    expect(commandsEn).toContain('HOT-VER version ledger');
    expect(commandsZh).toContain('HOT-VER 版本台账');
    expect(commandsEn).toContain('digest prefix and accepted/applied/failed outcome');
    expect(commandsZh).toContain('digest 前 8 位/accepted-applied-failed 回执');
  });
});

describe('文档口径与源码互证', () => {
  it('监视范围判定只看 globs(与 enabled 正交)——文档说法与实现同口径', () => {
    // 文档承诺:globs 决定范围。实现按同一套模式判,默认 **/*.py 全深度命中
    expect(matchesHotReloadGlob('scripts/base/Account.py', ['**/*.py'])).toBe(true);
    expect(matchesHotReloadGlob('scripts/base/Account.pyc', ['**/*.py'])).toBe(false);
    expect(design).toContain('`kbengine.hotReload.globs`');
    expect(design).toContain('与 `enabled` 正交');
  });

  it('版本史事件有上限常量,文档不承诺无界历史', () => {
    expect(HOT_RELOAD_VERSION_EVENT_CAP).toBeGreaterThan(0);
    expect(design).not.toContain('完整无界');
  });
});
