// KODE-I18N-002 Notification 面:通知文案(提示/按钮)经共享 l10nText 取词。
// 两态断言:默认 = 英文源串;注入 zh-cn bundle = 中文;按钮判定随态自洽
// (取词在调用期)。botsControl/ruffLint/defAnalysisWiring 的编排摘要文案由
// 既有单测双态锚(默认英文断言)对账,键集由契约测试保障。
import { afterEach, describe, expect, it } from 'vitest';
import { setL10nBundle } from './fake-vscode/l10n';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';
import { HOT_RELOAD_NOTICE_MESSAGE, showHotReloadFirstRunNotice } from '../src/hotReloadNotice';

const zh = zhCnBundle as Record<string, string>;

afterEach(() => {
  setL10nBundle(null);
});

describe('Notification 面运行时文案(两态)', () => {
  it('hotReloadNotice:提示与按钮双语,按钮判定随态', async () => {
    expect(HOT_RELOAD_NOTICE_MESSAGE).toContain('Auto hot reload is on by default');
    const turnOffCalls: number[] = [];
    let shownButtons: string[] = [];

    const shownEn = await showHotReloadFirstRunNotice({
      isShown: () => false,
      markShown: () => {},
      show: async (_message: string, ...items: string[]) => {
        shownButtons = items;
        return items[1];
      },
      turnOff: () => {
        turnOffCalls.push(1);
      }
    });
    expect(shownEn).toBe(true);
    expect(shownButtons).toEqual(['Open logs', 'Turn off now']);
    expect(turnOffCalls).toHaveLength(1);

    setL10nBundle(zh);
    shownButtons = [];
    await showHotReloadFirstRunNotice({
      isShown: () => false,
      markShown: () => {},
      show: async (_message: string, ...items: string[]) => {
        shownButtons = items;
        return undefined;
      },
      turnOff: () => {}
    });
    expect(shownButtons).toEqual(['打开日志', '立即关闭']);
    // 消息本体为模块级常量:真实 VS Code 在激活期(取词时机)求值,与界面
    // locale 一致;测试内 bundle 后注入不改已求值常量,故只断按钮随态。
    expect(HOT_RELOAD_NOTICE_MESSAGE).toContain('Auto hot reload is on by default');
  });
});
