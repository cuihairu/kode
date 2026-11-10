// SRC-001 L6 抽象层(KODE-ARCH 纯移动,零行为变更):热重载激活器。
// 职责(分析文档 docs/design/src-001-extension-abstraction-layers.md L6):
// 文件保存/监视 → 按名触发 quick action(G5);IDE-REV-021 双维台账记账;IDE-
// HOT-100 文件热更状态机(台账之上派生 CLEAN/DIRTY/SENT/APPLIED/FAILED/
// RESTART_REQUIRED)+ 文件树角标 + CodeLens 状态点 + 状态过滤 + 状态点点击;
// HOT-VER 文件版本簿(状态栏版本号);热更通道快速切换;重发/批次汇总/修订
// 证据命令;临时编辑热重载 quick action(HR-PR-02,accepted≠applied 铁律)。
// 形态:跨域消费面经 deps 注入——quickActionManager(views L5 返回句柄)与
// hotReloadStateViewRefresh/hotReloadVersionRefresh 前向引用 holder(组合根
// 声明,经 deps 传回,`.refresh =` 写回共享对象,区域原文零改动)。

import { onDidChangeActiveProfile, resolveActiveProfile } from '../activeProfile';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectProfileStore } from '../projectProfiles';
import {
  HOT_RELOAD_APPLIED_SETTLE_MS,
  hotReloadSectionReader,
  realHotReloadTimerDeps,
  readHotReloadSettings,
  setupHotReload,
  type HotReloadSendOptions,
  type HotReloadTargetStateWiring,
} from '../hotReload';
import { HotReloadStatusController } from '../hotReloadStatus';
import { createFileChangeRouter } from '../backend/fileChangeBypass';
import { HOT_RELOAD_CHANNEL_STATUS_PRIORITY, HotReloadChannelQuickSwitch, runHotReloadChannelConfigCommand } from '../backend/hotReloadChannelConfig';
import { HotReloadVersionTracker, matchesHotReloadGlob } from '../backend/hotReloadFileVersion';
import { resolveReloadTransport, createDefaultHotReloadChannel, type ReloadTransport } from '../backend/hotReloadTransport';
import { runHotReloadBatchSummaryCommand } from '../backend/hotReloadBatchSummaryCommand';
import { runHotReloadRetryCommand } from '../backend/hotReloadRetryCommand';
import { createDefStructuralGate } from '../backend/hotReloadDefGate';
import { runHotReloadRevisionEvidenceCommand } from '../backend/hotReloadRevisionEvidenceCommand';
import { HotReloadEngineDigestRegister } from '../backend/hotReloadRevisionEvidence';
import { HotReloadTargetStateStore } from '../backend/hotReloadTargetState';
import { HotReloadFileStateMachine } from '../backend/hotReloadFileState';
import { HotReloadFileDecorationProvider } from '../hotReloadFileDecorations';
import { HotReloadFileStateCodeLensProvider } from '../hotReloadFileStateLens';
import { runHotReloadFileStateFilterCommand, runShowHotReloadFileStateCommand } from '../backend/hotReloadFileStateFilter';
import { readTempEditReloadSettings, runTempEditReload, tempEditSectionReader } from '../backend/hotReloadTempEdit';
import type { FileChangeMetaResolver } from '../backend/fileChangeMeta';
import type { FileChangeRouter } from '../backend/fileChangeBypass';
import type { QuickActionManager } from '../quickActions';

export interface HotReloadDeps {
  context: vscode.ExtensionContext;
  quickActionManager: QuickActionManager;
  hotReloadStateViewRefresh: { refresh?: () => void };
  hotReloadVersionRefresh: { refresh?: (forceRender?: boolean) => void };
  httpRequestChannel: vscode.OutputChannel;
  fileChangeMetaResolver: FileChangeMetaResolver;
}

/** L6 共享句柄:rust 文件变化消费者接线经此消费(fileChangeRouter 原文返回) */
export interface HotReloadShared {
  fileChangeRouter: FileChangeRouter;
}

