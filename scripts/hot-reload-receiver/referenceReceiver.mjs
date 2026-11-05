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
  copyFileSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import * as path from 'node:path';

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

const sha256Hex = content => createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
// F3 五轮(2026-11-06 复审硬化):回滚=best-effort 清理本次已写/已截断的产物,
// 任何失败路径(落盘失败/读回失败/哈希不符)都过这里;清理失败**如实返回残留
// 路径**,由调用方在回执 rollback_failed 字段上报,绝不吞掉错误再谎称无残留
const rollbackArtifact = artifact => {
  try {
    unlinkSync(artifact);
    return undefined;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      // 本来就不在(写失败分支没创建成功):清理目标已达成
      return undefined;
    }
    return artifact;
  }
};
// F3 五轮:failed 回执统一构造——清理失败时 reason 按事实措辞(残留:<path>),
// 并新增 rollback_failed 字段=残留路径;清干净才允许说「无残留」
const failedWithRollback = (file, artifact, reasonBase, detail) => {
  const residual = rollbackArtifact(artifact);
  const receipt = {
    status: 'failed',
    file,
    reason:
      residual !== undefined
        ? `${reasonBase}(${detail}失败,残留:${residual}):不自称 applied`
        : `${reasonBase}(${detail},引擎目录无残留):不自称 applied`
  };
  if (residual !== undefined) {
    receipt.rollback_failed = residual;
  }
  return receipt;
};
const APPLIED_LEDGER = path.join(root, 'applied-revisions.jsonl');
let appliedRevision = 0;

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
    // 相对路径(批内共同祖先为基准)映射到 --artifact-dir 子结构,不同目录
    // 同名文件各归各的子路径,不再相互踩踏;路径安全清洗(任何 '..'/'.'/
    // 空段=逃逸)不过关,或清洗后仍映射到同一产物位置(如同一路径在批内
    // 重复),一律拒绝整批:不写任何盘、不落任何台账。
    const stringFiles = files.filter(file => typeof file === 'string');
    const artifactSegmentsByFile = new Map();
    let batchRejectReason;
    if (stringFiles.length > 0) {
      const dirParts = stringFiles.map(file => path.dirname(file).split(path.sep));
      let common = dirParts[0];
      for (const candidate of dirParts.slice(1)) {
        let index = 0;
        while (index < common.length && index < candidate.length && common[index] === candidate[index]) {
          index += 1;
        }
        common = common.slice(0, index);
      }
      const commonDir = common.join(path.sep) || path.sep;
      const byKey = new Map();
      for (const file of stringFiles) {
        const relative = path.relative(commonDir, file);
        const segments = relative.split(path.sep);
        if (relative === '' || segments.some(segment => segment === '..' || segment === '.' || segment === '')) {
          batchRejectReason = `产物相对路径清洗后不安全(${relative}):拒绝整批,不写盘`;
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
      const staged = path.join(root, path.basename(file));
      try {
        copyFileSync(file, staged);
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
      const digest = sha256Hex(content);
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
      // writeFileSync 写入,应用通路可证明)
      // F3 五轮:产物路径=按批内相对路径映射的子结构(不再是裸 basename)
      const artifact = path.join(artifactDir, ...artifactSegmentsByFile.get(file));
      let writeError;
      try {
        mkdirSync(path.dirname(artifact), { recursive: true });
        writeFileSync(artifact, content, 'utf8');
      } catch (error) {
        writeError = error;
      }
      if (writeError !== undefined) {
        // F3 五轮:写失败(含部分写入/截断残留)也 best-effort 清理刚碰过的
        // 产物文件;清理失败如实 rollback_failed,绝不直接返回 failed 就完事
        const reasonBase = `应用产物落盘失败:${writeError instanceof Error ? writeError.message : String(writeError)}`;
        receipts.push(withTarget(failedWithRollback(file, artifact, reasonBase, '已回滚')));
        continue;
      }
      // 写后重算产物 sha256,与发送方冻结基准比对一致才回 applied
      let artifactDigest;
      try {
        artifactDigest = sha256Hex(readFileSync(artifact, 'utf8'));
      } catch {
        receipts.push(
          withTarget(
            failedWithRollback(
              file,
              artifact,
              `应用后读不到应用产物(${artifact}),无法核验应用内容`,
              '已回滚'
            )
          )
        );
        continue;
      }
      if (artifactDigest !== senderDigest) {
        // 哈希不符:回滚已写产物(best-effort,清理失败如实 rollback_failed)
        receipts.push(
          withTarget(
            failedWithRollback(file, artifact, '应用产物 sha256 与 sender_digest 不一致', '已回滚')
          )
        );
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

server.listen(port, '127.0.0.1', () => {
  const actual = server.address();
  process.stdout.write(`KODE_RECEIVER_PORT=${actual.port}\n`);
});
