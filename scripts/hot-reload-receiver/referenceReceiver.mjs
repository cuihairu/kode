#!/usr/bin/env node
/**
 * 参考接收端(IDE-AUD-007):Kode 热更新 accepted/applied 回执契约的参考
 * 实现——零依赖 node:http,真实监听回环端口,真实读取所发文件、暂存副本、
 * 重算 sha256,按已记录契约回真实回包。用途:
 *  1. 引擎原生重载无 HTTP 回执(KBEngine.reloadScript 是 Python 调用,见
 *     docs/review/2026-10-30-completion-and-lint-audit.md AUD-007 实勘);
 *     accepted/applied JSON 契约作用于用户配置的 @http: quick action 回包体,
 *     本脚本是「会说该契约的服务端」参考实现,让请求/响应/digest 有真实
 *     样本可取,不再只拿模拟 JSON 字符串喂解析器。
 *  2. tests/hotReloadReceiverRoundtrip.test.ts 经它做真实回环联调。
 *
 * 已记录契约(docs/design/hot-reload-design.md §4 + src/hotReloadReceipt.ts):
 *   accepted: {"status":"accepted","file":"<所发文件绝对路径逐字回显>"}
 *   applied:  {"status":"applied","file":"<逐字回显>","digest":"<内容 sha256 hex>",
 *              "revision":<本次应用的全局递增版本号>}
 *   (可选 targetId:请求体给了就逐字回显;批量=逐条 JSON 数组)
 *
 * F3(2026-11-05 审核):applied 必须是「真实应用后」的协议证据,不是读取
 * +复制就能自称的状态——
 *  - F3 九轮(2026-11-06 第九轮复审):暂存命名空间与源文件树隔离 + 暂存路径
 *    symlink 防护 + 收尾清理 dev/ino 比对——八轮的暂存唯一子目录仍有两个残余:
 *    ①'.staged' 前缀仍在允许源文件树内:同批含既有 <root>/.staged/X.py 源文件
 *      时,<root>/X.py 的暂存副本 copyFileSync 直接覆盖该**源文件**(读回污染,
 *      digest 不符);修后源路径第一段为 '.staged' → 属接收端暂存命名空间,
 *      拒绝整批(与路径清洗同一防线),源命名空间与暂存命名空间从映射规则上
 *      不相交;
 *    ②暂存路径写入无 symlink 检查:.staged(或更深目录)被换成指向暂存根外
 *      的 symlink 时,copyFileSync 沿链接把暂存副本写到暂存根外;修后暂存写前
 *      做与 rename 目标同一套双重验证(包含性:父目录链 realpath 必须在暂存根
 *      real 内;一致性:解析结果与原路径逐字一致)+ lstat 最终组件拒 symlink,
 *      任一不过即拒绝本文件暂存(同 realpath→copy 一瞬的残余窗口,如实记录);
 *    ③收尾清理在「确认自建」之上再钉 **dev/ino 比对**:创建时 fstatSync(fd)
 *      捕获临时文件 dev/ino,收尾 unlink 前 lstat 比对路径当前 dev/ino 与捕获
 *      一致才删;路径已被竞态替换(不符)则跳过并如实报 rollback_skipped——
 *      八轮只按「创建成功点标志位」判断,路径被替换后按路径 unlink 仍会删掉
 *      不是本次创建的文件(替换文件与自建判定无关联,标志位防不住)。
 *    ④复审补口:词法 '.staged' 排除挡不住指向暂存树的 symlink 别名(root/alias
 *      → root/.staged 时同批暂存副本仍可覆盖别名指向的源文件)——修后对每个
 *      源文件 realpath 解析,解析结果落在暂存树(<root>/.staged realpath)内
 *      → 拒绝整批;
 *    ⑤复审补口:创建点 dev/ino 捕获缺失(fstatSync 失败)时身份无法确认,
 *      收尾宁留残留也不按路径盲删(如实 rollback_skipped);lstat 比对→unlink
 *      一瞬的残余竞态窗口与 realpath→rename 同级,如实为已知限制,不自称
 *      「绝不删错」。
 *  - F3 八轮(2026-11-08 第八轮复审):目录竞争包含性验证 + 收尾清理标志位 +
 *    暂存唯一子目录——
 *    ①rename 目标父目录**双重验证**(verifiedRealParentForRename):rename 前
 *      realpathSync(父目录) 并立即验证——包含性(解析结果必须在引擎目录
 *      realpath 内)+ 一致性(解析结果必须与原路径逐字一致,否则说明路径中有
 *      symlink 组件),任一不过即拒绝本文件不落盘;通过后用解析出的真实父目录
 *      做 rename。七轮的 realpath 只取不验:中间目录被竞态换成外部 symlink
 *      时 rename 落到引擎目录外,换成内链时 rename 也沿 symlink 组件到达
 *      别处。**残余窗口如实记录**:JS 无 O_NOFOLLOW,realpath→rename 一瞬
 *      之间父目录链仍可能被竞态替换(窗口=相邻系统调用间隔,无法归零),
 *      窗口内的替换同样被包含性+一致性验证拦截,跨窗口竞态如实为已知限制;
 *    ②收尾清理以「确认自建」为前提:'wx' 独占 openSync 成功返回是独立的
 *      创建成功点(临时文件校验时序:创建→写→lstat/realpath 校验→读回核验
 *      →rename),创建即失败(EEXIST 等)时同名既有文件不是本次创建的,
 *      收尾绝不触碰(七轮失败分支无条件 unlink 可能删掉非本次创建的文件,
 *      此路封死);创建成功后的失败(写一半 EFBIG/读回失败/哈希不符/rename
 *      失败)才允许收尾 unlink 自建临时文件;
 *    ③暂存副本**独立唯一子目录**:不再按 basename 落暂存根顶层(同批
 *      <root>/sub/X.py 与 <root>/X.py 的顶层暂存路径相同,前者的暂存动作
 *      直接覆盖后者的源文件),改为按已清洗防碰撞的报文相对路径展开到
 *      <root>/.staged/<相对路径>(与产物映射同一套防碰撞防逃逸规则),同批
 *      互不覆盖,也碰不到任何源文件或应用台账。
 *  - F3 七轮(2026-11-07 第七轮复审):根内外命名空间碰撞消除 + 悬空 symlink
 *    穿透/检查-写入竞态消除——
 *    ①产物命名空间**只认暂存根(--root)内路径**:根外绝对路径直接拒绝整批
 *    (报错,不写盘不落台账)——六轮的「根外回落按绝对路径全结构展开」与根内
 *    相对路径共享同一命名空间(/stage/tmp/X.py 与 /tmp/X.py 都落 tmp/X.py,
 *    分批发送互覆盖),修后碰撞从映射规则上不存在;发送侧同步只发暂存根内
 *    路径(roundtripProbe 发送前校验);
 *    ②悬空 symlink 穿透封死:写前 **lstat 最终组件**——是 symlink(无论悬空
 *    与否)一律拒绝(lstat 不跟随链接,悬空也拿到 symlink 状态,六轮 realpath
 *    抛 ENOENT 回落「最深已存在祖先」的误判穿不过);
 *    ③**temp+rename 原子写**:产物先写为引擎目录内 'wx' 独占自建临时文件
 *    (进程级唯一名字绝不碰撞,O_EXCL 绝不沿既有任何路径——含 symlink——
 *    写入),内容与 digest 核验全部在临时文件上完成,最后 fs.rename 原子替换
 *    到产物位(rename 不跟随目标 symlink,检查-写入 TOCTOU 从写入机制上
 *    消除;rename 目标目录组件用 realpath 构建无 symlink 中间层);临时文件
 *    写前同样 lstat/realpath 校验;
 *    ④失败收尾只清理自建临时文件(best-effort,失败如实 rollback_failed)——
 *    引擎目录既有产物从头到尾不被触碰,五/六轮「还原原内容」回滚通路退役
 *    (八轮②进一步收窄:只有「确认自建」的临时文件才在收尾清理之列)。
 *  - F3 六轮(2026-11-06 复审):确定性映射+逃逸防护+读语义收窄——
 *    ①产物路径**确定性映射**:不再按批内共同祖先剥离(随批次组成漂移,跨批
 *    同名文件相互覆盖),永远按报文内完整相对路径展开,基准只随暂存根定,与
 *    批次组成无关;暂存根之外的文件回落按绝对路径全结构展开(同样确定性;
 *    ——该回落已被七轮①废除:根外路径直接拒绝整批,此处仅存历史);
 *    ②**符号链接逃逸防护**:写/unlink 前对目标 realpath 解析(目标不存在时
 *    取最深已存在祖先),仍在 artifact-dir(realpath)内才动手,否则拒绝;
 *    ③写前读旧产物**仅 ENOENT 视为不存在**,其他读异常(EACCES/EIO)如实
 *    failed 拒绝写入且不删除(不再误删预存在产物);旧内容以 Buffer 保存
 *    恢复(非 UTF-8 文件按原字节还原),写后核验哈希按原始字节算。
 *  - F3 五轮(2026-11-06 复审硬化)【已退役,由七轮③/八轮②取代】:回滚契约
 *    收窄为 best-effort 且如实——失败回滚**还原原内容**而非删除(绝不误删
 *    引擎目录里已 applied 的旧产物),回滚只及本次失败那一个文件;清理失败时
 *    回执如实新增 rollback_failed 字段=残留文件路径,绝不谎称「已回滚无
 *    残留」。现役机制:temp+rename 下既有产物从未被触碰(七轮③),收尾只清
 *    「确认自建」的临时文件(八轮②),rollback_failed 字段语义保留。
 *  - F3 四轮(2026-11-06 复审,设计级重做):三轮的「外部应用命令 + 产物
 *    哈希核验」仍有协议级残余——应用委托给外部命令,接收端无法证明引擎目录
 *    里的产物是**本次命令**写的(命令可以是任何代码,产物核验只能证明「目录
 *    里有份内容一致的东西」,证明不了应用通路)。修后 applied 路径改为
 *    **接收端自己写产物**:按报文 files 读到内容后,由接收端自身代码直接把
 *    该内容落盘引擎目录(--artifact-dir),写后对产物重算 sha256 与报文
 *    sender_digests[file] 比对一致才回 applied;落盘失败/哈希不符一律如实
 *    failed,且**回滚已写产物**(unlink,引擎目录不留半套残留)。
 *  - 外部命令模式降级:--apply-command 配置的命令仍会执行(真实副作用,如
 *    触发引擎 reloadScript 包装),但其副作用**不可证实**(接收端证明不了产
 *    物是本次命令写的),退出 0 也最多 accepted(带降级原因注解),绝不自称
 *    applied、不落应用台账;命令执行失败仍如实 failed(副作用失败是真失败)。
 *    空操作场景从设计上不存在假 applied:接收端没写产物就没有产物哈希可核验。
 *  - F3 三轮(2026-11-06 复审):协议报文带 sender_digests 字段:{"files":[...],
 *    "sender_digests":{"<file>":"<发送方冻结 sha256 hex>"}}(发送方冻结
 *    digest 随报文下发)——现为接收端自写产物的核验基准。旧「源文件前后
 *    哈希」比较废除:它证明不了引擎加载的是发送方冻结的内容。
 *  - apply 模式未配置 --artifact-dir 时接收端写不了产物,如实回 accepted
 *    (仅暂存,未应用)+未配置原因,不落应用台账——没有引擎落盘就没有
 *    applied 证据。
 *  - 暂存副本失败如实回 failed(不再静默忽略后继续自称 accepted/applied)。
 *
 * 用法:
 *   node referenceReceiver.mjs --port 0 --root <暂存目录> --mode stage|apply
 *        [--apply-command <shell 命令>] [--artifact-dir <引擎产物目录>]
 *        --scenario accepted|applied|digest-mismatch|echo|error500
 * 就绪后向 stdout 打一行 KODE_RECEIVER_PORT=<port>。
 *
 * - POST /reload:body 形如 {"files":[...],"targetId":"...","sender_digests":
 *   {"<file>":"<发送方冻结 sha256 hex>"}}(通道 ${files}/${targetId} 占位
 *   substitution + 发送方冻结 digest 自动附带产物)或裸 JSON 数组;逐文件读盘、
 *   sha256、暂存副本进 --root,按 mode 回:
 *   - stage:   每文件一条 accepted(暂存=接收端已收下待重载)
 *   - apply:   接收端自己写产物进 --artifact-dir,产物 sha256 与
 *              sender_digests[file] 一致才回 applied(revision 递增);
 *              配了 --apply-command 则执行命令但降级 accepted(副作用不可证实)
 *   - digest-mismatch: 形态同 applied 但 digest 故意错(可疑回执样本)
 *   - echo:    回纯文本非 JSON(未知结构样本)
 * - GET /probe(其余任何路径):200 "ok"(连通性探测面)。
 * - --scenario error500:重载端点回 500。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const argValue = name => {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
};

const port = Number(argValue('--port') ?? 0);
const root = argValue('--root') ?? process.cwd();
const mode = argValue('--mode') ?? 'stage';
const applyCommand = argValue('--apply-command');
// F3 四轮:引擎产物目录(接收端自己把应用产物写进这里),applied 核验对象
const artifactDir = argValue('--artifact-dir');
const scenario = argValue('--scenario') ?? (mode === 'apply' ? 'applied' : 'accepted');

mkdirSync(root, { recursive: true });

const sha256Hex = content => createHash('sha256').update(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')).digest('hex');
// F3 八轮(2026-11-08 第八轮复审):失败收尾=只清理**已确认自建**的临时文件
// ——创建动作('wx' 独占 openSync)本身是独立的成功点:成功返回才算「自建」,
// 之后的失败(写一半 EFBIG/读回失败/哈希不符/rename 失败)才允许收尾 unlink;
// 创建即失败(EEXIST 等)时该路径上的同名文件**不是本次创建的**,绝不触碰
// (七轮的无条件 unlink 可能删掉非本次创建的文件,封死)。temp+rename 原子写
// 下,失败路径里引擎目录里的既有产物从头到尾未被触碰(原产物天然原样保留,
// 五/六轮的「还原原内容」回滚通路退役);清理失败如实返回残留路径,由回执
// rollback_failed 字段上报,绝不谎称无残留
// F3 九轮(2026-11-06 第九轮复审):「确认自建」之上再钉 **dev/ino 比对**——
// 八轮的标志位只回答「这个路径上的文件是不是我创建的」,防不住「创建后、
// 收尾前路径被竞态替换成别的文件」:替换文件与创建判定无关联,按路径 unlink
// 仍会删掉不是本次创建的文件。修后创建成功点 fstatSync(fd) 捕获 dev/ino,
// 收尾 unlink 前 lstat 比对路径当前 dev/ino 与捕获一致才删;不符或捕获缺失
// (身份无法确认)→ 跳过,返回 {skipped:true, path} 由回执 rollback_skipped
// 字段如实上报,不触碰。**残余窗口如实记录**:lstat 比对→unlink 一瞬之间
// 路径仍可能被竞态替换(窗口=相邻系统调用间隔,无法归零),与 realpath→rename
// 窗口同级,如实为已知限制,不自称「绝不删错」
const cleanupTempArtifact = (tempArtifact, created, createdStat) => {
  // 非自建(创建即失败):收尾目标=不动任何既有文件,天然达成
  if (!created) {
    return undefined;
  }
  if (createdStat === undefined) {
    // 身份无法确认(创建点捕获缺失):宁留残留也不按路径盲删
    return { skipped: true, path: tempArtifact };
  }
  let currentState;
  try {
    currentState = lstatSync(tempArtifact);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      // 已不存在:清理目标已达成
      return undefined;
    }
    return tempArtifact;
  }
  if (currentState.dev !== createdStat.dev || currentState.ino !== createdStat.ino) {
    // 路径已被替换为其他文件:不是本次创建的那个,跳过不触碰
    return { skipped: true, path: tempArtifact };
  }
  try {
    unlinkSync(tempArtifact);
    return undefined;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      // 已不存在:清理目标已达成
      return undefined;
    }
    return tempArtifact;
  }
};
const tempCleanupReceipt = (file, tempArtifact, reasonBase, created, createdStat) => {
  const residual = cleanupTempArtifact(tempArtifact, created, createdStat);
  let outcome;
  let skippedPath;
  if (residual === undefined) {
    outcome = '(临时文件已清理,引擎目录原产物未动无残留)';
  } else if (residual !== null && typeof residual === 'object') {
    skippedPath = residual.path;
    outcome = `(回滚跳过:临时文件身份无法确认(创建点 dev/ino 捕获缺失或路径已被竞态替换),不触碰,残留:${skippedPath})`;
  } else {
    outcome = `(回滚失败,残留:${residual})`;
  }
  const receipt = { status: 'failed', file, reason: `${reasonBase}${outcome}:不自称 applied` };
  if (skippedPath !== undefined) {
    receipt.rollback_skipped = skippedPath;
  } else if (residual !== undefined) {
    receipt.rollback_failed = residual;
  }
  return receipt;
};
const APPLIED_LEDGER = path.join(root, 'applied-revisions.jsonl');
let appliedRevision = 0;

// F3 六轮(2026-11-06 复审 FAIL-2):符号链接逃逸防护——字符串清洗防不住产物
// 目录内的 symlink 指向目录外(沿它写入/unlink 都作用在引擎目录外的真实目标
// 上)。写/unlink 前对目标做 realpath 解析(目标未创建时逐级向上找最深已存在
// 祖先),验证解析结果仍在 artifact-dir(realpath)内,否则返回 undefined 由
// 调用方拒绝(报错,不写不删)。artifactDir 本身也按 realpath 对齐(目录本身
// 是合法 symlink 时不误判)。
const realPathWithinBase = (target, baseReal) => {
  let probe = target;
  for (;;) {
    try {
      probe = realpathSync(probe);
      break;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        const parent = path.dirname(probe);
        if (parent === probe) {
          break;
        }
        probe = parent;
        continue;
      }
      return undefined;
    }
  }
  // probe 是目标或其最深已存在祖先:等于 baseReal(直接子文件)或在其内
  // 都算安全,只有解析到 baseReal 之外('..' 前缀/绝对路径)才是逃逸
  const rel = path.relative(baseReal, probe);
  return !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel) ? probe : undefined;
};
const realPathWithinArtifactDir = target => {
  try {
    return realPathWithinBase(target, realpathSync(artifactDir));
  } catch {
    return undefined;
  }
};
// F3 七轮(2026-11-07 第七轮复审):悬空 symlink 穿透封死 + temp+rename 原子
// 写——六轮的 realpath 逃逸防护有两个残余:
//  ①最终组件是「指向目录外不存在文件」的悬空 symlink 时,realpath 抛 ENOENT
//    回落到最深已存在祖先(引擎目录本身)→ 误判安全 → writeFileSync 沿悬空
//    链接把产物写到引擎目录外;
//  ②realpath 检查与 writeFileSync 之间存在检查-写入(TOCTOU)窗口,竞态可在
//    检查通过后把产物位换成 symlink,写入照样沿新链接逃逸。
// 七轮组合拳:
//  ①写前 lstat 最终组件——是 symlink(无论悬空与否)一律拒绝,lstat 不跟随
//    链接(悬空链接也拿到 symlink 状态),六轮的「最深已存在祖先」回落穿不过;
//  ②产物改 **temp+rename 原子写**:先在引擎目录内以 'wx' 独占创建自建临时
//    文件(O_EXCL:名字进程级唯一绝不碰撞,且绝不沿既有任何路径——含
//    symlink——写入),内容与 digest 核验全部在临时文件上完成,最后 fs.rename
//    原子替换到产物位——rename 不跟随目标 symlink(竞态即使在检查后把产物
//    位换成 symlink,也是被整体替换而非被沿写逃逸),检查-写入 TOCTOU 从
//    写入机制上消除;rename 目标的目录组件用 realpath 解析后的真实父目录
//    构建(路径中不再有 symlink 组件);临时文件写前同样 lstat/realpath 校验;
//  ③失败收尾只清理自建临时文件(best-effort,失败如实 rollback_failed)——
//    引擎目录里的既有产物从头到尾不被触碰,「还原原内容」回滚通路退役。
const safeArtifactTarget = artifact => {
  // 父目录链:realpath 解析(目标不存在时取最深已存在祖先)必须在引擎目录内
  const parentCheck = realPathWithinArtifactDir(path.dirname(artifact));
  if (parentCheck === undefined) {
    return undefined;
  }
  try {
    const finalState = lstatSync(artifact);
    // 最终组件存在:是 symlink(悬空与否)一律拒绝;其余须经 realpath 确认
    // 仍在引擎目录内(防 '..' 之外的文件系统级逃逸)
    if (finalState.isSymbolicLink()) {
      return undefined;
    }
    return realPathWithinArtifactDir(artifact);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      // 最终组件真不存在(lstat 对悬空链接成功返回,走上面的拒绝;这里只收
      // 真不存在):父目录链已验,安全
      return parentCheck;
    }
    return undefined;
  }
};
// F3 八轮(2026-11-08 第八轮复审):rename 目标父目录双重验证——七轮 rename
// 前 realpath 父目录但**不验包含性、也不验一致性**:中间目录被竞态换成外部
// symlink 时,realpath 解析结果在引擎目录外,rename 就落到外部;换成内链时
// rename 也沿真实父目录落盘(路径实际经 symlink 组件到达别处)。修后 rename
// 前立即 realpathSync(父目录) 并验证:①包含性——解析结果必须在引擎目录
// (realpath)内;②一致性——解析结果必须与原路径逐字一致(否则说明路径中有
// symlink 组件),任一不过即拒绝本文件不落盘;③通过后用解析出的真实父目录做
// rename(JS 无 O_NOFOLLOW,realpath→rename 一瞬的残余窗口如实记录,见设计
// §4.3;窗口内的竞态同样被包含性+一致性验证拦下)
const verifiedRealParentForRename = (dir, artifactDirReal) => {
  try {
    const real = realpathSync(dir);
    const resolved = path.resolve(dir);
    const rel = path.relative(artifactDirReal, real);
    if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
      // 包含性:解析到引擎目录外(中间目录被换成外部 symlink)
      return undefined;
    }
    if (real !== resolved) {
      // 一致性:路径中有 symlink 组件(解析结果 ≠ 原路径)
      return undefined;
    }
    return real;
  } catch {
    return undefined;
  }
};
// F3 九轮(2026-11-06 第九轮复审):暂存路径写前双重验证——暂存副本此前无
// symlink 检查:.staged(或更深目录)被换成指向暂存根外/内的 symlink 时,
// copyFileSync 沿链接把暂存副本写到别处(外=逃逸;内=覆盖暂存根内其他文件)。
// 修后对暂存父目录链取**最深已存在祖先**判定:①包含性——已存在链的
// realpath 必须在暂存根 real 内;②一致性——相对比较(解析路径相对暂存根
// real 的相对路径,与原路径相对暂存根字面值的相对路径逐字一致):树内出现
// symlink 组件即不等被拒,而暂存根自身的合法 symlink 祖先(如 macOS
// /tmp → /private/tmp)不误判;③realpath 失败但组件存在(悬空 symlink 链)
// → 直接拒绝;④lstat 最终组件——是 symlink(无论悬空与否)一律拒绝;任一
// 不过返回 undefined 由调用方拒绝本文件暂存(检查→mkdir→copy 一瞬的残余
// 窗口,与 rename 同级,如实记录)
const verifiedRealAncestorWithin = (dir, baseReal, baseLiteral) => {
  let probe = dir;
  for (;;) {
    let real;
    try {
      real = realpathSync(probe);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        // realpath 失败但组件存在 → 悬空 symlink 链:拒绝(不向上回落——
        // 「不存在的组件无从是 symlink」的推断只对真不成立,悬空链也是 symlink)
        try {
          lstatSync(probe);
          return undefined;
        } catch {
          const parent = path.dirname(probe);
          if (parent === probe) {
            return undefined;
          }
          probe = parent;
          continue;
        }
      }
      return undefined;
    }
    const relReal = path.relative(baseReal, real);
    if (relReal.startsWith(`..${path.sep}`) || relReal === '..' || path.isAbsolute(relReal)) {
      // 包含性:已存在链解析到暂存根外
      return undefined;
    }
    // 一致性:按相对比较(树内 symlink 组件 → 两个相对路径不等);暂存根自身
    // 的合法 symlink 祖先不影响(baseReal/baseLiteral 各自为基准)
    if (path.relative(baseLiteral, probe) !== relReal) {
      return undefined;
    }
    return real;
  }
};
// 源路径祖先链 symlink 探测(九轮复审 FAIL-A):源文件 realpath 解析失败
// (如悬空别名)时,无法证明它不在暂存树内——批内更早文件的暂存动作可能
// 恰好补齐其目标,读取阶段经别名「复活」。祖先链(至暂存根为止)任一级是
// symlink → 疑似别名,由调用方拒绝整批;祖先全为真实目录 = 路径真不存在,
// 交由读取阶段如实回「接收端读不到所发文件」。暂存根自身是合法 symlink
// (FAIL-4 兼容)不算可疑,故从 dirname 向上、不含基准本身。
const hasSymlinkAncestor = (file, base) => {
  let probe = path.dirname(file);
  for (;;) {
    // 停止条件先行:基准(暂存根)自身是合法 symlink(FAIL-4 兼容)不算可疑,
    // 也绝不越出其字面路径向上探
    const rel = path.relative(base, probe);
    if (rel === '' || rel.startsWith(`..${path.sep}`) || rel === '..') {
      return false;
    }
    try {
      if (lstatSync(probe).isSymbolicLink()) {
        return true;
      }
    } catch {
      // 组件不存在:继续向上探
    }
    probe = path.dirname(probe);
  }
};
const safeStagingTarget = (staged, rootReal, rootLiteral) => {
  const realAncestor = verifiedRealAncestorWithin(path.dirname(staged), rootReal, rootLiteral);
  if (realAncestor === undefined) {
    return undefined;
  }
  try {
    const finalState = lstatSync(staged);
    // 最终组件存在:是 symlink(悬空与否)一律拒绝
    if (finalState.isSymbolicLink()) {
      return undefined;
    }
    return realPathWithinBase(staged, rootReal);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      // 最终组件真不存在:已存在链已验(包含性+一致性),安全
      return realAncestor;
    }
    return undefined;
  }
};

// F3 八轮:内部助手按 ES 模块导出(单元测试直接钉收尾标志位与 rename 父目录
// 验证的语义;九轮再加暂存路径验证);脚本被 node 直接运行时行为不变(main
// 守卫见文件末尾)。
export { cleanupTempArtifact, tempCleanupReceipt, verifiedRealParentForRename, safeStagingTarget };

const recordApplied = entry => {
  appendFileSync(APPLIED_LEDGER, `${JSON.stringify(entry)}\n`, 'utf8');
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (request.method === 'GET') {
    // 连通性探测面(transport probe 用 GET 无体请求)
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  if (url.pathname !== '/reload') {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }
  if (scenario === 'error500') {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('internal receiver error (scenario)');
    return;
  }

  let raw = '';
  request.on('data', chunk => {
    raw += chunk.toString('utf8');
  });
  request.on('end', () => {
    if (scenario === 'echo') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('receiver said ok, move along');
      return;
    }
    let files;
    let targetId;
    let senderDigests;
    try {
      const parsed = JSON.parse(raw);
      files = Array.isArray(parsed) ? parsed : parsed.files;
      if (!Array.isArray(parsed) && parsed && typeof parsed === 'object' && typeof parsed.targetId === 'string') {
        targetId = parsed.targetId;
      }
      // F3 三轮:发送方冻结 digest 随报文下发(file → sha256 hex 字符串)
      if (
        !Array.isArray(parsed) &&
        parsed &&
        typeof parsed === 'object' &&
        parsed.sender_digests &&
        typeof parsed.sender_digests === 'object' &&
        !Array.isArray(parsed.sender_digests)
      ) {
        senderDigests = parsed.sender_digests;
      }
    } catch {
      files = undefined;
    }
    if (!Array.isArray(files) || files.length === 0) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'failed', reason: 'body 无 files 数组' }));
      return;
    }
    const withTarget = receipt => (targetId !== undefined ? { ...receipt, targetId } : receipt);
    const receipts = [];
    // F3 五轮(2026-11-06 复审硬化):产物路径不再只用 basename——按报文内
    // 相对路径映射到 --artifact-dir 子结构,不同目录同名文件各归各的子路径,
    // 不再相互踩踏;批内清洗后仍映射到同一产物位置(同名碰撞)→ 拒绝整批:
    // 不写任何盘、不落任何台账。
    // F3 六轮(2026-11-06 复审 FAIL-1):产物路径**确定性映射**——不再按批内
    // 共同祖先剥离(共同祖先随批次组成漂移:subA/X.py、subB/X.py 同批→各归
    // 子目录,分两次单文件发送→都落 basename,后者覆盖前者)。改为永远按报文
    // 内完整相对路径展开,基准只随接收端暂存根(--root)定,与批次组成无关:
    // 同一文件无论单发/合批发,落位唯一;暂存根之外的文件回落按绝对路径全
    // 结构展开(同样确定性)。路径安全清洗(任何 '..'/'.'/空段=逃逸)不过关,
    // 或映射到同一产物位置(同一路径批内重复)→ 拒绝整批:不写任何盘、不落
    // 任何台账。
    const stringFiles = files.filter(file => typeof file === 'string');
    const artifactSegmentsByFile = new Map();
    let batchRejectReason;
    if (stringFiles.length > 0) {
      const byKey = new Map();
      // F3 九轮复审补口:暂存树 realpath(存在时)——源路径别名检查基准
      let stagedTreeReal;
      try {
        stagedTreeReal = realpathSync(path.join(root, '.staged'));
      } catch {
        stagedTreeReal = undefined;
      }
      for (const file of stringFiles) {
        // F3 七轮(2026-11-07 第七轮复审 FAIL-1):根内外命名空间碰撞消除——
        // 六轮对暂存根之外的文件回落「绝对路径全结构展开」,但那个回落与根内
        // 相对路径共享同一命名空间:/stage/tmp/X.py(根内)映射 tmp/X.py,
        // /tmp/X.py(根外)回落也展开成 tmp/X.py——分批发送互覆盖。修后**根外
        // 路径直接拒绝整批**(报错,不允许暂存根之外的绝对路径作为产物目标;
        // 发送侧同步只发暂存根内路径):产物命名空间只剩根内相对路径一种归属,
        // 碰撞从映射规则上不存在。路径安全清洗与同址碰撞拒绝整批保持不变。
        const relative = path.relative(root, file);
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
          batchRejectReason = `产物路径在暂存根之外(--root)(${file}):拒绝整批,不写盘`;
          break;
        }
        const segments = relative.split(path.sep);
        if (relative === '' || segments.some(segment => segment === '..' || segment === '.' || segment === '')) {
          batchRejectReason = `产物相对路径清洗后不安全(${relative}):拒绝整批,不写盘`;
          break;
        }
        // F3 九轮:'.staged' 前缀属接收端暂存命名空间——八轮的暂存唯一子目录把
        // 暂存副本展开到 <root>/.staged/<相对路径>,源路径若不排除该前缀,同批
        // 含既有 <root>/.staged/X.py 时 <root>/X.py 的暂存副本会直接覆盖该源
        // 文件。修后源命名空间与暂存命名空间从映射规则上不相交(拒绝整批,与
        // 路径清洗同一防线)
        if (segments[0] === '.staged') {
          batchRejectReason = `所发文件进入接收端暂存命名空间(.staged)(${file}):拒绝整批,不写盘`;
          break;
        }
        // F3 九轮复审补口:词法排除挡不住指向暂存树的 symlink 别名——root/alias
        // → root/.staged 时,同批 <root>/X.py 的暂存副本覆盖的正是 alias/X.py
        // 实际指向的源文件。修后对源文件 realpath 解析,解析结果落在暂存树
        // realpath 内 → 拒绝整批;realpath 失败但祖先链含 symlink 组件(悬空
        // 别名)= 无法证明不在暂存树内——批内更早文件的暂存动作可能补齐其
        // 目标,读取阶段经别名「复活」——同样拒绝;祖先全为真实目录 = 路径真
        // 不存在,交由读取阶段如实回「接收端读不到所发文件」
        let sourceReal;
        try {
          sourceReal = realpathSync(file);
        } catch {
          sourceReal = undefined;
        }
        if (sourceReal === undefined) {
          // 文件自身是 symlink(悬空与否——悬空才走到这里)或祖先链含 symlink
          // 组件 → 无法证明不在暂存树内,写入前拒绝整批
          let finalIsSymlink = false;
          try {
            finalIsSymlink = lstatSync(file).isSymbolicLink();
          } catch {
            finalIsSymlink = false;
          }
          if (finalIsSymlink || hasSymlinkAncestor(file, root)) {
            batchRejectReason = `所发文件无法解析真实路径(疑似悬空符号链接别名)(${file}):拒绝整批,不写盘`;
            break;
          }
        } else if (stagedTreeReal !== undefined && realPathWithinBase(sourceReal, stagedTreeReal) !== undefined) {
          batchRejectReason = `所发文件经符号链接解析后落入接收端暂存命名空间(.staged)(${file}):拒绝整批,不写盘`;
          break;
        }
        const key = segments.join('/');
        if (byKey.has(key)) {
          batchRejectReason = `批内不同文件映射到同一产物位置(${key}):同名碰撞拒绝整批,不写盘`;
          break;
        }
        byKey.set(key, file);
        artifactSegmentsByFile.set(file, segments);
      }
    }
    if (batchRejectReason !== undefined) {
      for (const file of stringFiles) {
        receipts.push(withTarget({ status: 'failed', file, reason: batchRejectReason }));
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(receipts.length === 1 ? receipts[0] : receipts));
      return;
    }
    for (const file of files) {
      if (typeof file !== 'string') {
        continue;
      }
      // 接收端视角:读所发文件、留暂存副本、对收到的内容重算 digest
      let content = '';
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        receipts.push(withTarget({ status: 'failed', file, reason: '接收端读不到所发文件' }));
        continue;
      }
      const digest = sha256Hex(content);
      // F3 八轮(2026-11-08 第八轮复审):暂存副本不再按 basename 落暂存根
      // 顶层——同批 <root>/sub/X.py 与 <root>/X.py 的顶层暂存路径相同,前者
      // 的暂存动作会直接把后者的**源文件**覆盖掉。修后每文件按已通过清洗/
      // 防碰撞校验的报文相对路径独立展开到 <root>/.staged/<相对路径>(与产物
      // 映射同一套防碰撞防逃逸规则),同批互不覆盖、也碰不到任何源文件或台账
      const stagedSegments = artifactSegmentsByFile.get(file);
      const staged =
        stagedSegments !== undefined ? path.join(root, '.staged', ...stagedSegments) : undefined;
      try {
        if (staged !== undefined && staged !== file) {
          // F3 九轮:暂存写前双重验证(包含性+相对一致性)+ lstat 拒 symlink——
          // .staged 链上任一级被换成 symlink 时,copyFileSync 沿链接逃逸/错写,
          // 修后任一不过即拒绝本文件暂存(残余 realpath→copy 一瞬窗口如实记录)
          if (safeStagingTarget(staged, realpathSync(root), root) === undefined) {
            receipts.push(
              withTarget({
                status: 'failed',
                file,
                reason: `接收端暂存路径经符号链接解析后逃逸暂存根或含符号链接组件(${staged}):拒绝暂存`
              })
            );
            continue;
          }
          mkdirSync(path.dirname(staged), { recursive: true });
          copyFileSync(file, staged);
        }
      } catch (error) {
        // F3:暂存失败如实回 failed,不再静默忽略后继续自称已收下
        receipts.push(
          withTarget({
            status: 'failed',
            file,
            reason: `接收端暂存副本失败:${error instanceof Error ? error.message : String(error)}`
          })
        );
        continue;
      }
      if (mode !== 'apply') {
        receipts.push(withTarget({ status: 'accepted', file }));
        continue;
      }
      // F3 四轮:外部命令模式降级——命令仍会执行(真实副作用),但接收端无法
      // 证明引擎目录里的产物是本次命令写的,退出 0 也最多 accepted(不可证实
      // 的副作用),绝不自称 applied、不落应用台账;命令失败如实 failed。
      if (applyCommand) {
        const result = spawnSync(applyCommand, {
          shell: true,
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            KODE_RELOAD_FILE: file,
            KODE_RELOAD_DIGEST: digest,
            ...(artifactDir !== undefined
              ? { KODE_RELOAD_ARTIFACT: path.join(artifactDir, path.basename(file)) }
              : {}),
            ...(senderDigests !== undefined && typeof senderDigests[file] === 'string'
              ? { KODE_RELOAD_SENDER_DIGEST: senderDigests[file] }
              : {}),
            ...(targetId !== undefined ? { KODE_RELOAD_TARGET_ID: targetId } : {})
          }
        });
        if (result.error) {
          receipts.push(
            withTarget({
              status: 'failed',
              file,
              reason: `应用命令执行失败:${result.error.message}`
            })
          );
          continue;
        }
        if (result.status !== 0) {
          const stderrTail = (result.stderr ?? '').trim().split('\n').slice(-1)[0] ?? '';
          receipts.push(
            withTarget({
              status: 'failed',
              file,
              reason: `应用命令失败(exit ${result.status})${stderrTail ? `:${stderrTail}` : ''}`
            })
          );
          continue;
        }
        receipts.push(
          withTarget({
            status: 'accepted',
            file,
            note: '外部应用命令的副作用不可证实(产物非接收端所写,证明不了是本次命令写的):降级 accepted,不自称 applied'
          })
        );
        continue;
      }
      // F3 四轮:applied 路径=接收端自己写产物——未配置引擎产物目录写不了
      // 产物,如实 accepted(仅暂存,未应用),绝不自称 applied
      if (artifactDir === undefined) {
        receipts.push(
          withTarget({
            status: 'accepted',
            file,
            note: '接收端未配置引擎产物目录(--artifact-dir),只暂存未应用,不自称 applied'
          })
        );
        continue;
      }
      const senderDigest =
        senderDigests !== undefined && typeof senderDigests[file] === 'string' ? senderDigests[file] : undefined;
      if (senderDigest === undefined) {
        receipts.push(
          withTarget({
            status: 'failed',
            file,
            reason: '报文缺 sender_digest(发送方冻结 digest),接收端自写产物无比对基准:不写盘不自称 applied'
          })
        );
        continue;
      }
      // 接收端自己写产物:按报文读到的内容直接落盘引擎目录(产物由本进程
      // 'wx' 独占自建 + writeSync 写入,应用通路可证明)
      // F3 五轮:产物路径=按报文内相对路径映射的子结构(不再是裸 basename)
      const artifact = path.join(artifactDir, ...artifactSegmentsByFile.get(file));
      // F3 六轮 → 七轮升级:写前符号链接逃逸检查——①父目录链任一级是目录外
      // symlink 就拒绝;②最终组件是 symlink(无论悬空与否,七轮 lstat)一律
      // 拒绝。报错不写不删,绝不把产物经链接落到引擎目录外
      if (safeArtifactTarget(artifact) === undefined) {
        receipts.push(
          withTarget({
            status: 'failed',
            file,
            reason: `产物路径经符号链接解析后逃逸引擎目录或最终组件为符号链接(${artifact}):拒绝写入不落盘`
          })
        );
        continue;
      }
      // F3 五轮(硬化 4)→ 七轮收窄:写前读旧产物仍作「预存在产物」事实核查
      // ——仅 ENOENT 视为「不存在」,其他读异常(EACCES/EISDIR/EIO 等)如实
      // 拒绝写入且不触碰(七轮 temp+rename 下失败收尾不再动产物,这条核查
      // 保留其「不覆盖不可核验的预存在产物」语义)。
      let preReadFailure;
      try {
        readFileSync(artifact);
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') {
          // 不存在:正常新建路径
        } else {
          preReadFailure = error;
        }
      }
      if (preReadFailure !== undefined) {
        const preReadCode =
          preReadFailure && typeof preReadFailure === 'object' && typeof preReadFailure.code === 'string'
            ? preReadFailure.code
            : 'unknown';
        receipts.push(
          withTarget({
            status: 'failed',
            file,
            reason: `读旧产物失败(${preReadCode}):非 ENOENT,按预存在产物对待,拒绝写入且不删除`
          })
        );
        continue;
      }
      // F3 七轮:temp+rename 原子写——临时文件自建独占('wx'),内容/digest
      // 核验全在临时文件上完成,最后 rename 原子替换产物位;任何失败收尾只
      // 清理临时文件,引擎目录既有产物从未被触碰
      const tempArtifact = path.join(
        artifactDir,
        `.kode-artifact-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${path.basename(artifact)}`
      );
      let tempWriteError;
      // F3 八轮:创建成功点——'wx' 独占 openSync 成功返回才算「自建」,此后
      // 的失败才允许收尾 unlink;openSync 即败(EEXIST 等)→ created=false,
      // 收尾绝不触碰该路径上的既有文件
      let tempCreated = false;
      // F3 九轮:创建成功点同时 fstatSync(fd) 捕获 dev/ino,收尾 unlink 前
      // 与路径当前状态比对,不符或捕获缺失均跳过报 rollback_skipped
      let tempCreatedStat;
      let tempFd;
      try {
        mkdirSync(path.dirname(artifact), { recursive: true });
        // 'wx' 独占创建:同位已有任何东西(含 symlink)→ EEXIST 直接失败,
        // 绝不沿既有路径写入
        tempFd = openSync(tempArtifact, 'wx');
        tempCreated = true;
        // 创建点身份捕获:fstatSync 失败 → createdStat 缺失,收尾按「身份无法
        // 确认」跳过不盲删(异常经外层 catch 如实上报应用失败)
        const createdState = fstatSync(tempFd);
        tempCreatedStat = { dev: createdState.dev, ino: createdState.ino };
        const payload = Buffer.from(content, 'utf8');
        const written = writeSync(tempFd, payload);
        if (written !== payload.length) {
          throw new Error(`临时文件写入不完整(${written}/${payload.length} 字节)`);
        }
        // 临时文件写前同样 lstat/realpath 校验:必须是自己刚建的普通文件,
        // 且 realpath 在引擎目录内
        const tempState = lstatSync(tempArtifact);
        if (tempState.isSymbolicLink() || realPathWithinArtifactDir(tempArtifact) === undefined) {
          tempWriteError = new Error('临时文件自身校验失败');
        }
      } catch (error) {
        tempWriteError = error;
      } finally {
        // fd 任何路径下都关闭,不泄漏(fstatSync 失败/写入失败亦然)
        if (tempFd !== undefined) {
          try {
            closeSync(tempFd);
          } catch {
            // 关闭失败不影响错误上报
          }
        }
      }
      if (tempWriteError !== undefined) {
        const reasonBase = `应用产物落盘失败:${tempWriteError instanceof Error ? tempWriteError.message : String(tempWriteError)}`;
        receipts.push(withTarget(tempCleanupReceipt(file, tempArtifact, reasonBase, tempCreated, tempCreatedStat)));
        continue;
      }
      // 写后重算产物 sha256(按原始字节,在临时文件上与发送方冻结基准比对,
      // 一致才原子替换落位)
      let artifactDigest;
      try {
        artifactDigest = sha256Hex(readFileSync(tempArtifact));
      } catch {
        receipts.push(
          withTarget(
            tempCleanupReceipt(
              file,
              tempArtifact,
              `应用后读不到应用产物(临时文件 ${tempArtifact}),无法核验应用内容`,
              true,
              tempCreatedStat
            )
          )
        );
        continue;
      }
      if (artifactDigest !== senderDigest) {
        // 哈希不符:清理临时文件即可——既有产物从未被触碰(无需还原)
        receipts.push(
          withTarget(
            tempCleanupReceipt(file, tempArtifact, '应用产物 sha256 与 sender_digest 不一致', true, tempCreatedStat)
          )
        );
        continue;
      }
      // 原子替换:rename 前 realpath 父目录并做包含性+一致性双重验证(八轮
      // verifiedRealParentForRename),通过后用解析出的真实父目录构建目标——
      // 路径中无 symlink 组件;rename 本身不跟随目标 symlink——竞态换上的
      // symlink 也被整体替换而非被沿写逃逸
      let renameError;
      try {
        const realParent = verifiedRealParentForRename(path.dirname(artifact), realpathSync(artifactDir));
        if (realParent === undefined) {
          renameError = new Error('rename 目标父目录含符号链接组件或解析到引擎目录外');
        } else {
          renameSync(tempArtifact, path.join(realParent, path.basename(artifact)));
        }
      } catch (error) {
        renameError = error;
      }
      if (renameError !== undefined) {
        const reasonBase = `应用产物原子替换失败:${renameError instanceof Error ? renameError.message : String(renameError)}`;
        receipts.push(withTarget(tempCleanupReceipt(file, tempArtifact, reasonBase, true, tempCreatedStat)));
        continue;
      }
      appliedRevision += 1;
      const entry = {
        revision: appliedRevision,
        file,
        digest: artifactDigest,
        appliedBy: 'receiver-self-write',
        appliedAt: new Date().toISOString()
      };
      try {
        recordApplied(entry);
      } catch {
        // 台账落盘失败不影响回执协议证据本身(revision 已递增)
      }
      receipts.push(
        withTarget({
          status: 'applied',
          file,
          digest: scenario === 'digest-mismatch' ? artifactDigest.replace(/^./, d => (d === '0' ? '1' : '0')) : artifactDigest,
          revision: appliedRevision
        })
      );
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    // 单文件=单对象回执(@http: quick action 逐文件口径,hotReloadReceipt
    // 单目标协议);多文件=逐条数组(parseReloadHttpReceipts 批量口径)。
    response.end(JSON.stringify(receipts.length === 1 ? receipts[0] : receipts));
  });
});

// F3 八轮:main 守卫——被 import(单元测试)时不启动服务,直接运行行为不变
const invokedAsMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  server.listen(port, '127.0.0.1', () => {
    const actual = server.address();
    process.stdout.write(`KODE_RECEIVER_PORT=${actual.port}\n`);
  });
}