export function activateHotReload(deps: HotReloadDeps): HotReloadShared {
  const { context, quickActionManager, hotReloadStateViewRefresh, hotReloadVersionRefresh, httpRequestChannel, fileChangeMetaResolver } = deps;

  const hotReloadTargetStateStore = new HotReloadTargetStateStore({
    now: () => Date.now(),
    onRecorded: () => {
      hotReloadStateViewRefresh.refresh?.();
      // applied 回执落账 → 重采盘上版本并结算基线追平(单号/双号跟住回执)
      hotReloadVersionRefresh.refresh?.();
    }
  });
  // HOT-VER:文件版本簿(状态栏版本号)。台账独立于 watcher——监视范围只看
  // globs(与 enabled 开关正交),采样口缺省走 fs.stat 的 mtimeMs:size;watcher
  // 事件、回执落账、手动触发(showFileState/retryFailed/手动跑动作)都写同一份
  // 台账同一实现,不产生两套计数;watcher 只是它的默认事件来源,不是前提。
  const hotReloadGlobsNow = (): string[] => readHotReloadSettings(hotReloadSectionReader()).globs;
  const hotReloadRelativePath = (file: string): string | null => {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = folder.uri.fsPath;
      if (file === root) {
        return '';
      }
      if (file.startsWith(`${root}/`) || file.startsWith(`${root}${path.sep}`)) {
        return file.slice(root.length + 1);
      }
    }
    return null;
  };
  const hotReloadVersions = new HotReloadVersionTracker({
    store: hotReloadTargetStateStore,
    activeFile: () => vscode.window.activeTextEditor?.document.uri.fsPath,
    isWatched: file => {
      const relative = hotReloadRelativePath(file);
      return relative !== null && matchesHotReloadGlob(relative, hotReloadGlobsNow());
    },
    now: () => Date.now()
  });
  // IDE-REV-027 引擎 digest 证据册:fire 路径与失败目标重发的回包体都喂
  // 进来(册内判协议:非空 digest+逐字回显该文件才入册),证据展示命令读
  const hotReloadEngineDigestRegister = new HotReloadEngineDigestRegister({ now: () => Date.now() });
  // IDE-REV-025:状态控制器显式装配,批次聚合命令与状态栏/日志共用同一通道
  const hotReloadStatus = new HotReloadStatusController({
    createStatusBarItem: (alignment, priority) => vscode.window.createStatusBarItem(alignment, priority),
    createOutputChannel: name => vscode.window.createOutputChannel(name),
    registerCommand: (command, handler) => vscode.commands.registerCommand(command, handler),
    timers: realHotReloadTimerDeps,
    versions: hotReloadVersions
  });
  // 快捷切换本批:热更通道状态栏灯——显示当前通道(如 `热更:自研HTTP`),点击弹
  // 三选 QuickPick 即切,选中即探活:绿(默认底+$(plug))=通并落 profile,红
  // ($(error)+errorBackground)=不通不写盘并给「一键修=打开高级配置」。发送态灯
  // (hotReloadStatus,优先级 98)照旧只渲染发送态,通道灯走 96 不抢位不抢色;
  // profile 切换事件与配置面板写盘后都 refresh 跟住当前通道。
  const hotReloadChannelSwitch = new HotReloadChannelQuickSwitch({
    getActiveProfile: () => {
      const activeProfile = resolveActiveProfile(context.workspaceState);
      return activeProfile ? { profile: activeProfile } : null;
    },
    saveHotReload: (id, config) => new ProjectProfileStore(context.workspaceState).saveHotReload(id, config),
    createStatusBarItem: () => vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, HOT_RELOAD_CHANNEL_STATUS_PRIORITY),
    registerCommand: (command, handler) => vscode.commands.registerCommand(command, handler),
    // 红=探活不通:状态栏错误色(真 ThemeColor,主题可换;绿=默认底)
    dangerBackgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground'),
    // 一键修:带 profile id 直达该 profile 的高级配置(多步流),跳过 profile/
    // 预设首屏;写盘成功即刷新状态栏
    runAdvancedConfig: async profileId =>
      (await vscode.commands.executeCommand('kbengine.hotReload.configureChannel', {
        entry: 'advanced',
        profileId
      })) === true,
    ui: {
      showQuickPick: (items, options) => Promise.resolve(vscode.window.showQuickPick(items, { title: options.title })),
      showInformationMessage: message => Promise.resolve(vscode.window.showInformationMessage(message)),
      showErrorMessage: (message, actions) =>
        Promise.resolve(
          actions === undefined || actions.length === 0
            ? vscode.window.showErrorMessage(message)
            : vscode.window.showErrorMessage(message, ...actions)
        )
    }
  });
  context.subscriptions.push(hotReloadChannelSwitch);
  context.subscriptions.push(onDidChangeActiveProfile(() => hotReloadChannelSwitch.refresh()));

  // 重采 → 有变化才补渲染;forceRender=true 给「换了活动文档但版本没变」的场景
  // (徽标换文件本身也要重画)。渲染自身也会 kick 一次重采,两头收敛不空转。
  hotReloadVersionRefresh.refresh = (forceRender = false): void => {
    void hotReloadVersions
      .refresh()
      .then(changed => {
        if (changed || forceRender) {
          hotReloadStatus.versionsChanged();
        }
      })
      .catch(() => undefined);
  };
  // 活动文档切换 → 徽标跟住当前文档(在监视范围且已跟踪才显示它的版本)
  if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => hotReloadVersionRefresh.refresh?.(true))
    );
  }
  // IDE-HOT-100 文件热更状态机:台账之上派生 CLEAN/DIRTY/SENT/APPLIED/FAILED/
  // RESTART_REQUIRED 生命周期态(依据=内容 sha256+既有回执协议,不靠 mtime);
  // 台账是事实源,状态机是派生视图,键同形不另立身份。def 结构闸拦下经
  // setupHotReload.onRestartRequired 标进 RESTART_REQUIRED 呈现面。
  const hotReloadFileStateMachine = new HotReloadFileStateMachine({
    now: () => Date.now(),
    timeoutWindowMs: HOT_RELOAD_APPLIED_SETTLE_MS
  });
  // 无人值守动作入口:fire 路径与失败目标重发(IDE-REV-026)共用同一执行面
  const runQuickActionForHotReload = (actionName: string, sendOptions?: HotReloadSendOptions) =>
    quickActionManager.runByName(actionName, {
      suppressConfirm: true,
      ...(sendOptions?.onHttpResponse
        ? { onHttpResponse: response => sendOptions.onHttpResponse!(response) }
        : {})
    });
  // 台账接线(IDE-REV-021/023):fire 路径与失败目标重发共用同一注入面
  const hotReloadTargetStateWiring: HotReloadTargetStateWiring = {
    store: hotReloadTargetStateStore,
    resolveTargetId: async actionName => {
      if (actionName.startsWith('@script:')) {
        return actionName.slice('@script:'.length);
      }
      const tree = await quickActionManager.getTreeData();
      if (actionName.startsWith('@http:')) {
        const match = /^@http:(debug|settings):(\d+)$/.exec(actionName);
        if (!match) {
          return null;
        }
        return (
          tree.httpRequests.find(
            entry => entry.requestSource === match[1] && String(entry.requestIndex) === match[2]
          )?.target ?? null
        );
      }
      return (
        tree.registered.find(entry => entry.name === actionName)?.target ??
        tree.scripts.find(entry => entry.name === actionName)?.target ??
        null
      );
    },
    resolveRootId: file => {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const rootPath = folder.uri.fsPath;
        if (file === rootPath || file.startsWith(`${rootPath}${path.sep}`)) {
          return rootPath;
        }
      }
      return null;
    },
    // IDE-REV-023:applied 回执 digest 基准——按所发文件现内容读,读不到=null
    readFileContent: async file => {
      try {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
        return Buffer.from(data).toString('utf8');
      } catch {
        return null;
      }
    }
  };
  // RT-3(IDE-HOT-005):def 结构闸判定面 fire 与失败目标重试共用同一实例与
  // 同一会话基线册(放行即真实发送时前滚,见 F1)——重试不复用闸判定,
  // 结构性 def 变更会经「重试」通道以普通 reload 下发。
  const hotReloadDefBaselines = new Map<string, string>();
  const hotReloadDefGate = createDefStructuralGate(
    hotReloadTargetStateWiring.readFileContent,
    hotReloadDefBaselines
  );
  // F1(2026-11-05 审核):被拦批次不前滚基线,基线只随真实发送或明确重启
  // 确认建立——本命令是重启确认口:用户确认引擎已重启并加载当前 def 内容
  // 后调用,基线重建为当前内容,其上的非结构 def 变更才可走普通热更。
  context.subscriptions.push(
    vscode.commands.registerCommand('kbengine.hotReload.confirmDefBaseline', async () => {
      const confirmed = (await hotReloadDefGate.confirmLoaded?.()) ?? 0;
      hotReloadStatus.log(`def 结构基线重建(重启确认):${confirmed} 个文件基线已对齐当前内容(结构性变更仍会在下次发送前拦下)`);
      void Promise.resolve(vscode.window.showInformationMessage(`def 结构基线已对齐当前内容(${confirmed} 个文件)`)).catch(
        () => undefined
      );
    })
  );
  // IDE-HOT-102:部署通道发送口(fire 路径与失败目标重试共用同一解出口)。
  // 用户令 2026-11-10:「默认就是 http 方式,都提供默认配置」——无激活 profile
  // 或无 hotReload 段时**不再回落 actionName**,改走**默认 http 通道**:
  // url/method/headers/body 取 BUILTIN_HTTP_REQUEST_EXAMPLE(与零配置自动热更
  // 同源模板,端点在 package.json 默认值测试锁同步)。targetId 用稳定
  // 'default'(台账键 + 回执核验基准;无 profile 身份可漂移,固定串最稳)。
  // 显式 profile 配了通道仍优先(配置显式 > 默认)。
  const DEFAULT_CHANNEL_TARGET_ID = 'default';
  const resolveHotReloadChannelTransport = (): { transport: ReloadTransport; targetId: string } | null => {
    const activeProfile = resolveActiveProfile(context.workspaceState);
    if (activeProfile?.hotReload) {
      const transport = resolveReloadTransport(activeProfile.hotReload);
      if (transport) {
        return { transport, targetId: activeProfile.id };
      }
    }
    // 默认 http 通道(用户令 2026-11-10):无 profile/无 hotReload 段不回落
    // actionName,走 createDefaultHotReloadChannel 内置模板(与零配置自动
    // 热更同源端点,enabled 显式 true)。targetId 用稳定 'default'。
    const transport = resolveReloadTransport(createDefaultHotReloadChannel());
    return transport ? { transport, targetId: DEFAULT_CHANNEL_TARGET_ID } : null;
  };
  // §11.2 非 py 旁路通道的公共扩展口:这里持有路由表并交给装配——默认
  // 不注册任何消费者(= 只记录不处理);注册口 = activate 返回的
  // registerFileChangeConsumer(下面),rust 消费者的投递口固定接到
  // KodeCoreGate.notifyFileChanged(现有 LSP stdio 的 `$/kode/fileChanged`
  // 通知帧,进程未起/写失败 → false 静默降级)。
  const fileChangeRouter = createFileChangeRouter();
  setupHotReload(context, runQuickActionForHotReload, {
    fileChangeRouter,
    status: hotReloadStatus,
    targetState: hotReloadTargetStateWiring,
    defGate: hotReloadDefGate,
    // 默认热更请求(用户令 2026-11-06):未配 actionName 时保存即 POST
    // http://127.0.0.1:8090/hotfix?module_name=<模块名>,body 同带
    // module_name=<模块名>(query 与 body 双带,兼容不同服务端)。包探针与
    // HTTP 快捷请求同一口径(__init__.py 才算包段);脚本根取双名称配置,
    // 未配则回落 ${module} 包边界扫描(hotReloadDefaultHotfix 内部)。
    defaultHotfix: {
      isPackageDir: dirPath => fs.existsSync(path.join(dirPath, '__init__.py')),
      resolveScriptRoot: () =>
        vscode.workspace.getConfiguration('kbengine').get<string>('hotReload.tempEdit.scriptRoot', '') ?? ''
    },
    // 文件变化元信息(方案 B):审计行后逐文件补元信息行(module/process/
    // sha256/version),与 python 索引日志同一格式;懒异步,不阻塞发送。
    fileChangeMeta: fileChangeMetaResolver,
    noteEngineDigest: (key, file, body) => hotReloadEngineDigestRegister.note(key, file, body),
    // HOT-VER:watcher 事件 → 版本簿采样建档/跳号(版本簿的默认事件来源;
    // 手动触发路径不经这里,写同一台账同一实现,同 token 只 +1)
    onWatchedFileChange: file => {
      void hotReloadVersions
        .noteFile(file)
        .then(changed => {
          if (changed) {
            hotReloadStatus.versionsChanged();
          }
        })
        .catch(() => undefined);
    },
    // IDE-HOT-100:def 结构闸拦下 → 状态机标 RESTART_REQUIRED 呈现(与日志
    // 同源;拦下本身是 HOT-005 既有面)。targetId 经动作名反查,解不到该
    // 次如实不标(无目标身份,不虚构);rootId 逐文件解析,解不到跳过。
    onRestartRequired: (actionName, files, reasons) => {
      void Promise.resolve(hotReloadTargetStateWiring.resolveTargetId(actionName)).then(targetId => {
        if (targetId === null) {
          return;
        }
        for (const file of files) {
          const rootId = hotReloadTargetStateWiring.resolveRootId(file);
          if (rootId === null) {
            continue;
          }
          hotReloadFileStateMachine.markRestartRequired({ rootId, targetId }, [file], reasons);
        }
      });
    },
    // IDE-HOT-102:部署通道接线——当前激活 profile 配了 hotReload 段才解出
    // 通道(经 resolveReloadTransport 校验),未配返回 null,发送回落既有
    // actionName 通道。targetId=profile.id(稳定身份,台账键用,改名不漂移)。
    // 交叉修复(二轮):同一解出口给失败目标重试用——部署通道目标(profile
    // ID)失败后的重试接回同一发送通道,不再只反查 quick action 动作。
    resolveChannelTransport: resolveHotReloadChannelTransport
  });
  // IDE-HOT-102:部署级热更通道配置面板(官方/HTTP + 连通性测试)——按
  // profile 读/写 hotReload 段;未配回落既有 actionName 通道。探测只走
  // transport.probe()(经 resolveReloadTransport 建真实通道),不写 profile。
  context.subscriptions.push(
    vscode.commands.registerCommand('kbengine.hotReload.configureChannel', async (options?: { entry?: 'preset' | 'advanced'; profileId?: string }) => {
      const profileStore = new ProjectProfileStore(context.workspaceState);
      const saved = await runHotReloadChannelConfigCommand({
        listProfiles: () => profileStore.list(),
        saveHotReload: (id, config) => profileStore.saveHotReload(id, config),
        ui: {
          showQuickPick: (items, options) => Promise.resolve(vscode.window.showQuickPick(items, { title: options.title })),
          showInputBox: options =>
            Promise.resolve(vscode.window.showInputBox({ title: options.title, value: options.value, prompt: options.prompt })),
          showInformationMessage: message => Promise.resolve(vscode.window.showInformationMessage(message)),
          showErrorMessage: message => Promise.resolve(vscode.window.showErrorMessage(message))
        }
      }, options ?? {});
      // 写盘/取消都重读一次:状态栏通道灯跟住面板结果(绿/红不残留)
      hotReloadChannelSwitch.refresh();
      return saved;
    })
  );
  // IDE-REV-025:多目标批次聚合的展示入口——台账全量归并,partial 点名失败目标
  context.subscriptions.push(
    vscode.commands.registerCommand('kbengine.hotReload.showBatchSummary', () => {
      runHotReloadBatchSummaryCommand(hotReloadTargetStateStore, {
        logBlock: text => hotReloadStatus.log(text),
        show: () => hotReloadStatus.showLog()
      });
    })
  );
  // IDE-REV-026:失败目标重试的操作入口——台账里只挑失败目标经真实动作入口
  // 重发(已确认成功侧不重复投递,发送次数不增加),取消走 withProgress 进度
  // 通知令牌,取消后未发起的目标不再发送;重发落账与 fire 路径同走
  // HOT-002..004 既有面(含 accepted/applied 升格与核验窗口结算)。动作反查
  // 优先具名注册动作与扫描脚本,@http: 按索引对齐最易漂,殿后。结算句柄
  // 随命令释放一并清。
  const hotReloadRetrySettleHandles = new Set<unknown>();
  const resolveHotReloadActionNameForTarget = async (targetId: string): Promise<string | null> => {
    const tree = await quickActionManager.getTreeData();
    const registered = tree.registered.find(entry => entry.target === targetId);
    if (registered) {
      return registered.name;
    }
    const script = tree.scripts.find(entry => entry.target === targetId);
    if (script) {
      return script.name;
    }
    const http = tree.httpRequests.find(entry => entry.target === targetId);
    return http ? `@http:${http.requestSource}:${http.requestIndex}` : null;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('kbengine.hotReload.retryFailed', () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'KBEngine 热更失败目标重试', cancellable: true },
        (_progress, token) =>
          runHotReloadRetryCommand(
            hotReloadTargetStateStore,
            {
              runAction: runQuickActionForHotReload,
              resolveActionNameForTarget: resolveHotReloadActionNameForTarget,
              targetState: hotReloadTargetStateWiring,
              // 交叉修复(二轮):部署通道目标(profile ID)失败后的重试接回
              // 同一发送通道(与 fire 路径同一解出口)
              resolveChannelTransport: resolveHotReloadChannelTransport,
              noteEngineDigest: (key, file, body) => hotReloadEngineDigestRegister.note(key, file, body),
              timers: realHotReloadTimerDeps,
              settleHandles: hotReloadRetrySettleHandles,
              // RT-3(IDE-HOT-005):重发前过与 fire 路径同一 def 结构闸(同一
              // 基线册);拦下标 RESTART_REQUIRED 呈现(targetId 即台账键目标)。
              defGate: hotReloadDefGate,
              onRestartRequired: (targetId, files, reasons) => {
                for (const file of files) {
                  const rootId = hotReloadTargetStateWiring.resolveRootId(file);
                  if (rootId === null) {
                    continue;
                  }
                  hotReloadFileStateMachine.markRestartRequired({ rootId, targetId }, [file], reasons);
                }
              },
              isCancelled: () => token.isCancellationRequested
            },
            {
              logBlock: text => hotReloadStatus.log(text),
              show: () => hotReloadStatus.showLog()
            }
          )
      )
    ),
    {
      dispose: (): void => {
        for (const handle of hotReloadRetrySettleHandles) {
          realHotReloadTimerDeps.clear(handle);
        }
        hotReloadRetrySettleHandles.clear();
      }
    }
  );
  // IDE-REV-027:revision 证据展示——台账逐目标逐文件渲染三类证据,各自
  // 点名来源:fileHash=本地对当前内容 sha256 重算、semanticHash=.def 结
  // 构语义指纹(注释/空白不影响)、engineDigest=运行时回执报告(证据册按
  // 回显归属)。跨类不比较、不互相冒充;缺的种类如实缺席不填空。
  context.subscriptions.push(
    vscode.commands.registerCommand('kbengine.hotReload.showRevisionEvidence', () => {
      void runHotReloadRevisionEvidenceCommand(
        hotReloadTargetStateStore,
        {
          readFileContent: file => hotReloadTargetStateWiring.readFileContent!(file),
          digests: hotReloadEngineDigestRegister
        },
        {
          logBlock: text => hotReloadStatus.log(text),
          show: () => hotReloadStatus.showLog()
        }
      );
    })
  );

  // IDE-HOT-100 呈现:文件树角标 + 文件顶部 CodeLens 状态点 + 按状态过滤
  // (「看哪些改了还没重载」=DIRTY∪SENT)。状态机是派生视图,呈现只把视图
  // 映射成角标/lens/报告;读取与目标集经注入面。def 结构拦下(RESTART_
  // REQUIRED)与 FAILED 各有着色不混用。
  const hotReloadStateReadFile = async (file: string): Promise<string | undefined> =>
    (await hotReloadTargetStateWiring.readFileContent!(file)) ?? undefined;
  // 目标集:台账有记录目标(事实源)+ quick action 树已知 target(覆盖未发
  // 送文件,首次角标查询即注册会话基线)。树读取一次缓存,配置变更刷新。
  const hotReloadTargetCache = new Set<string>();
  const refreshHotReloadTargetCache = async (): Promise<void> => {
    hotReloadTargetCache.clear();
    try {
      const tree = await quickActionManager.getTreeData();
      for (const entry of [...tree.registered, ...tree.scripts, ...tree.httpRequests]) {
        if (entry.target) {
          hotReloadTargetCache.add(entry.target);
        }
      }
    } catch {
      // 树暂不可读:如实空集,角标只认台账事实目标
    }
  };
  void refreshHotReloadTargetCache();
  const hotReloadTargetsForRoot = (rootId: string): string[] => {
    const targets = new Set<string>(hotReloadTargetCache);
    for (const key of hotReloadTargetStateStore.targetsWithRecords()) {
      if (key.rootId === rootId) {
        targets.add(key.targetId);
      }
    }
    return [...targets];
  };
  const hotReloadFileDecorationProvider = new HotReloadFileDecorationProvider({
    stateMachine: hotReloadFileStateMachine,
    ledger: hotReloadTargetStateStore,
    resolveRootId: file => hotReloadTargetStateWiring.resolveRootId(file),
    targetsForRoot: hotReloadTargetsForRoot,
    readFileContent: hotReloadStateReadFile
  });
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(hotReloadFileDecorationProvider),
    hotReloadFileDecorationProvider
  );
  const hotReloadFileStateLensProvider = new HotReloadFileStateCodeLensProvider({
    stateMachine: hotReloadFileStateMachine,
    ledger: hotReloadTargetStateStore,
    resolveRootId: file => hotReloadTargetStateWiring.resolveRootId(file),
    targetsForRoot: hotReloadTargetsForRoot
  });
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ pattern: '**/*.{py,def}' }, hotReloadFileStateLensProvider),
    hotReloadFileStateLensProvider
  );
  // 台账落账即时刷呈现面(前向引用在 provider 建成后接上;回执落地/注解
  // 写回/重发换代都经 store.record → onRecorded 到此,角标与状态点跟住)
  hotReloadStateViewRefresh.refresh = () => {
    hotReloadFileDecorationProvider.refresh();
    hotReloadFileStateLensProvider.refresh();
  };
  // 保存后刷新角标/状态点(文件内容变化即时反映);配置变更刷新目标缓存
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      hotReloadFileDecorationProvider.refresh();
      hotReloadFileStateLensProvider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      // 与全局 configWatcher 同口径:仅 kbengine 段变更才刷,无关配置不动
      if (!event.affectsConfiguration('kbengine')) {
        return;
      }
      void refreshHotReloadTargetCache();
      hotReloadFileDecorationProvider.refresh();
      hotReloadFileStateLensProvider.refresh();
    })
  );
  // 状态过滤(注意力集=DIRTY∪SENT)与状态点点击(单文件跨目标明细)都落
  // 「KBEngine 热更新」通道,与既有热更日志同源。
  context.subscriptions.push(
    vscode.commands.registerCommand('kbengine.hotReload.filterByState', () =>
      runHotReloadFileStateFilterCommand(
        {
          stateMachine: hotReloadFileStateMachine,
          ledger: hotReloadTargetStateStore,
          readFileContent: hotReloadStateReadFile
        },
        {
          logBlock: text => hotReloadStatus.log(text),
          show: () => hotReloadStatus.showLog()
        }
      )
    ),
    vscode.commands.registerCommand('kbengine.hotReload.showFileState', (file?: string) => {
      if (typeof file !== 'string' || file.length === 0) {
        hotReloadStatus.log('无活动文件:状态点点击需带文件参数');
        return;
      }
      // HOT-VER:手动触发路径先建档采样(监视开关关也一样)再落状态明细,
      // 版本行与状态栏徽标同源——与 watcher 路径共用同一台账同一实现。
      void hotReloadVersions
        .noteFile(file)
        .catch(() => undefined)
        .then(() => {
          hotReloadStatus.versionsChanged();
          const versionLine = hotReloadVersions.describeVersion(file);
          return runShowHotReloadFileStateCommand(
            {
              stateMachine: hotReloadFileStateMachine,
              ledger: hotReloadTargetStateStore,
              readFileContent: hotReloadStateReadFile,
              resolveRootId: filePath => hotReloadTargetStateWiring.resolveRootId(filePath),
              targetsForRoot: hotReloadTargetsForRoot
            },
            {
              logBlock: text => {
                if (versionLine !== undefined) {
                  hotReloadStatus.log(versionLine);
                }
                hotReloadStatus.log(text);
              },
              show: () => hotReloadStatus.showLog()
            },
            file
          );
        });
    })
  );

  // 临时编辑热重载 quick action(书 §19 HR-PR-02):先临时编辑 → 可选自动
  // 还原 → reloadScript → 结果回显。开关默认关(与 kbengine.hotReload.enabled
  // 同口径);reloadScript 不另起第二套 HTTP,复用既有 quick action 通道
  // (HTTP 与终端两条腿都从 quickActionManager.runByName 走);回显走
  // 「KBEngine HTTP 快捷请求」OUTPUT 通道 + 独立问题通道(诊断集,成功清除)。
  // 铁律:accepted≠applied——通道回执再好也只报「已发送(未确认)」,
  // 绝不显示「已热更新」。
  const tempEditDiagnostics = vscode.languages.createDiagnosticCollection(
    'KBEngine 临时编辑热更新'
  );
  context.subscriptions.push(tempEditDiagnostics);
  const runTempEditReloadCommand = vscode.commands.registerCommand(
    'kbengine.hotReload.tempEdit.run',
    async () => {
      const settings = readTempEditReloadSettings(
        tempEditSectionReader(
          vscode.workspace.getConfiguration('kbengine').get<unknown>('hotReload', undefined)
        )
      );
      if (!settings.enabled) {
        void vscode.window.showWarningMessage(
          '临时编辑热更新已停用(默认关);确认风险后在设置 kbengine.hotReload.tempEdit.enabled 开启'
        );
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('临时编辑热更新需要活动编辑器中的文件');
        return;
      }
      const targetDoc = { fsPath: editor.document.uri.fsPath, label: path.basename(editor.document.uri.fsPath) };
      const decoder = new TextDecoder();
      const result = await runTempEditReload(targetDoc, settings, {
        readFile: async doc =>
          decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(doc.fsPath))),
        writeFile: async (doc, content) => {
          await vscode.workspace.fs.writeFile(
            vscode.Uri.file(doc.fsPath),
            new TextEncoder().encode(content)
          );
        },
        // 无人值守口径:跳过确认框,也不污染「上次执行」记忆
        runReloadAction: name =>
          quickActionManager.runByName(name, { suppressConfirm: true, skipLastRun: true }),
        log: line => httpRequestChannel.appendLine(`[临时编辑热更新] ${line}`),
        reportProblem: (doc, message) => {
          if (message === null) {
            tempEditDiagnostics.delete(editor.document.uri);
            return;
          }
          tempEditDiagnostics.set(editor.document.uri, [
            new vscode.Diagnostic(
              new vscode.Range(0, 0, 0, 1),
              `临时编辑热更新: ${message}`,
              vscode.DiagnosticSeverity.Error
            )
          ]);
        }
      });
      if (result.phase === 'sent-unverified') {
        void vscode.window.showInformationMessage(
          `临时编辑热更新:已发送(未确认)。引擎是否 applied 未知,详见输出通道「KBEngine HTTP 快捷请求」。`
        );
      } else if (result.phase !== 'missing-action') {
        void vscode.window.showErrorMessage(`临时编辑热更新失败: ${result.detail}`);
      }
    }
  );
  context.subscriptions.push(runTempEditReloadCommand);

  return {
    fileChangeRouter
  };
}
