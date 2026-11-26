import type { SyntaxVerdict } from './hotReloadSavePipeline';
import type { PythonExecOutcome, PythonExecService } from './pythonExecService';

/**
 * RUST-002 criterion 3: adapt the resident Python exec service into the compile
 * face of the hot-reload syntax gate.
 *
 * Pure core: no vscode, no child_process -- the exec service is injected via a
 * factory (the wiring surface passes the real service, tests pass a stub).
 *
 * Failure semantics must split into two paths and must not be mixed:
 * - exec service fault (infra: process exit / timeout / not ready / reply not
 *   parseable) -> **reject**, letting the hot-reload syntax gate fail open
 *   (an unavailable checker must not block hot reload);
 * - a genuine syntax error -> resolve `{ok:false, errors:[line]}` and **keep the
 *   service alive** (the process is healthy).
 * Muddling the two would let interpreter jitter silently wave hot reload through
 * as "no error", or have a syntax error swallowed as a fault.
 */
export interface ExecServiceCompileOptions {
  /** Resolve the Python interpreter path; null = unresolvable (settings/venv/PATH all missed) */
  readonly resolveInterpreter: () => string | null;
  /** Create the resident exec service; a fresh service handle per call */
  readonly createService: (interpreter: string) => PythonExecService;
}

export type ExecServiceCompile = (content: string) => Promise<SyntaxVerdict>;

export function createExecServiceCompile(options: ExecServiceCompileOptions): {
  compile: ExecServiceCompile;
  dispose: () => void;
  /** The current service handle (for tests to assert reuse/rebuild); null when not created */
  service: () => PythonExecService | null;
} {
  let service: PythonExecService | null = null;

  const release = (): void => {
    service?.dispose();
    service = null;
  };

  return {
    async compile(content): Promise<SyntaxVerdict> {
      if (!service) {
        const interpreter = options.resolveInterpreter();
        if (!interpreter) {
          throw new Error('解释器解析不到,执行服务无法启动');
        }
        service = options.createService(interpreter);
      }
      const outcome: PythonExecOutcome = await service.runCompile({ content });
      if (outcome.ok) {
        return { ok: true };
      }
      if (outcome.infra) {
        // Fault face: tear down for later rebuild, and express it as a reject per the gate's contract (fail-open)
        const error = outcome.error ?? '执行服务故障';
        release();
        throw new Error(error);
      }
      return { ok: false, ...(outcome.error !== undefined ? { errors: [outcome.error] } : {}) };
    },
    dispose: release,
    service: () => service
  };
}