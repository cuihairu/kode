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
  type HttpRequestEntry,
  type PackageDirProbe
} from './httpRequests';
import { DEFAULT_HTTP_TIMEOUT_MS, defaultTransport, type HttpTransport } from './httpRequestService';
import { executeHttpRequest, type HttpRequestOutcome } from './httpRequestExecutor';
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
  /**
   * HR-MOD-008 根下单层回退(kbengine.hotReload.allowRootLevelStem):
   * 显式开 = 根直下 `Foo.py` 解析裸短名 Foo;缺省关 = 默认拒(书 §19.1
   * 「默认标 unresolved」),回落包边界扫描。默认值与零配置行为不变。
   */
  readonly allowRootLevelStem?: boolean;
}

/** 单文件的默认热更模块名:双名称优先,回落 ${module} 包边界扫描 */
export function resolveDefaultHotfixModule(filePath: string, deps: DefaultHotfixDeps = {}): string {
  const scriptRoot = deps.scriptRoot ?? '';
  if (scriptRoot.length > 0) {
    const dualName = resolveModuleDualName(filePath, scriptRoot, {
      ...(deps.allowRootLevelStem === true ? { allowRootLevelStem: true } : {})
    });
    if (!('unsupported' in dualName)) {
      return dualName.fullModule;
    }
  }
  return resolvePythonModulePath(filePath, deps.isPackageDir);
}

/**
 * 单文件的默认热更请求:模板取内置示例,url/method/body 与示例同源,
 * 只把 ${module} 换成本文件解析出的模块名。
 * HR-HTTP-002 第三参=调用方显式给定的模块身份(空串视同未给):给了就照用,
 * 不重新推导——推导与给定两套口径不混,身份以调用方给的为准。
 * HR-EXT-006 第四参=模板条目(缺省=内置示例):模板即 runtime adapter 的
 * 实现,用户自定义条目就是一份可替换实现,不与内置绑死——reload URL 只
 * 活在模板里(TS 侧单一真源),Rust Core 不写死。
 */
export function buildDefaultHotfixRequest(
  filePath: string,
  deps: DefaultHotfixDeps = {},
  moduleIdentity?: string,
  entry: HttpRequestEntry = BUILTIN_HTTP_REQUEST_EXAMPLE
): DefaultHotfixRequest {
  const module =
    moduleIdentity && moduleIdentity.length > 0
      ? moduleIdentity
      : resolveDefaultHotfixModule(filePath, deps);
  const dot = module.lastIndexOf('.');
  const vars = {
    ...buildTemplateVars(
      {
        filePath,
        scriptRoot: deps.scriptRoot && deps.scriptRoot.length > 0 ? deps.scriptRoot : undefined,
        // RUST-441/HR-DOD-002:模板双名占位与 ${module} 同参——${module} 走
        // resolveDefaultHotfixModule(带 allowRootLevelStem),${fullModule}/
        // ${reloadModule} 亦须带,否则同一模板内两个名字互不一致
        allowRootLevelStem: deps.allowRootLevelStem
      },
      deps.isPackageDir
    ),
    module,
    moduleBasename: dot === -1 ? module : module.slice(dot + 1)
  };
  const built = buildHttpRequest(entry, vars, buildOfficialVariableContext({ filePath }));
  return { url: built.url, method: built.method, headers: built.headers, body: built.body };
}

export interface DefaultHotfixSendDeps extends DefaultHotfixDeps {
  readonly transport?: HttpTransport;
  readonly timeoutMs?: number;
  /**
   * HR-EXT-006:模板条目=runtime adapter 的一个实现(用户自定义可替换)。
   * 缺省=内置示例(行为与增量前逐字一致);给了就整条用该模板的
   * url/method/headers/body,reload URL 不再绑死内置。
   */
  readonly template?: HttpRequestEntry;
  /** 每条真正发出的请求回调(装配把它落进状态栏日志通道) */
  readonly onRequest?: (request: DefaultHotfixRequest, file: string) => void;
  /**
   * HR-HTTP-002:逐文件模块身份(与 files 平行;缺省/空=按文件推导)。
   * 显式给定=模块名以调用方为准,不重推——双名称面(HR-MOD-014)调用方
   * 已知 fullModule,可直接给定,不必依赖推导路径。
   */
  readonly moduleIdentities?: readonly string[];
  /** HR-HTTP-002:请求版本(结果回执关联用;线路不携带,只作关联) */
  readonly revision?: string;
  /**
   * HR-HTTP-002:请求关联 id 种子。单文件=直接作该次执行关联 id;
   * 多文件=`${seed}#${序号}`(唯一性保留);缺省=各次执行自生成。
   */
  readonly correlationId?: string;
  /**
   * HR-HTTP-008(RUST-350)取消信号:中止逐文件发送(取消≠远端撤销,
   * 已发出的请求可能已达远端,远端状态如实未知 uncertain)。缺省无信号=
   * 不可取消(既有行为不变)。
   */
  readonly signal?: AbortSignal;
}

