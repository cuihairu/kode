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
