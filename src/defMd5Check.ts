//! AUDIT-003:引擎 def MD5 生产消费链——工作区 def 闭包 ↔ 引擎 SDK 盖章
//! 一致性核查(todo RUST-MIGRATION-AUDIT-003)。
//!
//! 审计坐实:computeDefMd5InRust(`$/kode/def/md5` RPC 包装)与
//! negotiateEngineDigest 只有定义与测试调用、无生产消费链(包装器≠接线)。
//! 本模块把消费链接通:
//! - **引擎回执来源**:kbcmd 生成的客户端 SDK 盖章常量——引擎侧
//!   EntityDef::md5().getDigestStr() 经 client_sdk.cpp:323 替换
//!   `@{KBE_SERVER_ENTITYDEF_MD5}` 写进 js(kbengine.js `serverEntityDefMD5`)
//!   与 unity(KBEngine.cs `serverEntitydefMD5`);同一值经登录握手
//!   onHelloCB(baseapp.cpp:4910)发往客户端,客户端失配即中止(js 模板
//!   4177-4183)。盖章常量是工具链可达的引擎摘要事实源。
//! - **功能入口**:命令 kbengine.def.checkEngineMd5——收集工作区资产根的
//!   引擎喂入序输入(TS 收集、Rust 计算的既有边界),经 computeDefMd5InRust
//!   取工作区闭包的引擎格式 MD5,逐 SDK 盖章对拍,报告落「KBEngine Def 分
//!   析」通道(vscode 同名通道合并)。
//! - **输入面**(def_md5/golden.rs 同布局):scripts/entities.xml、
//!   entity_defs/{types.xml,alias.xml}、entity_defs/*.def(实体)、
//!   entity_defs/interfaces/*.def、entity_defs/components/*.def(按文件名
//!   干入表)、scripts/{base,cell}/components/*.py → `base:X`/`cell:X`。
//!   def 原文经 readSharedFileSnapshot 打开缓冲区优先(未保存缓冲区进摘要,
//!   审计要求的未保存输入面),未打开磁盘补载。
//!
//! 诚实边界(审计铁律):
//! - Rust 不可用(无门/调用失败/形状不合规)→ 工作区 MD5 恒「未知」,
//!   盖章逐个标「无法比对」——绝不拿客户端 sha256 冒充引擎 Digest(跨类
//!   永不互比,hotReloadDefHash 同规);
//! - 未检出 SDK 盖章面 → 如实「未检出」,不猜不编;
//! - 缺文件按引擎喂入序以空串入流(与 Rust golden 收集器 unwrap_or_default
//!   同口径)并如实记入备注。

import * as path from 'path';
import * as vscode from 'vscode';
import { computeDefMd5InRust, type DefMd5RustParams } from './backend/defMd5Rust';
import { negotiateEngineDigest, type DefDigestHandshake } from './backend/hotReloadDefHash';
import { findFilesAcrossRoots, resolveAssetsRootForWorkspace } from './scanRoots';
import { readSharedFileSnapshotAsync } from './sharedFileSnapshot';

export const DEF_MD5_CHECK_COMMAND = 'kbengine.def.checkEngineMd5';
/** 与 def 静态分析共用通道名(vscode 按名合并;测试按名查找)。 */
export const DEF_MD5_CHANNEL_NAME = 'KBEngine Def 分析';
/** SDK 盖章扫描单 glob 文件数上限(防御性有界;超限如实记备注不再扩扫)。 */
const SDK_SCAN_FILE_CAP = 50;
/** def 语料并发读上限(与 globalDataIndex 初扫同口径:8 路)。 */
const DEF_MD5_READ_CONCURRENCY = 8;
/** js(kbengine.js)与 unity(KBEngine.cs)盖章面的赋值形态(大小写差异照录)。 */
const SDK_STAMP_PATTERN = /serverEntity[Dd]efMD5\s*=\s*"([0-9a-fA-F]{32})"/;

/** 收集/扫描依赖(注入面;默认走真实 vscode 通道)。 */
export interface DefMd5CheckDeps {
  findFiles: (glob: string) => Promise<vscode.Uri[]>;
  /** 异步读:未打开文件的磁盘补载必须让出宿主事件循环(RUST-001 设计原则,
   * 命令期 def 语料逐文件同步补载曾是唯一的命令期同步载入面)。 */
  readText: (fsPath: string) => Promise<string | null>;
  assetsRoot: () => string;
}