export interface DefaultHotfixSendResult {
  /** 全部请求都拿到 2xx 才为 true;任一失败即 false */
  readonly ok: boolean;
  /** 失败原因(逐文件拼接);ok=true 时为空串 */
  readonly detail: string;
  readonly requests: DefaultHotfixRequest[];
  /**
   * HR-HTTP-002:逐文件结构化 outcome(与 requests 平行;分类+关联 id,
   * 由执行器产物如实透传,不重分类不加工)
   */
  readonly outcomes: HttpRequestOutcome[];
  /** HR-HTTP-002:请求关联 id 回执(未给种子=无;给了=种子原样) */
  readonly correlationId?: string;
  /** HR-HTTP-002:请求版本回执(结果↔版本关联) */
  readonly revision?: string;
}

/**
 * 逐文件发送默认热更请求。传输错误与非 2xx 都算失败并如实带原因——
 * 引擎没起(ECONNREFUSED)时调用方据此报 failed,不假成功。
 * HR-HTTP-002:逐文件结构化 outcome 与请求关联 id/版本一并回传(ok/detail
 * 语义逐字不变,outcome 是附加数据不改成败判定)。
 */
export async function sendDefaultHotfix(
  files: readonly string[],
  deps: DefaultHotfixSendDeps = {}
): Promise<DefaultHotfixSendResult> {
  const transport = deps.transport ?? defaultTransport;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const seed = deps.correlationId;
  const failures: string[] = [];
  const requests: DefaultHotfixRequest[] = [];
  const outcomes: HttpRequestOutcome[] = [];
  // 逐文件顺序发送(HR-HTTP-007 默认同目标串行;并发排队归后续有界队列面),
  // 每文件一个结构化 outcome 如实收集,ok/detail 语义逐字不变。
  for (const [index, file] of files.entries()) {
    const request = buildDefaultHotfixRequest(file, deps, deps.moduleIdentities?.[index], deps.template);
    requests.push(request);
    deps.onRequest?.(request, file);
    const outcome = await executeHttpRequest(
      {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        timeoutMs
      },
      {
        transport,
        correlationId: perFileCorrelationId(seed, index, files.length),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {})
      }
    );
    outcomes.push(outcome);
    // HR-HTTP-008(RUST-350):已取消——取消≠远端撤销,请求可能已达远端
    // (甚至已应用),远端状态如实未知(uncertain);不冒充失败成因也不冒充
    // 成功。信号已中止则逐文件发送到此为止(后续文件不会再真正发出)。
    if (outcome.kind === 'cancelled') {
      failures.push(`${file}: 已取消——远端状态未知(uncertain),取消≠远端撤销`);
      if (deps.signal?.aborted) {
        break;
      }
      continue;
    }
    if (!outcome.transportOk) {
      failures.push(`${file}: ${outcome.errorMessage ?? '未知错误'}`);
      continue;
    }
    if (outcome.status < 200 || outcome.status > 299) {
      failures.push(`${file}: HTTP ${outcome.status}`);
    }
  }
  return {
    ok: failures.length === 0,
    detail: failures.join('; '),
    requests,
    outcomes,
    ...(seed !== undefined && seed.length > 0 ? { correlationId: seed } : {}),
    ...(deps.revision !== undefined && deps.revision.length > 0 ? { revision: deps.revision } : {})
  };
}

/**
 * HR-HTTP-002 关联 id 播种:单文件=种子原样;多文件=种子带序号后缀
 * (保留逐次执行关联 id 的唯一性,HR-HTTP-014「每次执行一个 id」口径)。
 * 未给种子=undefined,执行器逐次自生成(增量前行为)。
 */
function perFileCorrelationId(
  seed: string | undefined,
  index: number,
  total: number
): string | undefined {
  if (!seed || seed.length === 0) {
    return undefined;
  }
  return total === 1 ? seed : `${seed}#${index + 1}`;
}
