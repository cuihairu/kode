/**
 * 热更状态栏文件版本号(HOT-VER):每文件单调递增整数(v1, v2, …),不暴露
 * mtime:size 原始 token。规则:文件首次被跟踪记 v1;每次检测到盘上内容变化
 * (version token 变)+1;回执 applied 且 digest 与当前盘上一致时基线追平
 * (该文件基线版本 = 当前版本)。基线存台账(HotReloadTargetState 同生命周期,
 * 不新开存储)。
 *
 * 台账独立于 watcher:`kbengine.hotReload.enabled=false` 时手动触发路径
 * (showFileState / retryFailed / 右键手动发一次热更)照样建档出号,与开监视
 * 时同一文件同一版本——watcher 只是本版本簿的默认事件来源之一,不是它的前提;
 * 两条路径写同一份台账同一实现(noteFileVersion 的 token 判重保证不重复计数)。
 *
 * 徽标口径:单号=已同步(基线==盘上),双号=待同步(基线→盘上);未跟踪/不在
 * 监视范围的文件不显号。版本号只描述「盘上内容变了几次/基线在哪」,不声称已
 * 生效——生效与否仍由 applied 双证核验说了算。
 */

import { createHash } from 'crypto';
import * as fs from 'fs';

import { readFileVersionToken } from '../sharedFileEvents';
import type {
  HotReloadFileVersionEvent,
  HotReloadFileVersionState,
  HotReloadTargetStateStore
} from './hotReloadTargetState';
import {
  formatHotReloadTime,
  formatHotReloadVersionSuffix,
  type HotReloadVersionBadgeView,
  type HotReloadVersionSource
} from '../hotReloadStatus';

export type { HotReloadVersionBadgeView, HotReloadVersionSource };

/** 内容 sha256(与 hotReloadFileState.sha256Hex 同源的 node:crypto 原语) */
const sha256Hex = (content: string): string =>
  createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

/** glob 字面量段的正则转义(元字符;`*`/`?`/`{}`/`,` 由调用方另行处理) */
const escapeGlobLiteral = (text: string): string => text.replace(/[.+^$()|[\]\\]/g, '\\$&');

/**
 * glob → RegExp(VS Code glob 子集):`**` 跨目录、`*`/`?` 不跨目录、
 * `{a,b}` 花括号枚举;含 `/` 的模式按相对路径整体锚定,不含 `/` 的模式
 * (如 `*.py`)任意深度按末段命中。
 */
const globToRegExp = (rawPattern: string): RegExp => {
  const pattern = rawPattern.replace(/\\/g, '/');
  let out = '';
  let braceDepth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          out += '(?:[^/]+/)*'; // `**/` = 零个或多个目录段
          index += 2;
        } else {
          out += '.*';
          index += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      out += '(?:';
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      out += ')';
      continue;
    }
    if (char === ',' && braceDepth > 0) {
      out += '|';
      continue;
    }
    out += escapeGlobLiteral(char);
  }
  const anchored = pattern.includes('/') ? `^/?${out}$` : `^(?:.*/)?${out}$`;
  return new RegExp(anchored);
};

/**
 * 监视范围判定:文件相对路径是否命中任一热更 glob。范围只看 `globs` 配置,
 * 与 `enabled` 开关正交——开关只决定建不建 watcher,版本徽标的「在不在监视
 * 范围」永远按同一套模式判,手动触发路径与 watcher 路径口径一致。
 */
export function matchesHotReloadGlob(file: string, patterns: readonly string[]): boolean {
  const posixPath = file.replace(/\\/g, '/');
  return patterns.some(pattern => globToRegExp(pattern).test(posixPath));
}

export interface HotReloadVersionTrackerDeps {
  /** 版本簿载体(台账内,不新开存储) */
  readonly store: HotReloadTargetStateStore;
  /** 当前活动文档绝对路径(无=undefined);注入即状态栏优先显示它 */
  activeFile(): string | undefined;
  /** 是否在监视范围(globs 命中;与 enabled 开关无关) */
  isWatched(file: string): boolean;
  /** 注入时钟(版本事件时间戳) */
  now(): number;
  /** 盘上版本 token 采样口(缺省走 fs.stat 的 mtimeMs:size) */
  statToken?(file: string): Promise<string | undefined>;
  /** 盘上内容读取口(applied 基线追平的 digest 比对;缺省走 fs.readFile) */
  readContent?(file: string): Promise<string | undefined>;
}

/** 版本事件渲染(OUTPUT 版本台账行):时间 + 版本 + 事实,不加工不美化 */
const renderVersionEvent = (event: HotReloadFileVersionEvent): string => {
  const time = formatHotReloadTime(event.at);
  switch (event.kind) {
    case 'tracked':
      return `${time} v${event.version} 首次跟踪`;
    case 'bump':
      return `${time} v${event.version} 盘上内容变化`;
    case 'baseline':
      return `${time} 基线追平 v${event.version}`;
    case 'delivery': {
      const parts = [`${time} v${event.version} ${event.stage === 'receipt' ? '回执' : '发送'}`];
      if (event.attempt !== undefined) {
        parts.push(`attempt=${event.attempt}`);
      }
      if (event.digest8 !== undefined) {
        parts.push(`digest=${event.digest8}`);
      }
      if (event.outcome !== undefined) {
        parts.push(`outcome=${event.outcome}`);
      }
      if (event.targetId !== undefined) {
        parts.push(`target=${event.targetId}`);
      }
      return parts.join(' ');
    }
    default:
      return `${time} v${event.version}`;
  }
};

