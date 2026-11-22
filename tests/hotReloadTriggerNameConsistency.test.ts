import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { resolveDefaultHotfixModule } from '../src/backend/hotReloadDefaultHotfix';
import { resolveHotReloadModuleIdentity } from '../src/backend/hotReloadModuleIdentity';
import { buildRequestPreviewRows } from '../src/backend/hotReloadRequestPreview';
import { buildTemplateVars } from '../src/backend/httpRequests';
import type { HttpTransport } from '../src/backend/httpRequestService';
import { allFileSystemWatchers, configurationOverrides } from './helpers/vscodeStub';

/**
 * HR-DOD-002(RUST-441):手动命令、onSave、onDiskChange 三张触发面,对同一
 * 模块必须生成完全一致的短名(requestModule)与全名(fullModule)。
 *
 * 分工:三态都汇入同一条 fire 链(进料去抖+合并窗),模块名在下游单一解析
 * 处(resolveModuleDualName,HR-MOD-005 唯一字符串核心)才推导——触发面本身
 * 不参与命名。本套件钉住这条边界:
 *
 *   ① 线上同名(onSave 面 vs onDiskChange 面):同一文件经真实装配链两次
 *      fire,零配置默认热更面在 body 与 query 上送出的 module_name 逐字节一致。
 *   ② 命令/身份面同名:手动命令与 provider 走 HR-MOD-001 身份解析器,其
 *      requestModule/fullModule 与线上发送名逐字相等(不另推一套名)。
 *   ③ 开关面不静默分叉:allowRootLevelStem 在发送面与身份面同口径透传,
 *      同一开关下两面短名一致(根直下文件裸名 vs 包边界扫描)。
 *   ④ 两名真不同名:同文件的短名≠全名(嵌套文件),UI 面(fullModule)与
 *      请求面(requestModule)不互相冒充。
 *
 * 不重做:双名模型本体(HR-MOD-005,hotReloadTempEdit/ModuleIdentity 已有
 * 套件)、legacy `${module}` 包边界语义(HR-MOD-012 决策)、发送事实面
 * (hotReloadDefaultHotfix 已有套件)。
 */

const FILE = '/ws/scripts/entities/fight/FightAI.py';
const SHORT = 'fight.FightAI';
const FULL = 'entities.fight.FightAI';
const ROOT = '/ws/scripts';

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => number } => {
  const handles = new Map<unknown, () => void>();
  let nextHandle = 0;
  return {
    tick: () => {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
      return callbacks.length;
    },
    timers: {
      set: (callback): unknown => {
        const handle = nextHandle++;
        handles.set(handle, callback);
        return handle;
      },
      clear: (handle): void => {
        handles.delete(handle);
      }
    }
  };
};

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

const captureTransport = (): {
  transport: HttpTransport;
  seen: Array<{ url: string; body: string }>;
} => {
  const seen: Array<{ url: string; body: string }> = [];
  return {
    seen,
    transport: request => {
      seen.push({ url: request.url, body: request.body });
      return Promise.resolve({ ok: true, status: 200, durationMs: 1, body: 'ok' });
    }
  };
};

