// KODE-I18N-002 QuickPick 面:选择器标签/占位/确认项文案经共享 l10nText 取词。
// 两态断言:默认 = 英文源串;注入 zh-cn bundle = 中文。generationConfirm 的
// 确认项 label 既是选项又是比对键(取词在调用期,两态自洽);venv picker 的
// 状态栏缺失徽标两态各自可辨。
import { afterEach, describe, expect, it } from 'vitest';
import { setL10nBundle } from './fake-vscode/l10n';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';
import { confirmGenerationPlanItems } from '../src/generationConfirm';
import { interpreterStatusBarText } from '../src/backend/venvInterpreterPicker';
import { window as stubWindow } from './helpers/vscodeStub';

const zh = zhCnBundle as Record<string, string>;

/** 逐个回放 QuickPick:记录选项后返回首项(确认) */
const replayPickFirst = async (run: () => Promise<boolean>): Promise<string[]> => {
  const captured: string[] = [];
  const windowish = stubWindow as unknown as Record<string, unknown>;
  const original = windowish.showQuickPick;
  windowish.showQuickPick = async (items: unknown): Promise<unknown> => {
    const resolved = (await items) as Array<{ label: string }>;
    captured.push(...resolved.map(item => item.label));
    return resolved[0];
  };
  try {
    await run();
  } finally {
    windowish.showQuickPick = original;
  }
  return captured;
};

afterEach(() => {
  setL10nBundle(null);
});

describe('QuickPick 面运行时文案(两态)', () => {
  it('generationConfirm:确认项 label/描述双语,确认判定随态', async () => {
    const enLabels = await replayPickFirst(() => confirmGenerationPlanItems([]));
    expect(enLabels[0]).toBe('Confirm generation');
    setL10nBundle(zh);
    const zhLabels = await replayPickFirst(() => confirmGenerationPlanItems([]));
    expect(zhLabels[0]).toBe('确认生成');
  });

  it('venvInterpreterPicker:解释器缺失徽标双语', () => {
    expect(interpreterStatusBarText({ interpreterPath: null })).toBe(
      '$(circle-slash) Python interpreter missing'
    );
    setL10nBundle(zh);
    expect(interpreterStatusBarText({ interpreterPath: null })).toBe('$(circle-slash) Python 解释器缺失');
  });
});