/** 缺省依赖:真实工作区(缓冲区优先快照 + assetsRoot 发现链)。 */
export function defaultDefMd5CheckDeps(): DefMd5CheckDeps {
  return {
    findFiles: (glob) => findFilesAcrossRoots(glob),
    readText: async (fsPath) => (await readSharedFileSnapshotAsync(fsPath))?.content ?? null,
    assetsRoot: () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      return workspaceRoot === '' ? '' : resolveAssetsRootForWorkspace(workspaceRoot);
    }
  };
}

export type DefMd5InputsResult =
  | { kind: 'ready'; params: DefMd5RustParams; notes: string[] }
  | { kind: 'unavailable'; reason: string };

/**
 * 引擎喂入序输入收集(def_md5/golden.rs collect_demo_params 同布局):TS 收
 * 集、Rust 计算。def 按目录分型(根=实体,interfaces/=接口,components/=组
 * 件),原文经共享快照(打开缓冲区优先)。文件缺失按空串入流并记备注(不
 * 失败——引擎喂入序里缺文件就是空段,golden 收集器同口径)。
 */
export async function collectDefMd5Inputs(deps: DefMd5CheckDeps): Promise<DefMd5InputsResult> {
  const root = deps.assetsRoot();
  if (root === '') {
    return { kind: 'unavailable', reason: '未检出 KBEngine 资产根(kbengine.assetsRoot 未配置且自动发现落空)' };
  }
  const scriptsDir = path.join(root, 'scripts');
  const entityDefsDir = path.join(scriptsDir, 'entity_defs');
  const notes: string[] = [];
  const readOr = async (fsPath: string, label: string): Promise<string> => {
    const content = await deps.readText(fsPath);
    if (content === null) {
      notes.push(`${label}: 缺失(以空串入流)`);
      return '';
    }
    return content;
  };
  const [typesXml, entitiesXml, aliasXml] = await Promise.all([
    readOr(path.join(entityDefsDir, 'types.xml'), 'entity_defs/types.xml'),
    readOr(path.join(scriptsDir, 'entities.xml'), 'scripts/entities.xml'),
    readOr(path.join(entityDefsDir, 'alias.xml'), 'entity_defs/alias.xml')
  ]);
  const params: DefMd5RustParams = {
    typesXml,
    entitiesXml,
    defs: {},
    aliasXml,
    componentScripts: []
  };

  // def 按目录分型:**/*.def 一枚 glob,按相对 entity_defs 的路径段分型
  // (根=实体/interfaces=接口/components=组件;其他位置不入喂入序——引擎
  // loadDefInfo 只走这三处)。
  const defUris = await deps.findFiles('**/*.def');
  const typeOf = (fsPath: string): 'entity' | 'interface' | 'component' | null => {
    const relative = path.relative(entityDefsDir, fsPath);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    const segments = relative.split(path.sep);
    if (segments.length === 1) {
      return 'entity';
    }
    if (segments.length === 2 && segments[0] === 'interfaces') {
      return 'interface';
    }
    if (segments.length === 2 && segments[0] === 'components') {
      return 'component';
    }
    return null;
  };
  // RUST-001:命令期 def 语料逐文件补载曾是唯一的同步载入面。改异步读 +
  // 有界并发(循环在批间让出宿主事件循环)。入表结果与读取次序无关——
  // Rust 侧 defs 收进 HashMap 聚合(crates/kode-server/src/def_md5/mod.rs),
  // 故并发不影响摘要。
  const reads: Array<Promise<void>> = [];
  for (const uri of defUris) {
    const kind = typeOf(uri.fsPath);
    if (kind === null) {
      continue;
    }
    const stem = path.basename(uri.fsPath, path.extname(uri.fsPath));
    const read = async (): Promise<void> => {
      const content = await deps.readText(uri.fsPath);
      if (content === null) {
        notes.push(`${path.relative(root, uri.fsPath)}: 不可读(不入表)`);
        return;
      }
      params.defs[stem] = content;
    };
    reads.push(read());
    if (reads.length >= DEF_MD5_READ_CONCURRENCY) {
      await Promise.all(reads);
      reads.length = 0;
    }
  }
  await Promise.all(reads);

  // 组件脚本存在性(scripts/{base,cell}/components/*.py → base:X/cell:X)。
  for (const glob of ['**/base/components/*.py', '**/cell/components/*.py']) {
    for (const uri of await deps.findFiles(glob)) {
      const normalized = uri.fsPath.split(path.sep).join('/');
      const side = normalized.includes('/base/components/') ? 'base' : 'cell';
      params.componentScripts.push(`${side}:${path.basename(uri.fsPath, '.py')}`);
    }
  }
  params.componentScripts.sort();
  return { kind: 'ready', params, notes };
}

