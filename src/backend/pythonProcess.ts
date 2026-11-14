/** Directory roles are distinct from engine component names. Shared by all
 * Python consumers; process-api.json is generated from the shipped .pyi files
 * and is embedded by the Rust implementation too. */
export type PythonProcess = 'base' | 'cell' | 'bots' | 'client' | 'dbmgr' | 'interfaces' | 'logger' | 'loginapp';

export interface ProcessApiSymbol {
  name: string;
  kind: 'function' | 'class' | 'variable';
  signature: string;
  sourceFile?: string;
  sourceLine?: number;
}

// require keeps author-time JSON outside tsc's src/rootDir while esbuild embeds
// the exact same JSON used by Rust. No runtime filesystem lookup is performed.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- embed-time JSON outside tsc rootDir; import would fail rootDir check
const processApi = require('../../typings/process-api.json') as Record<PythonProcess, {
  component: string; symbols: ProcessApiSymbol[];
}>;
export const PYTHON_PROCESSES = Object.keys(processApi) as PythonProcess[];

export function pythonProcessFromPath(file: string): PythonProcess | null {
  const parts = file.replace(/\\/g, '/').split('/');
  // Anchor to scripts, never to arbitrary ancestor directories named base/cell.
  const index = parts.lastIndexOf('scripts');
  if (index < 0) { return null; }
  const directory = parts[index + 1];
  const role = directory === 'baseapp' ? 'base' : directory === 'cellapp' ? 'cell' : directory;
  return PYTHON_PROCESSES.includes(role as PythonProcess) ? role as PythonProcess : null;
}

export function processApiSymbols(process: PythonProcess): readonly ProcessApiSymbol[] {
  return processApi[process].symbols as ProcessApiSymbol[];
}

export function processStubRoot(stubRoot: string, process: PythonProcess): string {
  return `${stubRoot.replace(/[\\/]+$/, '')}/${process}`.replace(/\\/g, '/');
}

/**
 * 共享数据字典的引擎真域(KSEM-DATA-04/SEM-045):`KBEngine.baseAppData`
 * 仅 baseapp 进程注册(baseapp.cpp:461)、`cellAppData` 仅 cellapp 进程注册
 * (cellapp.cpp:200);`globalData` 全进程注册(entity_app.h:419)不收窄。
 * 返回 null = 全进程可见,不做进程域过滤。
 */
export function dataDictProcessDomain(dict: string): ReadonlySet<PythonProcess> | null {
  if (dict === 'baseAppData') {
    return new Set<PythonProcess>(['base']);
  }
  if (dict === 'cellAppData') {
    return new Set<PythonProcess>(['cell']);
  }
  return null;
}

/**
 * 单文件是否在字典进程域内:globalData 恒真;域化字典的文件角色不在域内
 * = 运行期无此模块属性(false);scripts/ 目录之外角色不可知 = 不声称出域
 * (true,与「不猜」口径一致)。
 */
export function dataDictSiteInDomain(file: string, dict: string): boolean {
  const domain = dataDictProcessDomain(dict);
  if (!domain) {
    return true;
  }
  const role = pythonProcessFromPath(file);
  return role === null ? true : domain.has(role);
}
