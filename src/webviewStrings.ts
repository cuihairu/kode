/**
 * webview 字符串表:全套 i18n(zh 默认 + en 全量)。
 *
 * 语言策略(诊断 §四 + 派单要求):
 * - 默认跟随 vscode.env.language:zh-cn/zh-tw → 中文,其余 → 英文;
 * - kbengine.webviewLocale(auto/zh/en)显式覆盖 auto。
 * 8 个 webview 面板的全部文案从 strings(locale) 取,面板内不再散落硬编码
 * 中英文。telnet 状态词与 TelnetProbeState 现有枚举一一对应(仅翻译,不
 * 改语义)。tests/webviewStrings.test.ts 强制 zh/en 键集合一致。
 */
import * as vscode from 'vscode';

export type WebviewLocale = 'zh' | 'en';
export type WebviewLocaleSetting = 'auto' | 'zh' | 'en';

const zh = {
  common: {
    refresh: '刷新',
    pause: '暂停',
    resume: '恢复',
    export: '导出数据',
    allComponents: '全部组件'
  },
  monitoring: {
    title: 'KBEngine 服务器监控',
    filterAllDiagnostics: '全部诊断',
    diagInfo: '信息',
    diagWarning: '警告',
    diagError: '错误',
    searchPlaceholder: '搜索组件/诊断...',
    second: '秒',
    historyWindow: (n: number) => `最近 ${n} 点`,
    kpiComponents: '运行组件',
    kpiEntities: '总实体数',
    kpiConnections: '总连接数',
    kpiMessages: '消息/秒',
    kpiMemory: '总内存',
    kpiCpu: '总 CPU',
    rowComponentType: '组件类型',
    rowStatus: '状态',
    rowCpu: 'CPU 使用率',
    rowMemory: '内存使用',
    rowLoad: '负载',
    rowConnections: '连接数',
    rowEntities: '实体数',
    rowMessages: '消息/秒',
    rowObjectPoolSize: '对象池容量',
    rowObjectPoolMemory: '对象池内存',
    rowUptime: (min: number) => `${min} 分钟`,
    rowPid: '进程 PID',
    rowAddress: '监听地址',
    domainProcess: '服务进程',
    domainPerformance: '性能',
    domainConnections: '连接',
    domainStorage: '存储',
    watcherDetails: 'Watcher 详情',
    objectPools: 'Object Pools',
    empty: '暂无监控数据',
    emptyHint: '启动 KBEngine 服务器后，监控数据将在此显示',
    noDiagnostics: '暂无诊断信息',
    chartCpu: 'CPU 使用率',
    chartMemory: '内存使用',
    chartLoad: '负载变化',
    chartMessages: '消息速率',
    chartObjectPoolMemory: 'Cell 对象池内存',
    chartObjectPoolSize: 'Cell 对象池容量',
    statusPrefix: '连接状态',
    autoRefreshPrefix: '自动刷新',
    pausedLabel: '已暂停'
  },
  logs: {
    title: 'KBEngine 日志',
    componentAll: '所有组件',
    groupCore: '核心服务',
    groupManager: '管理进程',
    groupGame: '游戏进程',
    searchPlaceholder: '搜索日志...',
    allLevels: '所有级别',
    clear: '清空',
    export: '导出',
    connect: '连接',
    disconnect: '断开',
    statusPrefix: '连接状态',
    statsPrefix: '显示 ',
    statsMid: ' 条日志（总计 ',
    statsSuffix: ' 条）',
    empty: '暂无日志',
    emptyHint: '启动 KBEngine 服务器后，日志将在此显示'
  },
  telnet: {
    title: 'KBEngine Telnet 探测'
  },
  runtimeQuery: {
    title: '运行时查询',
    refreshComponents: '刷新组件',
    component: '目标组件',
    watcherPath: 'Watcher 路径',
    query: '查询',
    watchList: '监视清单',
    addToWatch: '加入监视',
    startStream: '开始流式轮询',
    stopStream: '停止流式轮询',
    remove: '移除',
    watcherTab: 'Watcher 结果',
    spacesTab: 'Spaces 空间',
    colPath: '路径',
    colKind: '类型',
    colValue: '值',
    colSpaceId: 'spaceID',
    colCellappId: 'cellappID',
    colScriptModule: 'scriptModuleName',
    colCells: 'cells',
    kindValue: '数值',
    kindChild: '目录',
    emptyWatcher: '暂无 Watcher 结果。',
    emptySpaces: '暂无 Spaces 快照。',
    componentsOnline: (n: number) => `${n} 个组件在线`,
    errSelectComponent: '请先选择运行中的组件。',
    errEnterPath: '请输入 Watcher 路径。',
    errEnterPathToAdd: '请输入要加入监视的 Watcher 路径。',
    errDuplicatePath: (path: string) => `监视清单已存在该路径：${path}`,
    errStreamDisabled: '结果流默认关闭：请启用 kbengine.runtimeQuery.enabled。',
    streamHint: '流式轮询按 kbengine.runtimeQuery.pollIntervalMs(默认 2s)循环查询清单内全部路径。'
  },
  entityDependency: {
    title: '实体依赖关系'
  },
  entityFlow: {
    title: 'KBEngine 实体架构流程'
  },
  defCallChain: {
    title: 'KBEngine Def 调用链'
  },
  errorScan: {
    title: 'KBEngine ERROR 扫描'
  }
};

