/**
 * RUST-357(HR-HTTP-015)端点健康账(纯函数零 vscode 零 IO):
 * - 断连/重连更新 endpoint health:传输层每次发送的可达性事实转化为健康
 *   观察记录——发送抛错(无响应)= 断连不可达;HTTP 2xx = 可达/重连;
 *   非 2xx = 端点可达但通道不健康(与 probe 同一 ok 口径:2xx 才算健康);
 * - health success ≠ 任何模块已更新成功:本账只携带传输层可达性事实,
 *   结构上没有任何模块投递字段(accepted/applied/failed 回执、台账
 *   outcome、digest 指纹都在另一条轴上,由 hotReloadChannelSend/
 *   AppliedCheck 承载)——ok:true 只说明端点可达,与「该次发送的模块
 *   是否真的应用成功」零因果,无可混用的字段面。
 *
 * 观察来源:'probe'(连通性测试,手动面)/'send'(实际发送,自动面)。
 * 发送面事实由 transport 上报(HotReloadTransport.send 三分支:抛错/
 * 非 2xx/2xx),展示面是通道状态栏灯的 note(断连红/重连绿)。
 */

import { formatReloadTransportThrownError } from './hotReloadTransportErrors';

/** 一次端点健康观察:传输层可达性事实,无任何模块投递字段 */
export interface EndpointHealthRecord {
  /** 传输层健康(2xx=ok;非 2xx/传输失败=not ok) */
  readonly ok: boolean;
  /** 事实描述(分类后的可用错误/HTTP 状态) */
  readonly detail: string;
  /** 观察时刻(ms) */
  readonly at: number;
  /** 观察来源:'probe'=连通性测试;'send'=实际发送(断连/重连自动观察) */
  readonly source: 'probe' | 'send';
}

/** 发送抛错(无响应)→ 健康记录:断连,不可达,可用错误=五分类定性 */
export function sendErrorToEndpointHealth(
  error: unknown,
  now: number = Date.now()
): EndpointHealthRecord {
  return {
    ok: false,
    detail: formatReloadTransportThrownError(error),
    at: now,
    source: 'send'
  };
}

/** 发送收到 HTTP 状态 → 健康记录:2xx=可达/重连;非 2xx=可达但不健康 */
export function sendStatusToEndpointHealth(
  status: number,
  now: number = Date.now()
): EndpointHealthRecord {
  const ok = status >= 200 && status <= 299;
  return {
    ok,
    detail: ok
      ? `端点可达(HTTP ${status})`
      : `端点可达但非 2xx(HTTP ${status})`,
    at: now,
    source: 'send'
  };
}

/** probe 结果 → 健康记录(原样 ok/detail,来源=probe) */
export function probeToEndpointHealth(
  ok: boolean,
  detail: string,
  now: number = Date.now()
): EndpointHealthRecord {
  return { ok, detail, at: now, source: 'probe' };
}
