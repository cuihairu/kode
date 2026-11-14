import type { SyntaxVerdict } from './hotReloadSavePipeline';
import type { PythonExecOutcome, PythonExecService } from './pythonExecService';

/**
 * RUST-002 判据③：把常驻 Python 执行服务适配成热更语法闸的 compile 面。
 *
 * 纯核:零 vscode、零 child_process——执行服务经工厂注入(装配面给真服务,
 * 测试给替身)。
 *
 * 失败语义必须分两路,不能混:
 * - 执行服务故障(infra:进程退出/超时/未就绪/回包不可解析)→ **reject**,
 *   交给热更语法闸走 fail-open(检查器不可用不得拦热更);
 * - 真语法错误 → resolve `{ok:false, errors:[行]}`,**不拆服务**(进程健康)。
 * 混为一谈会让解释器抖动把热更静默放行成「无错」,或让语法错误被当成故障吞掉。
 */
export interface ExecServiceCompileOptions {
  /** 解析 Python 解释器路径;null=解析不到(设置/venv/PATH 全落空) */
  readonly resolveInterpreter: () => string | null;
  /** 建常驻执行服务;每次调用一个新服务句柄 */
  readonly createService: (interpreter: string) => PythonExecService;
}

export type ExecServiceCompile = (content: string) => Promise<SyntaxVerdict>;

export function createExecServiceCompile(options: ExecServiceCompileOptions): {
  compile: ExecServiceCompile;
  dispose: () => void;
  /** 当前服务句柄(测试断言复用/重建);未建时 null */
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
        // 故障面:拆掉待重建,并按闸门口契约以 reject 表达(fail-open)
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