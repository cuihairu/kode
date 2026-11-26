import type { SyntaxCheck } from './hotReloadSavePipeline';

/**
 * HR-WATCH-012 syntax gate assembly core: zero vscode / zero child_process
 * imports -- interpreter resolution and real compilation come in via
 * dependency injection (the wiring layer supplies the real implementations,
 * tests supply in-memory stand-ins).
 *
 * Policy = fail-open: failures of the checker itself (interpreter not
 * resolved / subprocess will not start / timeout / exception) always let
 * things through and notify at most once; a hot reload is never blocked just
 * because the checker is unavailable. Only a clear syntax error reported by
 * the checker (ok=false) blocks. Resolution happens once at assembly time
 * (the interpreter refreshes with the config-rebuild surface), never per
 * file (a deep venv scan must not cost the hot reload path).
 */
export interface PythonSyntaxGateDeps {
  /** Resolve the Python interpreter executable; null = unresolvable (settings, venv and PATH all failed) */
  readonly resolveInterpreter: () => string | null;
  /** Real compilation surface: a subprocess runs compile() (compile only, no execution); infra failures are expressed as a reject */
  readonly compile: (
    interpreter: string,
    content: string
  ) => Promise<{ readonly ok: boolean; readonly errors?: readonly string[] }>;
  /** Checker-unavailable notification (unresolvable / subprocess failure); at most one notification per gate created */
  readonly onUnavailable?: (reason: string) => void;
}

export function createPythonSyntaxGate(deps: PythonSyntaxGateDeps): SyntaxCheck {
  let unavailableNotified = false;
  const notifyUnavailable = (reason: string): void => {
    if (unavailableNotified) {
      return;
    }
    unavailableNotified = true;
    deps.onUnavailable?.(reason);
  };
  const interpreter = deps.resolveInterpreter();
  if (!interpreter) {
    notifyUnavailable('解释器解析不到,检查器放行不拦热更');
    return () => ({ ok: true });
  }
  return async (content: string) => {
    try {
      return await deps.compile(interpreter, content);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notifyUnavailable(`编译子进程故障(${reason}),检查器放行不拦热更`);
      return { ok: true };
    }
  };
}
