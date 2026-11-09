// KODE-I18N-002 QuickPick 面:选择器标签/占位/确认项文案经共享 l10nText 取词。
// 两态断言:默认 = 英文源串;注入 zh-cn bundle = 中文。generationConfirm 的
// 确认项 label 既是选项又是比对键(取词在调用期,两态自洽);venv picker 的
// 状态栏缺失徽标两态各自可辨。
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setL10nBundle } from './fake-vscode/l10n';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';
import { confirmGenerationPlanItems } from '../src/generationConfirm';
import { interpreterStatusBarText } from '../src/backend/venvInterpreterPicker';
import { fetchHttp, quickActionConfirmLabel } from '../src/quickActions';
import { importExistingProject } from '../src/projectImport';
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

  // UX-REVIEW-010c:快速执行确认按钮与 HTTP 执行器错误两态(按钮既作展示又作
  // 比对键,取词在调用期,两态自洽;错误保留 URL/协议/超时的诊断价值)
  it('quickActions:确认按钮与执行器错误双语,判定随态', async () => {
    expect(quickActionConfirmLabel()).toBe('Run');
    await expect(fetchHttp({ url: 'not a url', method: 'GET' })).rejects.toThrow(
      'Cannot parse URL: not a url'
    );
    setL10nBundle(zh);
    expect(quickActionConfirmLabel()).toBe('执行');
    await expect(fetchHttp({ url: 'not a url', method: 'GET' })).rejects.toThrow(
      'URL 无法解析: not a url'
    );
  });

  // UX-REVIEW-010e:项目导入确认项 label 与比对共用调用期取词(010d 同约定),
  // 两态各自走通同一导入流程;zh 态选择器按「导入」选中确认项即完成导入——
  // 若取词冻结在模块加载期(英文源串),zh 态找不到确认项,流程止步=红。
  it('projectImport:确认项 label/判定双语,zh 态按「导入」走通导入', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-qpick-import-'));
    fs.mkdirSync(path.join(base, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(base, 'entities.xml'), '<root/>', 'utf8');
    const windowish = stubWindow as unknown as Record<string, unknown>;
    const originalOpen = windowish.showOpenDialog;
    const originalPick = windowish.showQuickPick;
    const originalInfo = windowish.showInformationMessage;
    const originalWarn = windowish.showWarningMessage;
    const infos: string[] = [];
    let confirmLabels: string[] = [];
    const store = new Map<string, unknown>();
    const memento = {
      get: (key: string, defaultValue?: unknown): unknown =>
        store.has(key) ? store.get(key) : defaultValue,
      update: (key: string, value: unknown): Promise<void> => {
        if (value === undefined) {
          store.delete(key);
        } else {
          store.set(key, value);
        }
        return Promise.resolve();
      }
    };
    windowish.showOpenDialog = async () => [{ fsPath: base }];
    windowish.showQuickPick = async (items: unknown): Promise<unknown> => {
      const resolved = (await items) as Array<{ label: string }>;
      confirmLabels = resolved.map(item => item.label);
      // 按当前语言确认项选中(zh 态=「导入」):label 与判定同源才有此匹配
      return resolved.find(item => item.label === '导入');
    };
    windowish.showInformationMessage = async (message: string): Promise<unknown> => {
      infos.push(message);
      return undefined;
    };
    windowish.showWarningMessage = async (): Promise<unknown> => undefined;
    try {
      // 英文态:确认项 = Import,但按「导入」选不中 → 流程止步零写入
      await importExistingProject({ workspaceState: memento as never });
      expect(confirmLabels[0]).toBe('Import');
      expect(infos).toHaveLength(0);
      // 中文态:确认项 = 导入,按「导入」选中 → 导入完成带中文成功提示
      setL10nBundle(zh);
      await importExistingProject({ workspaceState: memento as never });
      expect(confirmLabels[0]).toBe('导入');
      expect(infos.at(-1)).toContain('已导入项目 profile');
    } finally {
      windowish.showOpenDialog = originalOpen;
      windowish.showQuickPick = originalPick;
      windowish.showInformationMessage = originalInfo;
      windowish.showWarningMessage = originalWarn;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