/** 一处 SDK 盖章:文件路径 + 引擎摘要常量(kbcmd 生成时点的 EntityDef::md5)。 */
export interface EngineSdkStamp {
  path: string;
  stamp: string;
}

/**
 * SDK 盖章扫描:kbengine.js / KBEngine.cs 两个已知盖章面(引擎 client_sdk
 * 替换产物);每 glob 有界(SDK_SCAN_FILE_CAP),无盖章文件如实跳过,超限
 * 记备注不扩扫。
 */
export async function findEngineSdkStamps(
  deps: DefMd5CheckDeps,
  notes: string[] = []
): Promise<EngineSdkStamp[]> {
  const stamps: EngineSdkStamp[] = [];
  for (const glob of ['**/kbengine.js', '**/KBEngine.cs']) {
    const uris = await deps.findFiles(glob);
    if (uris.length > SDK_SCAN_FILE_CAP) {
      notes.push(`${glob}: 命中 ${uris.length} 个文件,超上限只扫前 ${SDK_SCAN_FILE_CAP} 个`);
    }
    for (const uri of uris.slice(0, SDK_SCAN_FILE_CAP)) {
      // RUST-001:逐文件 await 让出事件循环(盖章面至多 SDK_SCAN_FILE_CAP 个,
      // 顺序 await 即有界;结果按 path 排序,与读取次序无关)。
      const content = await deps.readText(uri.fsPath);
      if (content === null) {
        continue;
      }
      const match = content.match(SDK_STAMP_PATTERN);
      if (match) {
        stamps.push({ path: uri.fsPath, stamp: match[1] });
      }
    }
  }
  stamps.sort((a, b) => a.path.localeCompare(b.path));
  return stamps;
}

/** 逐章对拍面:match=一致;mismatch=工作区闭包与盖章时点不一致(盖章是
 * 生成时点事实源,def 改动后未重生成 SDK 即失配);unverifiable=Rust 侧
 * MD5 未知(无法比对,保留 unknown 不猜)。 */
export type StampVerdict = 'match' | 'mismatch' | 'unverifiable';

// ---------------------------------------------------------------- RUST-404
// 引擎 Digest 兼容性证据层级(旧 HR-HASH-017)。铁律:兼容性结论只可能来自
// 「真实引擎摘要对拍」——即把客户端经 Rust 重算的引擎格式 MD5 与同一工作
// 区闭包下真实引擎产出的摘要比较;缺真实引擎证据(无 SDK 盖章/盖章不可用)
// 时一律明示「不可用/未验证」,绝不拿 C-18 规范推导冒充「已同步」。

/** 证据层级:real-engine=与真实引擎摘要(同一工作区闭包)做过对拍;
 * spec-derived=仅 C-18 规范推导,无真实引擎摘要可比。 */
export type EngineDigestEvidenceTier = 'real-engine' | 'spec-derived';

/** 引擎 Digest 兼容性结论(RUST-404)。compatible 三态:true=与真实引擎一
 * 致;false=与真实引擎不一致(有真实证据但失配);null=无真实证据不可判。 */
export interface EngineDigestCompatibility {
  readonly tier: EngineDigestEvidenceTier;
  /** 是否与真实引擎摘要做过对拍(real-engine 恒 true;spec-derived 恒 false) */
  readonly verified: boolean;
  readonly compatible: boolean | null;
  /** 一句话结论(报告/通知同源;无证据时明示不可用,绝不宣称已同步) */
  readonly reason: string;
}

/**
 * 真实引擎摘要对拍原语(纯函数):ours=客户端经 Rust 重算的引擎格式 MD5,
 * realEngineDigest=同一工作区闭包下真实引擎产出的摘要(kbcmd 生成 SDK 盖章
 * 或外部提供)。缺 realEngineDigest → 明示不可用(spec-derived,不猜不编)。
 */
export function verifyEngineDigestCompatibility(
  ours: string,
  realEngineDigest: string | undefined
): EngineDigestCompatibility {
  if (realEngineDigest === undefined) {
    return {
      tier: 'spec-derived',
      verified: false,
      compatible: null,
      reason: '无真实引擎摘要证据(SDK 盖章未检出/不可用);仅 C-18 规范推导,未对真实引擎实现验证,不宣称已同步'
    };
  }
  if (ours === realEngineDigest) {
    return {
      tier: 'real-engine',
      verified: true,
      compatible: true,
      reason: '与真实引擎 EntityDef::md5() 摘要对拍一致:客户端 Rust 重算复现了引擎摘要(同一工作区闭包)'
    };
  }
  return {
    tier: 'real-engine',
    verified: true,
    compatible: false,
    reason: `与真实引擎摘要不一致(Rust 重算 ${ours} ≠ 引擎摘要 ${realEngineDigest}):不兼容,不宣称已同步`
  };
}