const en: typeof zh = {
  common: {
    refresh: 'Refresh',
    pause: 'Pause',
    resume: 'Resume',
    export: 'Export data',
    allComponents: 'All components'
  },
  monitoring: {
    title: 'KBEngine Server Monitoring',
    filterAllDiagnostics: 'All diagnostics',
    diagInfo: 'Info',
    diagWarning: 'Warning',
    diagError: 'Error',
    searchPlaceholder: 'Search components/diagnostics...',
    second: 's',
    historyWindow: (n: number) => `Last ${n} points`,
    kpiComponents: 'Running components',
    kpiEntities: 'Total entities',
    kpiConnections: 'Total connections',
    kpiMessages: 'Messages/s',
    kpiMemory: 'Total memory',
    kpiCpu: 'Total CPU',
    rowComponentType: 'Component type',
    rowStatus: 'Status',
    rowCpu: 'CPU usage',
    rowMemory: 'Memory usage',
    rowLoad: 'Load',
    rowConnections: 'Connections',
    rowEntities: 'Entities',
    rowMessages: 'Messages/s',
    rowObjectPoolSize: 'Object pool size',
    rowObjectPoolMemory: 'Object pool memory',
    rowUptime: (min: number) => `${min} min`,
    rowPid: 'Process PID',
    rowAddress: 'Listen address',
    domainProcess: 'Process',
    domainPerformance: 'Performance',
    domainConnections: 'Connections',
    domainStorage: 'Storage',
    watcherDetails: 'Watcher details',
    objectPools: 'Object Pools',
    empty: 'No monitoring data yet',
    emptyHint: 'Start the KBEngine server to see monitoring data here',
    noDiagnostics: 'No diagnostics',
    chartCpu: 'CPU usage',
    chartMemory: 'Memory usage',
    chartLoad: 'Load',
    chartMessages: 'Message rate',
    chartObjectPoolMemory: 'Cell object pool memory',
    chartObjectPoolSize: 'Cell object pool size',
    statusPrefix: 'Connection status',
    autoRefreshPrefix: 'Auto refresh',
    pausedLabel: 'Paused'
  },
  logs: {
    title: 'KBEngine Logs',
    componentAll: 'All components',
    groupCore: 'Core services',
    groupManager: 'Managers',
    groupGame: 'Game processes',
    searchPlaceholder: 'Search logs...',
    allLevels: 'All levels',
    clear: 'Clear',
    export: 'Export',
    connect: 'Connect',
    disconnect: 'Disconnect',
    statusPrefix: 'Connection status',
    statsPrefix: 'Showing ',
    statsMid: ' entries (total ',
    statsSuffix: ')',
    empty: 'No logs yet',
    emptyHint: 'Start the KBEngine server to see logs here'
  },
  telnet: {
    title: 'KBEngine Telnet Probe'
  },
  runtimeQuery: {
    title: 'Runtime Queries',
    refreshComponents: 'Refresh components',
    component: 'Target component',
    watcherPath: 'Watcher path',
    query: 'Query',
    watchList: 'Watch list',
    addToWatch: 'Add to watch list',
    startStream: 'Start stream polling',
    stopStream: 'Stop stream polling',
    remove: 'Remove',
    watcherTab: 'Watcher results',
    spacesTab: 'Spaces',
    colPath: 'Path',
    colKind: 'Kind',
    colValue: 'Value',
    colSpaceId: 'spaceID',
    colCellappId: 'cellappID',
    colScriptModule: 'scriptModuleName',
    colCells: 'cells',
    kindValue: 'value',
    kindChild: 'directory',
    emptyWatcher: 'No watcher results yet.',
    emptySpaces: 'No spaces snapshot yet.',
    componentsOnline: (n: number) => `${n} components online`,
    errSelectComponent: 'Select a running component first.',
    errEnterPath: 'Enter a watcher path.',
    errEnterPathToAdd: 'Enter a watcher path to add.',
    errDuplicatePath: (path: string) => `Watcher path already on the list: ${path}`,
    errStreamDisabled: 'Result stream is off by default; enable kbengine.runtimeQuery.enabled.',
    streamHint: 'Stream polling queries every path on the watch list each kbengine.runtimeQuery.pollIntervalMs (default 2s).'
  },
  entityDependency: {
    title: 'Entity Dependencies'
  },
  entityFlow: {
    title: 'KBEngine Entity Architecture Flow'
  },
  defCallChain: {
    title: 'KBEngine Def Call Chain'
  },
  errorScan: {
    title: 'KBEngine ERROR Scan'
  }
};

