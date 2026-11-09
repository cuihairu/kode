// SRC-001 L1 抽象层(KODE-ARCH 纯移动,零行为变更):组合根的共享核心服务激活器。
// 职责(分析文档 docs/design/src-001-extension-abstraction-layers.md L1):
// indexScheduler(统一索引调度:交互/后台分队,后台任务受交互限流)、
// entityMappingManager(实体映射:watcher/首扫/Python 方法索引,deferStartup
// 工作区门控)、dataDictIndex(数据字典键索引单例:globalData/baseAppData/
// cellAppData 键写读互链,懒建)。
// 形态:deps 显式注入,共享实例与销毁句柄一并返回,销毁所有权仍由组合根
// 统一登记;装配顺序由组合根调用点保持——本层先于诊断调度块与语言 provider
// 装配(dataDictIndex 约束「hover 构造需注入」由调用序保证)。
// 拆分注:dataDictIndex 原装配位在 hover 装配之前( hover/definition/inlay/
// references 注入点之前),构造懒建零副作用,提前到本激活器不改变任何可见
// 行为;indexScheduler/entityMappingManager 装配位与原位一致。
import * as vscode from 'vscode';
import { EntityMappingManager } from '../entityMapping';
import { GlobalDataDictIndex } from '../globalDataIndex';
import { IndexScheduler, IndexTaskPriority } from '../backend/indexScheduler';
import { setTypeStorageUsageBackgroundDispatcher } from '../databaseSchema';

export interface CoreServicesDeps {
  context: vscode.ExtensionContext;
}

/** L1 产出的共享实例——后续抽象层经组合根注入消费 */
export interface CoreServicesShared {
  indexScheduler: IndexScheduler;
  entityMappingManager: EntityMappingManager;
  dataDictIndex: GlobalDataDictIndex;
}

export function activateCoreServices(
  deps: CoreServicesDeps
): CoreServicesShared & { disposables: vscode.Disposable[] } {
  const { context } = deps;
  const disposables: vscode.Disposable[] = [];
  // 初始化实体映射管理器(用户令 2026-10-21 内建属性单:补全的 def 归属面
  // 兜底也走 manager,故提到补全注册之前)
  // PR3/PR5:统一索引调度器实例化一次共享——EntityMappingManager 首扫与
  // PythonClassIndex 文件发现/分块解析都经它入队,后台任务受交互限流。
  const indexScheduler = new IndexScheduler();
  disposables.push({ dispose: () => indexScheduler.dispose() });
  // SCH-009 冷路径退交互线程:types.xml 用法索引的冷构建(整仓读)派发到
  // 统一调度器 non-interactive 队列——交互线程冷读只回空表并登记后台构建,
  // CodeLens 由 onTypeStorageUsageIndexPublished 回调失效重算,不再首击
  // 同步整仓扫描。
  setTypeStorageUsageBackgroundDispatcher(run =>
    indexScheduler.enqueue({
      kind: 'non-interactive',
      priority: IndexTaskPriority.NonInteractive,
      run
    }).wait
  );
  // 书 PR-002 工作区门控:deferStartup=true → 构造零副作用(不建 watcher、
  // 不入队全量首扫)。是否启动由 shouldStartKbEngineIndexing() 的特征探测决定:
  // 有 .def/entities.xml/types.xml/alias.xml/kbengine*.xml 之一即启动(与门控前
  // 逐行为一致);无特征的纯 Python 工作区零后台扫描零 watcher,查询入口的
  // ensureStartup() 幂等兜底保证结果口径不变(fail-open:探测异常按放行处理)。
  const entityMappingManager = new EntityMappingManager(context, indexScheduler, {
    deferStartup: true
  });

  // GLOBDATA-001/002:数据字典键索引单例(globalData/baseAppData/cellAppData
  // 键写/读点互链)。懒建(首查 ensureStarted),extension 生命周期随订阅
  // 释放;definition/references/inlay/hover 共用同一实例与内存倒排。置于
  // hover 装配之前(hover 构造需注入)。
  const dataDictIndex = new GlobalDataDictIndex();
  disposables.push({ dispose: () => dataDictIndex.dispose() });
  return {
    disposables,
    indexScheduler,
    entityMappingManager,
    dataDictIndex
  };
}