/**
 * 版本采样与徽标数据源:采样(异步 stat)与判定(同步读台账)分离——状态栏
 * 渲染走同步 badge/pending/report,渲染后 kickRefresh 异步重采,采到变化才
 * 补渲染一次。所有路径(watcher 事件、回执落账、手动触发、点击状态栏)都
 * 收敛到本类的 noteFile/refresh 两个入口,不存在第二套计数。
 */
export class HotReloadVersionTracker implements HotReloadVersionSource {
  private readonly deps: HotReloadVersionTrackerDeps;

  constructor(deps: HotReloadVersionTrackerDeps) {
    this.deps = deps;
  }

  private async stat(file: string): Promise<string | undefined> {
    if (this.deps.statToken) {
      return this.deps.statToken(file);
    }
    // 接 main 的盘上版本读取接口(readFileVersionToken),不另造第二套判据
    return readFileVersionToken(file);
  }

  private async read(file: string): Promise<string | undefined> {
    if (this.deps.readContent) {
      return this.deps.readContent(file);
    }
    try {
      return await fs.promises.readFile(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * 采样单个文件的盘上版本(watcher 事件 / 手动触发前显式建档共用)。
   * 返回是否有变化(建档或 +1)——调用方据此补渲染状态栏。
   */
  async noteFile(file: string): Promise<boolean> {
    const token = await this.stat(file);
    const result = this.deps.store.noteFileVersion(file, token, this.deps.now());
    return result !== undefined && result.change !== 'unchanged';
  }

  /**
   * 全量刷新:stat 全部已跟踪文件(补采/跳号),再对「基线 < 盘上当前」且有
   * applied 记录的文件读盘比对 digest——与发送时点冻结基准一致才基线追平
   * (盘上已变则不追平,如实保持双号)。返回是否有变化。
   */
  async refresh(): Promise<boolean> {
    let changed = false;
    for (const state of this.deps.store.fileVersions()) {
      const token = await this.stat(state.file);
      const result = this.deps.store.noteFileVersion(state.file, token, this.deps.now());
      if (result !== undefined && result.change !== 'unchanged') {
        changed = true;
      }
      if (await this.catchUpBaseline(state.file)) {
        changed = true;
      }
    }
    return changed;
  }

  /** applied 且盘上内容 sha256 == 发送时点冻结基准 → 基线追平到当前版本 */
  private async catchUpBaseline(file: string): Promise<boolean> {
    const state = this.deps.store.fileVersion(file);
    if (!state || state.baseline >= state.version) {
      return false;
    }
    const digests = this.deps.store.appliedSentDigestsForFile(file);
    if (digests.length === 0) {
      return false;
    }
    const content = await this.read(file);
    if (content === undefined) {
      return false;
    }
    if (!digests.includes(sha256Hex(content))) {
      return false; // 盘上内容 ≠ 所发内容:不追平,双号如实保留
    }
    return this.deps.store.advanceFileVersionBaseline(file, this.deps.now());
  }

  /** 当前活动文档版本;未跟踪/不在监视范围 → 回落最近变更文件;全无=undefined */
  badge(): HotReloadVersionBadgeView | undefined {
    const active = this.deps.activeFile();
    if (active !== undefined && this.deps.isWatched(active)) {
      const state = this.deps.store.fileVersion(active);
      if (state) {
        return this.viewOf(state);
      }
    }
    const recent = this.recentChangedFile();
    return recent ? this.viewOf(recent) : undefined;
  }

  /** 全部待同步文件(基线 ≠ 盘上当前),按文件路径排序 */
  pending(): HotReloadVersionBadgeView[] {
    return this.deps.store
      .fileVersions()
      .filter(state => this.deps.isWatched(state.file) && state.baseline !== state.version)
      .map(state => this.viewOf(state))
      .sort((left, right) => left.file.localeCompare(right.file));
  }

  /** OUTPUT 版本台账:逐文件列基线/盘上版本与每次版本跃迁的时间与发送回执 */
  report(): string[] {
    const badgeFile = this.badge()?.file;
    const states = this.deps.store.fileVersions().filter(state => this.deps.isWatched(state.file));
    if (states.length === 0) {
      return [];
    }
    const lines = [`版本台账:${states.length} 个文件(基线=已核验同步版本,盘上=当前内容版本)`];
    for (const state of states) {
      const synced = state.baseline === state.version;
      lines.push(
        ` ${state.file}基线 v${state.baseline} · 盘上 v${state.version}(${synced ? '已同步' : '待同步'})${
          state.file === badgeFile ? ' ← 状态栏当前文件' : ''
        }`
      );
      for (const event of state.events) {
        lines.push(`  ${renderVersionEvent(event)}`);
      }
    }
    return lines;
  }

  /** 单文件版本说明(showFileState 等手动路径落日志用);未跟踪/不在范围=undefined */
  describeVersion(file: string): string | undefined {
    const state = this.deps.store.fileVersion(file);
    if (!state || !this.deps.isWatched(file)) {
      return undefined;
    }
    const synced = state.baseline === state.version;
    return `版本: ${file} ${formatHotReloadVersionSuffix(state.baseline, state.version)}(${
      synced ? '已同步' : '待同步'
    })`;
  }

  /** 最近变更文件(仅 tracked/bump 变更事件按序号比,投递/基线事件不算变更) */
  private recentChangedFile(): HotReloadFileVersionState | undefined {
    let best: HotReloadFileVersionState | undefined;
    for (const state of this.deps.store.fileVersions()) {
      if (!this.deps.isWatched(state.file)) {
        continue;
      }
      if (!best || state.seq > best.seq) {
        best = state;
      }
    }
    return best;
  }

  private viewOf(state: HotReloadFileVersionState): HotReloadVersionBadgeView {
    return { file: state.file, baseline: state.baseline, current: state.version };
  }
}