const TABLES: Record<WebviewLocale, typeof zh> = { zh, en };

export type WebviewStrings = typeof zh;

export function strings(locale: WebviewLocale): WebviewStrings {
  return TABLES[locale];
}

/** auto 规则:zh-cn/zh-tw → 中文,其余 → 英文;显式设置优先 */
export function resolveLocale(setting: string, vscodeLanguage: string): WebviewLocale {
  if (setting === 'zh') return 'zh';
  if (setting === 'en') return 'en';
  return /^zh(-|_|$)/i.test(vscodeLanguage.trim()) ? 'zh' : 'en';
}

/** 面板侧便捷读取:kbengine.webviewLocale(auto/zh/en,默认 auto)+ env.language */
export function resolvePanelLocale(): WebviewLocale {
  const setting = vscode.workspace
    .getConfiguration('kbengine')
    .get<WebviewLocaleSetting>('webviewLocale', 'auto');
  return resolveLocale(setting, vscode.env.language ?? 'en');
}

/** telnet 六态状态词:与 TelnetProbeState 枚举一一对应(仅翻译) */
export function telnetStateLabels(locale: WebviewLocale): Record<string, string> {
  return locale === 'zh'
    ? {
        unconfigured: '未配置',
        closed: '未开启',
        open: '已开启(未接会话)',
        'auth-required': '端口开·未配密码',
        'auth-rejected': '密码被拒',
        connected: '已连接'
      }
    : {
        unconfigured: 'Unconfigured',
        closed: 'Closed',
        open: 'Open',
        'auth-required': 'Auth required',
        'auth-rejected': 'Auth rejected',
        connected: 'Connected'
      };
}

/** webview <html lang> 属性值 */
export function htmlLang(locale: WebviewLocale): string {
  return locale === 'zh' ? 'zh-CN' : 'en';
}