/**
 * 从逐章对拍面派生兼容性结论(RUST-404)。match 是真实引擎证据(盖章常量 =
 * kbcmd 生成时点的引擎 EntityDef::md5,与该工作区闭包同源;Rust 重算等于它
 * 即复现了真实引擎);mismatch 是有真实证据但失配;否则无证据不可判。
 */
export function deriveEngineDigestCompatibility(
  stamps: Array<EngineSdkStamp & { verdict: StampVerdict }>,
  workspaceMd5: string | null
): EngineDigestCompatibility {
  const match = stamps.find((stamp) => stamp.verdict === 'match');
  if (match && workspaceMd5 !== null) {
    return verifyEngineDigestCompatibility(workspaceMd5, match.stamp);
  }
  const mismatch = stamps.find((stamp) => stamp.verdict === 'mismatch');
  if (mismatch && workspaceMd5 !== null) {
    return verifyEngineDigestCompatibility(workspaceMd5, mismatch.stamp);
  }
  return verifyEngineDigestCompatibility(workspaceMd5 ?? '', undefined);
}

export interface DefMd5CheckOutcome {
  /** 工作区闭包引擎 MD5;Rust 不可用为 null(未知面,不猜)。 */
  workspaceMd5: string | null;
  /** Digest 协商(AUDIT-004 接线):由 workspaceMd5 经 negotiateEngineDigest
   * 协商;Rust 不可用退化为 unknown/未协商,不猜、不与客户端 sha256 互比。 */
  handshake: DefDigestHandshake;
  /** 引擎 Digest 兼容性证据层级(RUST-404):真实引擎对拍一致 / 无证据明示
   * 不可用;绝不把规范推导宣称成「已同步」。 */
  compatibility: EngineDigestCompatibility;
  /** 输入收集备注(缺文件入流等,逐条如实)。 */
  notes: string[];
  stamps: Array<EngineSdkStamp & { verdict: StampVerdict }>;
  /** 失败/缺面归因(资产根未检出等);正常收集为空。 */
  unavailableReason?: string;
}

/**
 * 核查编排:收集 → Rust 计算 → 逐章对拍。任何一环不可用都收敛为可渲染
 * 结果(unknown/未检出/归因),不抛不猜。
 */
export async function runDefMd5Check(
  deps: DefMd5CheckDeps,
  compute: (params: DefMd5RustParams) => Promise<{ md5: string } | null> = computeDefMd5InRust
): Promise<DefMd5CheckOutcome> {
  const collected = await collectDefMd5Inputs(deps);
  if (collected.kind === 'unavailable') {
    return {
      workspaceMd5: null,
      handshake: negotiateEngineDigest(),
      compatibility: verifyEngineDigestCompatibility('', undefined),
      notes: [],
      stamps: [],
      unavailableReason: collected.reason
    };
  }
  const notes = [...collected.notes];
  const stamps = await findEngineSdkStamps(deps, notes);
  const computed = await compute(collected.params);
  const workspaceMd5 = computed?.md5 ?? null;
  const stampVerdicts: Array<EngineSdkStamp & { verdict: StampVerdict }> = stamps.map((stamp) => ({
    ...stamp,
    verdict: workspaceMd5 === null ? 'unverifiable' : stamp.stamp === workspaceMd5 ? 'match' : 'mismatch'
  }));
  return {
    workspaceMd5,
    handshake: negotiateEngineDigest(workspaceMd5 ?? undefined),
    compatibility: deriveEngineDigestCompatibility(stampVerdicts, workspaceMd5),
    notes,
    stamps: stampVerdicts
  };
}

