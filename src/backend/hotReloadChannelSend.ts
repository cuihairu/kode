/**
 * 部署通道批量发送核心(fire 路径与失败目标重试共用同一实现):
 * 发送代际在发送时点建立(transport.send 之前逐 (rootId,targetId,file) 落
 * 发起记录),冻结基准读取 await 到完成后才发起发送(冻结 digest=实际发送
 * 内容),全部回执/整组异常分支把冻结 digest 落进台账,applied 回执必须过
 * digest 双证核验才升格,未确认记录排核验窗口结算(绑定该发送自己的代际,
 * 窗口锚定发送发起时点)。呈现面(状态栏/审计行/错误上报)归调用方。
 *
 * 抽取动机(2026-11-05 二轮复审交叉修复):部署通道失败重试要接回同一发送
 * 通道——重试目标=当前部署通道目标时,重发必须走与 fire 路径逐字相同的
 * 回执流,而不是只反查 quick action 动作(找不到动作或走错通道)。
 */

import { createHash } from 'crypto';

import { HOT_RELOAD_APPLIED_SETTLE_MS, settleAppliedStatus } from './hotReloadAppliedCheck';
import type { ReloadTransport } from './hotReloadTransport';
import type {
  HotReloadDeliveryOutcome,
  HotReloadTargetKey,
  HotReloadTargetStateStore
} from './hotReloadTargetState';
import type { HotReloadTimerDeps } from '../hotReload';

export interface ReloadChannelSendDeps {
  readonly transport: ReloadTransport;
  /** 通道目标标识(如 profile id),台账键与回执 targetId 核验基准 */
  readonly targetId: string;
  readonly files: readonly string[];
  /** 文件归属扫描根解析(解不到=null:仍发送,归 '' 组,不落台账) */
  resolveRootId(file: string): string | null;
  /** 双维台账(可选;不注入则只发送不落账) */
  readonly store?: HotReloadTargetStateStore;
  /** 冻结基准读取口(可选;不注入则 applied 回执不核验,保持未确认) */
  readFileContent?(file: string): Promise<string | null>;
  readonly timers: HotReloadTimerDeps;
  /** 结算句柄集(随装配/命令释放一并清) */
  readonly settleHandles: Set<unknown>;
  readonly now: () => number;
  /** 审计五要素「谁」(触发源):watcher-auto / retry / ... */
  readonly source?: string;
}

export interface ReloadChannelSendResult {
  readonly sentCount: number;
  readonly failedCount: number;
}

/** 注解只给仍未确认的记录追加阻塞/超时原因,不动 accepted/applied/failed(与 fire 路径同款) */
const noteStillUnverified = (
  store: HotReloadTargetStateStore,
  key: HotReloadTargetKey,
  file: string,
  reason: string,
  attempt: number
): void => {
  const current = store.get(key, file);
  if (!current || current.outcome !== 'sent-unverified' || (current.detail ?? '').includes(reason)) {
    return;
  }
  store.record(key, file, 'sent-unverified', {
    detail: [current.detail, reason].filter(Boolean).join(' | '),
    now: current.recordedAt,
    attempt
  });
};

