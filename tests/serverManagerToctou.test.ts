import type * as vscode from 'vscode';
import * as fsActual from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KBEngineServerManager, SERVER_COMPONENTS } from '../src/serverManager';
import { messages } from './helpers/vscodeStub';

// KR-AUD-48:配置目录存在性检查原为 existsSync+statSync 两段式——检查间隙
// 目录被删/被换时 statSync 裸抛(未捕获异常直达 webview/调用方)。验收口径:
// 单次 statSync 判存在(stat 入 try),消失时回落既有友好报错文案。
// fs 不可 spyOn(namespace 属性不可配置),本文件整体 vi.mock('fs')为桥接替身:
// 默认全透传真实 fs(vi.importActual 留存的 pristine 引用),个别用例再翻转到
// 故障注入;恢复时必须走 pristine 引用——文件内 import * as fsActual 拿到的
// 已是替身,再透传会无限递归。

const fsPristine = vi.hoisted(() => ({ fs: null as typeof import('fs') | null }));

const fsBridge = {
  existsSync: (...args: Parameters<typeof import('fs').existsSync>) =>
    fsPristine.fs!.existsSync(...args),
  statSync: (...args: Parameters<typeof import('fs').statSync>) =>
    fsPristine.fs!.statSync(...args)
};

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  fsPristine.fs = actual;
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => fsBridge.existsSync(...args),
    statSync: (...args: Parameters<typeof actual.statSync>) => fsBridge.statSync(...args)
  };
});

const makeManager = () =>
  new KBEngineServerManager({} as unknown as vscode.ExtensionContext);

describe('KR-AUD-48: 配置目录存在性检查为单次 stat(TOCTOU 安全)', () => {
  afterEach(() => {
    const real = fsPristine.fs!;
    fsBridge.existsSync = (...args) => real.existsSync(...args);
    fsBridge.statSync = (...args) => real.statSync(...args);
    messages.error.length = 0;
  });

  it('existsSync 通过后 statSync 前目录被删:回落友好报错,不裸抛', async () => {
    // 故障注入面:existsSync 恒真(模拟「检查时还在」),statSync 抛 ENOENT
    // (模拟「stat 时已被删」)——两段式实现会在此裸抛,单次 stat 实现应吞掉
    // 并走「找不到 KBEngine 配置目录」既有文案。
    fsBridge.existsSync = () => true as unknown as boolean;
    fsBridge.statSync = () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, stat '/gone'"), { code: 'ENOENT' });
    };
    const manager = makeManager();
    // 直接钉死配置目录,绕开探测链(本用例只关心存在性检查段)
    (manager as unknown as { getConfigPath: () => string }).getConfigPath = () => '/gone/config';
    await expect(manager.startComponent(SERVER_COMPONENTS[0])).resolves.toBe(false);
    expect(messages.error.some(m => m.includes('找不到 KBEngine 配置目录'))).toBe(true);
  });

  it('单次 stat 口径下:存在但不是目录 → 「不是目录」既有文案(真实 fs 透传不回归)', async () => {
    const real = fsPristine.fs!;
    fsBridge.existsSync = (...args) => real.existsSync(...args);
    fsBridge.statSync = (...args) => real.statSync(...args);
    const filePath = path.join(os.tmpdir(), `kb-aud48-${process.pid}-${Date.now()}.txt`);
    fsActual.writeFileSync(filePath, 'x');
    try {
      const manager = makeManager();
      (manager as unknown as { getConfigPath: () => string }).getConfigPath = () => filePath;
      // 可执行文件钉到真实存在的 node 二进制,让流程推进到配置目录检查段
      (manager as unknown as { getExecutablePath: () => string }).getExecutablePath = () => process.execPath;
      await expect(manager.startComponent(SERVER_COMPONENTS[0])).resolves.toBe(false);
      expect(messages.error.some(m => m.includes('不是目录'))).toBe(true);
    } finally {
      fsActual.unlinkSync(filePath);
    }
  });
});
