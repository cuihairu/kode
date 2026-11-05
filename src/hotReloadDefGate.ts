/**
 * def 结构闸判定面(IDE-HOT-005 / RT-3 复用):把「批内 .def 逐文件对比
 * 引擎已加载版本的结构指纹,结构性/无基线/不可读/无读取通道一律拦下」
 * 这一判定抽成独立模块,fire 路径(setupHotReload)与失败目标重试
 * (hotReloadRetryCommand)共用同一实例与同一基线册——重试不复用闸判定
 * 就会让结构性 def 变更经「重试」通道以普通 reload 下发(RT-3)。
 *
 * F1(2026-11-05 审核):基线=目标引擎当前已加载的结构版本,只在两种
 * 时机前滚/建立——
 *  1. commit:批次通过闸判定且即将真实发送时,由调用方显式前滚到本次所
 *     发内容(目标即将加载的版本);
 *  2. confirmLoaded:用户明确重启确认(引擎已加载当前内容)后重建基线。
 * 被拦批次(结构性/无基线/不可读)绝不前滚基线:否则第一次拦截即把基线
 * 滚到未加载内容,第二次发送同一内容(或其非结构变体)指纹相同即放行,
 * 绕过需重启(F1 反例);无基线文件在确认前持续保守拦截。拦下理由逐条
 * 点名;纯 Python 批/无 .def 批照常放行(空理由数组)。
 */

import { classifyDefChange } from './hotReloadDefStructure';

/** 所发文件内容读取口(与 HotReloadTargetStateWiring.readFileContent 同形) */
export type DefContentReader = (file: string) => Promise<string | null> | string | null;

/**
 * F1 四轮(2026-11-06 复审):check 的判定结果——拦下理由列表 + 批次令牌。
 * 调用方只在放行(reasons 为空)且即将真实发送时凭**本批自己的令牌**调
 * commit:令牌把「判定」与「前滚」逐批绑定,commit 绝不按文件集猜测该滚
 * 哪批(同文件集的并发/先后批次各归各,被拦批的快照没有任何通路借别批
 * commit 入册)。
 */
export interface DefGateCheckVerdict {
  /** 拦下理由列表(空数组=放行) */
  readonly reasons: readonly string[];
  /** 批次令牌:commit(token) 只认领本令牌对应那批的判定快照 */
  readonly token: number;
}

export interface DefStructuralGate {
  /**
   * 对一批待发送文件做 def 结构判定,返回拦下理由列表与批次令牌。
   * 纯判定面:本方法绝不改基线册(F1——被拦批次不得前滚基线);放行
   * 批次由调用方在真实发送前凭令牌调 commit 前滚基线。
   */
  check(files: readonly string[]): Promise<DefGateCheckVerdict>;
  /**
   * F1:基线前滚口——仅当批次已通过判定且即将真实发送时由调用方凭本批
   * 令牌调用。F1 二轮:前滚只落 check 判定时留的内容快照,绝不重读文件
   * ——判定放行后文件再变,重读会把从未通过判定的内容写进基线,该内容
   * 被拦/未被目标应用后再次发送即因指纹相同放行(异步时序绕过)。
   * F1 四轮:按令牌认领自己那批(被拦批不入认领队列,令牌对不上不滚)。
   */
  commit?(token: number): Promise<void>;
  /**
   * F1:明确重启确认口——用户确认引擎已重启并加载当前内容后调用,把
   * 基线(重新)建立为当前内容。不传 files 时对会话内闸见过的全部 def
   * 文件重建。返回建立/更新基线的文件数(不可读的跳过,不虚构)。
   */
  confirmLoaded?(files?: readonly string[]): Promise<number>;
}

