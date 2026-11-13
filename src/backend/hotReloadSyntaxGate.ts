import type { SyntaxCheck } from './hotReloadSavePipeline';

/**
 * HR-WATCH-012 语法闸装配核:零 vscode/零 child_process 导入——解释器解析
 * 与真编译经依赖注入(装配面给真实现,测试给内存替身)。
 *
 * 策略=fail-open:检查器自身故障(解释器解析不到/子进程起不来/超时/异常)
 * 一律放行并至多通知一次,绝不因检查器不可用拦热更;只有检查器明确报
 * 语法错误(ok=false)才拦。解析在装配时做一次(解释器随配置重建面刷新),
 * 不逐文件解析(venv 深扫成本不进热更链路)。
 */
export interface PythonSyntaxGateDeps {
  /** 解析 Python 解释器可执行文件;null=解析不到(设置/venv/PATH 全落空) */
  readonly resolveInterpreter: () => string | null;
  /** 真编译面:子进程跑 compile()(只编译不执行);infra 失败以 reject 表达 */
  readonly compile: (
    interpreter: string,
    content: string
  ) => Promise<{ readonly ok: boolean; readonly errors?: readonly string[] }>;
  /** 检查器不可用通知(解析不到/子进程故障);每次创建的闸至多通知一次 */
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