export async function sendFilesViaReloadChannel(deps: ReloadChannelSendDeps): Promise<ReloadChannelSendResult> {
  const { transport, targetId, files, timers, settleHandles, now } = deps;
  const store = deps.store;
  const channelKind = transport.kind;
  const sentAt = now();
  const keyFor = (rootId: string): HotReloadTargetKey => ({ rootId, targetId });
  // 发送代际在发送时点建立——transport.send 之前逐 (rootId,targetId,file) 落
  // 一条发送发起记录(不带 attempt=新发送,推进代际),此后全部回执/注解/
  // 核验结算绑定该代际写回(已换代则被台账拒写)。
  const attempts = new Map<string, number>();
  if (store) {
    for (const file of files) {
      const rootId = deps.resolveRootId(file);
      if (rootId === null) {
        continue;
      }
      const initiated = store.record(keyFor(rootId), file, 'sent-unverified', {
        now: sentAt,
        ...(deps.source !== undefined ? { source: deps.source } : {}),
        channel: channelKind
      });
      if (initiated) {
        attempts.set(`${rootId}\n${file}`, initiated.attempt);
      }
    }
  }
  const attemptFor = (rootId: string, file: string): number | undefined => attempts.get(`${rootId}\n${file}`);
  // 冻结基准读取 await 到完成——读取完成先于发送发起,冻结 digest=实际发送
  // 内容(此后文件再变不影响本次基准);读取失败=无基准(如实 undefined)。
  // KR-AUD-47:核验窗口锚定「发送发起时点」=冻结基准完成、transport.send 即将
  // 发起之时(与 fire 回落路径 start() 的 sentAt 同语义)——冻结读取耗时不得
  // 吃掉核验窗口;台账发起记录的 recordedAt 保持记账时刻(先于冻结),两处
  // 语义不同,不得混用。锚点在分组循环内逐组紧贴 send 取(二轮)。
  const reader = deps.readFileContent;
  const sentDigests = new Map<string, string | undefined>();
  if (reader) {
    await Promise.all(
      files.map(async file => {
        const digest = await Promise.resolve(reader(file))
          .then(content =>
            content === null || content === undefined
              ? undefined
              : createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
          )
          .catch(() => undefined);
        sentDigests.set(file, digest);
      })
    );
  }
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const rootId = store ? (deps.resolveRootId(file) ?? '') : '';
    const list = groups.get(rootId) ?? [];
    list.push(file);
    groups.set(rootId, list);
  }
  const recordOutcome = (
    rootId: string,
    file: string,
    outcome: HotReloadDeliveryOutcome,
    detail?: string,
    extra?: { sentDigest?: string }
  ): void => {
    if (!store || rootId === '') {
      return;
    }
    const attempt = attemptFor(rootId, file);
    store.record(keyFor(rootId), file, outcome, {
      ...(detail !== undefined ? { detail } : {}),
      // 回执绑定发送时点的代际写回(已换代则被台账拒写);无代际(未落发起
      // 记录,如实)才裸写
      ...(attempt !== undefined ? { attempt } : {}),
      ...(extra?.sentDigest !== undefined ? { sentDigest: extra.sentDigest } : {}),
      ...(deps.source !== undefined ? { source: deps.source } : {}),
      channel: channelKind
    });
  };
  // 冻结 digest 带进台账(绑定代际、不改写已升格的 outcome/既有 detail)——
  // sent/failed/异常分支与 accepted/applied 一样落账,台账无发送 digest 盲区
  const noteSentDigest = (rootId: string, file: string): void => {
    if (!store || rootId === '') {
      return;
    }
    const sentDigest = sentDigests.get(file);
    if (sentDigest === undefined) {
      return;
    }
    const current = store.get(keyFor(rootId), file);
    if (current) {
      recordOutcome(rootId, file, current.outcome, undefined, { sentDigest });
    }
  };
  // 基准冻结即落账(绑定该次发送代际)——回执到达与否不影响「该次实际发送
  // 内容 sha256」进台账;回执分支随后各自更新 outcome
  for (const [rootId, groupFiles] of groups) {
    if (rootId !== '') {
      for (const file of groupFiles) {
        noteSentDigest(rootId, file);
      }
    }
  }
  // 核验窗口到点结算:仍未确认只注解超时(不冒充失败也不冒充 applied);
  // 结算绑定所属发送代际,记录已换代(更新的发送在途)则不动;窗口锚定发送
  // 发起时点(KR-AUD-47:冻结完成后的 sendStartedAt,响应晚到不后移)
  const scheduleAppliedSettle = (rootId: string, file: string, anchor: number, attempt: number): void => {
    if (!store || rootId === '') {
      return;
    }
    const handle = timers.set(() => {
      settleHandles.delete(handle);
      const current = store.get(keyFor(rootId), file);
      if (!current || current.attempt !== attempt) {
        return;
      }
      const verdict = settleAppliedStatus(current, {
        deadlineMs: anchor + HOT_RELOAD_APPLIED_SETTLE_MS,
        now
      });
      if (verdict === 'unconfirmed-timeout') {
        noteStillUnverified(
          store,
          keyFor(rootId),
          file,
          `applied 核验超时(${Math.round(HOT_RELOAD_APPLIED_SETTLE_MS / 1000)}s 窗口):保持未确认`,
          attempt
        );
      }
    }, HOT_RELOAD_APPLIED_SETTLE_MS);
    settleHandles.add(handle);
  };
  let sentCount = 0;
  let failedCount = 0;
  await Promise.all(
    [...groups.entries()].map(async ([rootId, groupFiles]) => {
      // KR-AUD-47 二轮:窗口锚点紧贴本组 transport.send 发起——冻结完成后的
      // 分组/root 解析/冻结 digest 落账(同步但真实耗时)不占核验窗口;多根
      // 批次各组各取各的锚点
      const groupSendStartedAt = now();
      try {
        await transport.send(
          { rootId, targetId },
          groupFiles,
          receipt => {
          const receiptFiles = receipt.file !== undefined ? [receipt.file] : groupFiles;
          for (const file of receiptFiles) {
            const scheduleUnconfirmedSettle = (): void => {
              const attempt = attemptFor(rootId, file);
              if (attempt !== undefined) {
                scheduleAppliedSettle(rootId, file, groupSendStartedAt, attempt);
              }
            };
            switch (receipt.status) {
              case 'applied': {
                // 回执显式 targetId 与通道目标不符 → 整条不认,如实保持未确认
                if (
                  'targetId' in receipt &&
                  receipt.targetId !== undefined &&
                  receipt.targetId !== targetId
                ) {
                  recordOutcome(
                    rootId,
                    file,
                    'sent-unverified',
                    `回执 targetId(${receipt.targetId})与通道目标(${targetId})不一致:整条拒绝该回执`
                  );
                  scheduleUnconfirmedSettle();
                  break;
                }
                // 自称 applied 必须过 digest 双证核验——与发送时点冻结的所发
                // 内容 sha256 一致才升格;缺 digest/不符/无基准保持未确认并注解
                if (!reader) {
                  recordOutcome(
                    rootId,
                    file,
                    'sent-unverified',
                    'applied 回执不可信(无内容读取通道,digest 无基准):保持未确认'
                  );
                  scheduleUnconfirmedSettle();
                  break;
                }
                const sentDigest = sentDigests.get(file);
                if (sentDigest === undefined) {
                  recordOutcome(
                    rootId,
                    file,
                    'sent-unverified',
                    'applied 回执不可信(发送时点内容基准不可读):保持未确认'
                  );
                  scheduleUnconfirmedSettle();
                  break;
                }
                noteSentDigest(rootId, file);
                if (receipt.digest !== undefined && receipt.digest === sentDigest) {
                  recordOutcome(
                    rootId,
                    file,
                    'applied',
                    `applied 回执 digest 核验一致(指纹前 12 位 ${sentDigest.slice(0, 12)})`
                  );
                  break;
                }
                recordOutcome(
                  rootId,
                  file,
                  'sent-unverified',
                  'applied 回执不可信(digest 缺失或与所发内容不符):保持未确认'
                );
                scheduleUnconfirmedSettle();
                break;
              }
              case 'accepted':
                // KR-AUD-46:accepted 语义与 fire 回落路径对齐——台账同样带
                // HOT-003 注解(「应用仍需核验,仍等 applied」),不冒充终局
                // 成功;注解结算口(noteStillUnverified)两路径一致只认
                // sent-unverified,accepted 不排注解结算(派生状态机按
                // recordedAt+窗口把过期 accepted 结算为 FAILED,两路径同语义)
                recordOutcome(
                  rootId,
                  file,
                  'accepted',
                  receipt.note ?? '回执 accepted:应用仍需核验,仍等 applied(HOT-003)'
                );
                noteSentDigest(rootId, file);
                break;
              case 'failed':
                failedCount += 1;
                recordOutcome(rootId, file, 'failed', receipt.reason);
                noteSentDigest(rootId, file);
                break;
              case 'sent':
              default:
                sentCount += 1;
                recordOutcome(rootId, file, 'sent-unverified', receipt.detail);
                noteSentDigest(rootId, file);
                scheduleUnconfirmedSettle();
                break;
            }
          }
          },
          // F3 三轮:发送时点冻结的 digest 随报文下发(sender_digests),接收端
          // 对应用产物核验后才回 applied;基准不可读的文件不进下发字段
          new Map(
            [...sentDigests.entries()].filter(
              (entry): entry is [string, string] => entry[1] !== undefined
            )
          )
        );
      } catch (error: unknown) {
        // 单组失败:整组按 failed 落账(不冒充未确认),绑定发送时点代际写回
        failedCount += groupFiles.length;
        for (const file of groupFiles) {
          recordOutcome(rootId, file, 'failed', error instanceof Error ? error.message : String(error));
          noteSentDigest(rootId, file);
        }
      }
    })
  );
  return { sentCount, failedCount };
}
