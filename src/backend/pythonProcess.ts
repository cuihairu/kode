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
 * The engine's true domain of the shared data dictionaries (KSEM-DATA-04/SEM-045):
 * `KBEngine.baseAppData` is registered by the baseapp process only (baseapp.cpp:461),
 * `cellAppData` by the cellapp process only (cellapp.cpp:200); `globalData` is
 * registered by every process (entity_app.h:419) and is not narrowed.
 * Returning null = visible to all processes, no process-domain filtering.
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
 * Whether a single file sits inside the dictionary's process domain: globalData is
 * always true; for a domain-bound dictionary a file role outside the domain
 * = no such module attribute at runtime (false); outside the scripts/ directory the
 * role is unknowable = do not claim it is out of domain (true, matching the
 * "do not guess" stance).
 */
export function dataDictSiteInDomain(file: string, dict: string): boolean {
  const domain = dataDictProcessDomain(dict);
  if (!domain) {
    return true;
  }
  const role = pythonProcessFromPath(file);
  return role === null ? true : domain.has(role);
}