/** 纯文本报告(逐行可断言;落「KBEngine Def 分析」通道)。 */
export function renderDefMd5CheckReport(outcome: DefMd5CheckOutcome): string {
  const lines: string[] = [];
  lines.push('引擎 def MD5 一致性核查(RUST-MIGRATION-AUDIT-003)');
  if (outcome.unavailableReason !== undefined) {
    lines.push(`核查未执行:${outcome.unavailableReason}`);
    return lines.join('\n');
  }
  lines.push(
    outcome.workspaceMd5 === null
      ? '工作区闭包 MD5: 未知(Rust 权威实现不可用;不猜测,不与客户端 sha256 冒充比对)'
      : `工作区闭包 MD5: ${outcome.workspaceMd5}`
  );
  lines.push(
    outcome.handshake.negotiated && outcome.handshake.digest !== undefined
      ? `Digest 协商: md5 已协商(digest=${outcome.handshake.digest};C-18 引擎算法,客户端经 Rust 重算)`
      : 'Digest 协商: 未协商(unknown;Rust 重算不可用,客户端 sha256 不与引擎摘要比对)'
  );
  if (outcome.stamps.length === 0) {
    lines.push('SDK 盖章: 未检出(kbcmd 生成的 kbengine.js / KBEngine.cs;该常量与登录握手 onHelloCB 的引擎摘要同源)');
  } else {
    lines.push(`SDK 盖章: ${outcome.stamps.length} 处`);
    for (const stamp of outcome.stamps) {
      const face =
        stamp.verdict === 'match'
          ? '一致'
          : stamp.verdict === 'mismatch'
            ? `不一致(SDK 盖章 ${stamp.stamp};def 在 SDK 生成后改动过)`
            : '无法比对(工作区 MD5 未知)';
      lines.push(`  - ${stamp.path}: ${face}`);
    }
  }
  // RUST-404:引擎 Digest 兼容性单列一行——是否经真实引擎实现验证逐字如实,
  // 无真实引擎证据时明示不可用,不拿规范推导冒充实已同步。
  lines.push(`引擎兼容性: ${outcome.compatibility.reason}`);
  for (const note of outcome.notes) {
    lines.push(`备注: ${note}`);
  }
  return lines.join('\n');
}

/** 最近一次核查结果(HR-HASH-007 指纹 Inspector 转显闭包面;会话内存,不落盘) */
let lastMd5CheckOutcome: DefMd5CheckOutcome | null = null;

/** 读取最近一次引擎盖章核查结果(未跑过=null,消费面如实显「未运行」) */
export function getLastDefMd5CheckOutcome(): DefMd5CheckOutcome | null {
  return lastMd5CheckOutcome;
}

const md5CheckChannels = new WeakMap<vscode.ExtensionContext, vscode.OutputChannel>();

function ensureDefMd5Channel(context: vscode.ExtensionContext): vscode.OutputChannel {
  let channel = md5CheckChannels.get(context);
  if (!channel) {
    channel = vscode.window.createOutputChannel(DEF_MD5_CHANNEL_NAME);
    context.subscriptions.push(channel);
    md5CheckChannels.set(context, channel);
  }
  return channel;
}

/**
 * 命令接线:kbengine.def.checkEngineMd5 → 编排 → 通道报告 + 汇总通知
 * (一致=info;不一致=warning;未知/未检出=info 如实)。通道惰性建,句柄
 * 自进 context.subscriptions;deps 注入面供测试驱动。
 */
export function setupDefMd5Check(
  context: vscode.ExtensionContext,
  opts: { deps?: DefMd5CheckDeps; compute?: (params: DefMd5RustParams) => Promise<{ md5: string } | null> } = {}
): void {
  const deps = opts.deps ?? defaultDefMd5CheckDeps();
  const compute = opts.compute ?? computeDefMd5InRust;
  const command = vscode.commands.registerCommand(DEF_MD5_CHECK_COMMAND, async () => {
    const outcome = await runDefMd5Check(deps, compute);
    lastMd5CheckOutcome = outcome;
    const channel = ensureDefMd5Channel(context);
    channel.clear();
    channel.appendLine(renderDefMd5CheckReport(outcome));
    channel.show(true);
    if (outcome.unavailableReason !== undefined) {
      void vscode.window.showInformationMessage(`KBEngine def MD5 核查未执行:${outcome.unavailableReason}`);
      return;
    }
    const mismatches = outcome.stamps.filter((stamp) => stamp.verdict === 'mismatch').length;
    if (outcome.workspaceMd5 === null) {
      void vscode.window.showInformationMessage('KBEngine def MD5 核查完成:工作区闭包 MD5 未知(Rust 不可用),未与 SDK 盖章比对');
    } else if (mismatches > 0) {
      void vscode.window.showWarningMessage(`KBEngine def MD5 核查完成:${mismatches} 处 SDK 盖章与工作区闭包不一致(def 在 SDK 生成后改动过)`);
    } else if (outcome.stamps.length === 0) {
      void vscode.window.showInformationMessage(`KBEngine def MD5 核查完成:${outcome.compatibility.reason}`);
    } else {
      // RUST-404:兼容性结论单列(对拍一致才说「已对拍一致」,绝不说「已同步」)
      void vscode.window.showInformationMessage(`KBEngine def MD5 核查完成:${outcome.compatibility.reason}`);
    }
  });
  context.subscriptions.push(command);
}
