/**
 * 默认热更请求(用户令 2026-11-06):新工作区零配置时,保存 .py 即向
 * `http://127.0.0.1:8090/hotfix?module_name=<模块名>` 发一条 POST,body 同带
 * `module_name=<模块名>`——query 与 body 各带一份,兼容读 query / 读 body 的
 * 不同服务端实现,同值重复无害。
 *
 * - 端点与参数名取自内置示例(BUILTIN_HTTP_REQUEST_EXAMPLE,测试锁同步),
 *   两处不各写一份,避免默认值漂移;query 的 `?module_name=` 与 body 的
 *   `module_name=` 同源于该示例,双带口径不在此另写;
 * - 模块名优先 resolveModuleDualName 口径(书 §19.1,file-change-meta 同源);
 *   未配脚本资源根(kbengine.hotReload.tempEdit.scriptRoot)或解析不支持时,
 *   回落 ${module} 的 __init__.py 包边界扫描——与默认示例模板同一占位来源,
 *   不新造占位;
 * - 传输事实决定成败:连接拒绝/超时/非 2xx 一律如实 ok=false 并带原因,
 *   绝不把「发出去了」说成「已生效」。
 */

import {
  BUILTIN_HTTP_REQUEST_EXAMPLE,
  buildHttpRequest,
  buildOfficialVariableContext,
  buildTemplateVars,
  resolvePythonModulePath,
  type PackageDirProbe
} from '../httpRequests';
import { DEFAULT_HTTP_TIMEOUT_MS, defaultTransport, type HttpTransport } from '../httpRequestService';
import { resolveModuleDualName } from './hotReloadTempEdit';

export interface DefaultHotfixRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface DefaultHotfixDeps {
  /** 脚本资源根(双名称解析起点);空串 = 未配置,回落包边界扫描 */
  readonly scriptRoot?: string;
  /** Python 包目录探针(目录含 __init__.py 判定),${module} 回落面用 */
  readonly isPackageDir?: PackageDirProbe;
}

/** 单文件的默认热更模块名:双名称优先,回落 ${module} 包边界扫描 */
export function resolveDefaultHotfixModule(filePath: string, deps: DefaultHotfixDeps = {}): string {
  const scriptRoot = deps.scriptRoot ?? '';
  if (scriptRoot.length > 0) {
    const dualName = resolveModuleDualName(filePath, scriptRoot);
    if (!('unsupported' in dualName)) {
      return dualName.fullModule;
    }
  }
  return resolvePythonModulePath(filePath, deps.isPackageDir);
}

/**
 * 单文件的默认热更请求:模板取内置示例,url/method/body 与示例同源,
 * 只把 ${module} 换成本文件解析出的模块名。
 */
export function buildDefaultHotfixRequest(
  filePath: string,
  deps: DefaultHotfixDeps = {}
): DefaultHotfixRequest {
  const module = resolveDefaultHotfixModule(filePath, deps);
  const dot = module.lastIndexOf('.');
  const vars = {
    ...buildTemplateVars({ filePath }, deps.isPackageDir),
    module,
    moduleBasename: dot === -1 ? module : module.slice(dot + 1)
  };
  const built = buildHttpRequest(BUILTIN_HTTP_REQUEST_EXAMPLE, vars, buildOfficialVariableContext({ filePath }));
  return { url: built.url, method: built.method, headers: built.headers, body: built.body };
}

export interface DefaultHotfixSendDeps extends DefaultHotfixDeps {
  readonly transport?: HttpTransport;
  readonly timeoutMs?: number;
  /** 每条真正发出的请求回调(装配把它落进状态栏日志通道) */
  readonly onRequest?: (request: DefaultHotfixRequest, file: string) => void;
}

export interface DefaultHotfixSendResult {
  /** 全部请求都拿到 2xx 才为 true;任一失败即 false */
  readonly ok: boolean;
  /** 失败原因(逐文件拼接);ok=true 时为空串 */
  readonly detail: string;
  readonly requests: DefaultHotfixRequest[];
}

/**
 * 逐文件发送默认热更请求。传输错误与非 2xx 都算失败并如实带原因——
 * 引擎没起(ECONNREFUSED)时调用方据此报 failed,不假成功。
 */
export async function sendDefaultHotfix(
  files: readonly string[],
  deps: DefaultHotfixSendDeps = {}
): Promise<DefaultHotfixSendResult> {
  const transport = deps.transport ?? defaultTransport;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const failures: string[] = [];
  const requests: DefaultHotfixRequest[] = [];
  for (const file of files) {
    const request = buildDefaultHotfixRequest(file, deps);
    requests.push(request);
    deps.onRequest?.(request, file);
    const result = await transport({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      timeoutMs
    });
    if (!result.ok) {
      failures.push(`${file}: ${result.error ?? '未知错误'}`);
      continue;
    }
    if (result.status < 200 || result.status > 299) {
      failures.push(`${file}: HTTP ${result.status}`);
    }
  }
  return { ok: failures.length === 0, detail: failures.join('; '), requests };
}