export function createDefStructuralGate(
  reader: DefContentReader | undefined,
  baselines: Map<string, string>
): DefStructuralGate {
  // 会话内闸判定见过的 def 文件(含被拦的)——confirmLoaded 的默认重建面
  const seenDefFiles = new Set<string>();
  // F1 四轮:批次令牌发生器——每次 check 签发一个,判定与前滚逐批绑定
  let nextToken = 1;
  // F1 二轮:check 判定时留的内容快照——commit 前滚只落判定时读到的内容,
  // 绝不重读(check 放行后文件再变,重读=把未判定内容写进基线,构成时序绕过);
  // confirmLoaded 不受影响(用户明确重启确认)。
  // F1 四轮(2026-11-06 复审):三轮的「按文件集匹配最早未消费批」仍是错拿
  // 通路——被拦批次也进快照队列,批 A 被拦、同文件集批 B 放行时,B 的 commit
  // 按文件集匹配到最早的 A 批,把从未通过判定的被拦内容滚进基册。修后:
  // ①被拦批次不入快照认领队列(只入被拦记录册,其快照即弃);②check 返回
  // 批次令牌,commit(令牌) 只认领令牌对应的那一批——同文件集的并发/先后
  // 批次各归各,被拦批的快照没有任何通路借别批 commit 入册。
  interface CheckedBatchSnapshots {
    readonly token: number;
    readonly defFiles: readonly string[];
    readonly snapshots: Map<string, string>;
  }
  const checkedBatches: CheckedBatchSnapshots[] = [];
  // F1 四轮:被拦记录册——被拦批次只留判定痕迹(令牌+文件+理由),快照不
  // 保留(绝不入认领队列);confirmLoaded 的重建面由 seenDefFiles 承担
  const blockedBatches: Array<{ token: number; defFiles: readonly string[] }> = [];
  // 防泄漏上限:两册只进不出(被拦批永不 commit、放行批未 commit 即丢按旧
  // 基线保守重判,不丢正确性);超限丢最老
  const MAX_CHECKED_BATCHES = 64;
  const MAX_BLOCKED_BATCHES = 64;
  const readContent = async (file: string): Promise<string | null> => {
    if (!reader) {
      return null;
    }
    try {
      const content = await Promise.resolve(reader(file));
      return content === null || content === undefined ? null : content;
    } catch {
      return null;
    }
  };
  const readAll = async (files: readonly string[]): Promise<(string | null)[]> =>
    Promise.all(files.map(file => readContent(file)));
  const isDef = (file: string): boolean => file.toLowerCase().endsWith('.def');

  return {
    async check(files): Promise<DefGateCheckVerdict> {
      const token = nextToken;
      nextToken += 1;
      const defFiles = files.filter(isDef);
      if (defFiles.length === 0 || !reader) {
        // 纯 Python 批放行(令牌照发,commit 认领不到任何 def 快照=无操作);
        // 无读取通道整批拦下(无快照可留,理由如实点名)
        if (defFiles.length > 0) {
          blockedBatches.push({ token, defFiles });
          if (blockedBatches.length > MAX_BLOCKED_BATCHES) {
            blockedBatches.shift();
          }
          return {
            reasons: ['def 无内容读取通道,证明不了无结构变化(保守不发)'],
            token
          };
        }
        return { reasons: [], token };
      }
      for (const file of defFiles) {
        seenDefFiles.add(file);
      }
      const contents = await readAll(defFiles);
      const reasons: string[] = [];
      // 本批自己的判定快照(只收可读文件;不可读文件本批被拦,本就无内容可滚)
      const batchSnapshots = new Map<string, string>();
      defFiles.forEach((file, index) => {
        const after = contents[index];
        if (after === null) {
          reasons.push(`${file}: 内容不可读(保守按结构性,不发)`);
          return;
        }
        // F1 二轮:判定面读到的内容留快照——commit 前滚的唯一合法来源
        batchSnapshots.set(file, after);
        const baseline = baselines.get(file);
        if (baseline === undefined) {
          reasons.push(`${file}: 无基线(本次会话首次见到,证明不了无结构变化;重启后请确认基线)`);
        } else {
          const verdict = classifyDefChange(baseline, after);
          if (verdict.structural) {
            reasons.push(`${file}: ${verdict.reasons.join(';')}`);
          }
        }
        // F1:判定面不再前滚基线——被拦批次滚动基线会让第二次发送绕过
        // 需重启;放行批次由调用方凭令牌 commit 前滚(见 gateDefChanges/重试)。
      });
      // F1 四轮:放行批快照带令牌入认领队列;被拦批只入被拦记录册(快照即弃)
      if (reasons.length === 0) {
        checkedBatches.push({ token, defFiles, snapshots: batchSnapshots });
        if (checkedBatches.length > MAX_CHECKED_BATCHES) {
          checkedBatches.shift();
        }
      } else {
        blockedBatches.push({ token, defFiles });
        if (blockedBatches.length > MAX_BLOCKED_BATCHES) {
          blockedBatches.shift();
        }
      }
      return { reasons, token };
    },
    async commit(token): Promise<void> {
      if (!reader) {
        return;
      }
      // F1 四轮:只认本令牌对应那批——被拦批不在册,令牌对不上(未判定过/
      // 已消费/被拦/过期丢弃)一律不滚
      const batchIndex = checkedBatches.findIndex(batch => batch.token === token);
      if (batchIndex < 0) {
        return;
      }
      const [batch] = checkedBatches.splice(batchIndex, 1);
      // F1 二轮:只落 check 判定时留的快照,绝不重读文件——判定放行后内容
      // 再变,重读会把从未通过判定的内容滚进基线(时序绕过反例:基线 A,
      // check 读到 A 放行,文件变 B,commit 重读 B 入基线;B 被拦/未被目标
      // 应用后再次发送 B,指纹相同即放行)。
      for (const file of batch.defFiles) {
        const snapshot = batch.snapshots.get(file);
        if (snapshot !== undefined) {
          baselines.set(file, snapshot);
        }
      }
    },
    async confirmLoaded(files): Promise<number> {
      if (!reader) {
        return 0;
      }
      const targets = (files ? [...files] : [...seenDefFiles]).filter(isDef);
      const contents = await readAll(targets);
      let confirmed = 0;
      targets.forEach((file, index) => {
        const content = contents[index];
        if (content !== null) {
          baselines.set(file, content);
          confirmed += 1;
        }
      });
      return confirmed;
    }
  };
}