describe('HR-DOD-002 三触发面短名/全名一致性(RUST-441)', () => {
  let workspaceFoldersBackup: typeof vscode.workspace.workspaceFolders;
  let contexts: vscode.ExtensionContext[] = [];

  beforeEach(() => {
    configurationOverrides.clear();
    allFileSystemWatchers.length = 0;
    workspaceFoldersBackup = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } as never, name: 'ws', index: 0 }];
  });

  afterEach(() => {
    // 释放本用例装配:共享替身的监听器账必须在用例边界清掉
    for (const context of contexts) {
      try {
        context.subscriptions[0]?.dispose();
      } catch {
        // 释放失败不掩盖用例本身的断言
      }
    }
    contexts = [];
    vscode.workspace.workspaceFolders = workspaceFoldersBackup;
    configurationOverrides.clear();
    allFileSystemWatchers.length = 0;
  });

  /**
   * 零配置默认热更面装配:actionName 为空(走默认发送),注入传输捕包,
   * 脚本根解析固定为 /ws/scripts。triggerMode 与 disk 面按用例给。
   */
  const boot = async (mode: 'onSave' | 'onDiskChange') => {
    configurationOverrides.set('kbengine', {
      hotReload: {
        enabled: true,
        globs: ['**/*.py'],
        actionName: '',
        debounceMs: 100,
        triggerMode: mode
      }
    });
    const clock = makeTimers();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    contexts.push(context);
    const capture = captureTransport();
    setupHotReload(context, () => {
      throw new Error('本用例零配置:不应走 actionName 通道');
    }, {
      timers: clock.timers,
      ...(mode === 'onDiskChange'
        ? {
            diskWatch: {
              createWatcher: pattern => {
                const watcher = vscode.workspace.createFileSystemWatcher(pattern);
                return {
                  pattern,
                  onDidChange: cb => {
                    watcher.onDidChange(uri => cb(uri.fsPath));
                  },
                  onDidCreate: cb => {
                    watcher.onDidCreate(uri => cb(uri.fsPath));
                  },
                  onDidDelete: cb => {
                    watcher.onDidDelete(uri => cb(uri.fsPath));
                  },
                  dispose: () => watcher.dispose()
                };
              }
            }
          }
        : {}),
      defaultHotfix: {
        transport: capture.transport,
        resolveScriptRoot: () => ROOT
      }
    });
    return { clock, capture };
  };

  it('onSave 面与 onDiskChange 面:同一文件送出的 module_name 逐字节一致', async () => {
    // onSave 面:显式 glob watcher(保存落盘事件)
    const saveFace = await boot('onSave');
    const saveWatcher = allFileSystemWatchers.find(watcher => watcher.pattern === '**/*.py');
    expect(saveWatcher).toBeDefined();
    saveWatcher!.fireChange({ fsPath: FILE } as never);
    expect(saveFace.clock.tick()).toBe(2); // 进料去抖+合并窗同拍
    await flush();
    expect(saveFace.capture.seen).toHaveLength(1);

    // onDiskChange 面:外部写盘磁盘监视面(根派生递归 watcher,按 pattern 识别)
    const diskFace = await boot('onDiskChange');
    const diskWatcher = allFileSystemWatchers.find(watcher => watcher.pattern === '/ws/**/*.py');
    expect(diskWatcher).toBeDefined();
    diskWatcher!.fireChange({ fsPath: FILE } as never);
    expect(diskFace.clock.tick()).toBe(2);
    await flush();
    expect(diskFace.capture.seen).toHaveLength(1);

    const sent = [saveFace.capture.seen[0], diskFace.capture.seen[0]];
    for (const request of sent) {
      // body 与 query 双带:两面同一字符串
      expect(request.body).toBe(`module_name=${SHORT}`);
      expect(request.url).toContain(`?module_name=${SHORT}`);
    }
    // 两态逐字节相同(触发面不改名)
    expect(sent[0]?.url).toBe(sent[1]?.url);
    expect(sent[0]?.body).toBe(sent[1]?.body);
  });

  it('命令/身份面:同一文件的 requestModule/fullModule 与线上发送名逐字相等', () => {
    const identity = resolveHotReloadModuleIdentity({ fileUri: FILE, scriptRoot: ROOT });
    expect(identity.ok).toBe(true);
    if (!identity.ok) {
      throw new Error(`unexpected reject: ${identity.diagnostics.map(code => code.code).join(',')}`);
    }
    // 发送面(零配置默认热更)= 身份面的 requestModule
    expect(resolveDefaultHotfixModule(FILE, { scriptRoot: ROOT })).toBe(identity.identity.requestModule);
    expect(identity.identity.requestModule).toBe(SHORT);
    expect(identity.identity.fullModule).toBe(FULL);
  });

  it('allowRootLevelStem 两面同口径透传:根直下文件短名一致,不静默分叉', () => {
    const rootFile = '/ws/scripts/Lone.py';
    const probe = (dir: string): boolean => dir === ROOT;
    // 键关(缺省):发送面如实回落包边界扫描(scripts 带 __init__.py → scripts.Lone);
    // 身份面如实报 unresolved(root-level)——两契约有意不同(发送面尽力给名,
    // 身份面不静默回落),不一致不是 bug,本用例只钉键开两态。
    const offSend = resolveDefaultHotfixModule(rootFile, { scriptRoot: ROOT, isPackageDir: probe });
    const offIdentity = resolveHotReloadModuleIdentity({ fileUri: rootFile, scriptRoot: ROOT });
    expect(offSend).toBe('scripts.Lone');
    expect(offIdentity.ok).toBe(false); // 根下拒=如实 unresolved(HR-MOD-008)
    if (!offIdentity.ok) {
      expect(offIdentity.diagnostics.map(code => code.code)).toContain('root-level');
    }
    // 键开:两面同送裸短名(HR-MOD-008 显式开关,两面同口径透传)
    const onSend = resolveDefaultHotfixModule(rootFile, {
      scriptRoot: ROOT,
      isPackageDir: probe,
      allowRootLevelStem: true
    });
    const onIdentity = resolveHotReloadModuleIdentity({
      fileUri: rootFile,
      scriptRoot: ROOT,
      allowRootLevelStem: true
    });
    expect(onIdentity.ok).toBe(true);
    if (onIdentity.ok) {
      expect(onSend).toBe(onIdentity.identity.requestModule);
      expect(onSend).toBe('Lone');
    }
    // 键关≠键开:同一文件两态本就该不同名,不能当成分叉
    expect(offSend).not.toBe(onSend);
  });

  it('预览面/模板变量面:短名与全名同口径,且真为两名(不互相冒充)', () => {
    const rows = buildRequestPreviewRows({ file: FILE, entries: [], scriptRoot: ROOT });
    const names = rows[0]!.moduleNames;
    expect(names.requestModule).toBe(SHORT);
    expect(names.fullModule).toBe(FULL);

    const vars = buildTemplateVars({ filePath: FILE, scriptRoot: ROOT });
    expect(vars.reloadModule).toBe(SHORT);
    expect(vars.fullModule).toBe(FULL);
    // 短名≠全名(嵌套文件);全名才是 UI 展示名,短名才进 module_name
    expect(SHORT).not.toBe(FULL);
    expect(FULL.startsWith('entities.')).toBe(true);
    expect(SHORT).not.toContain('entities.');
  });
});