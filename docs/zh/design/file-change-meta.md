# 文件变化元信息(方案 B):identity + version 记忆化解析

> 状态:**已实现**(`src/fileChangeMeta.ts`、`src/fileChangeMetaLog.ts`)。
> 本文是字段面、缓存键与进程归属规则的权威口径;实现与测试须逐条对照。
> 测试真值:`tests/fileChangeMeta.test.ts`(字段面 / 记忆化 / watcher 无关 /
> 进程归属)与 `tests/fileChangeMetaConsumers.test.ts`(两个消费端)。

## 1. 为什么需要这个模块

`createSharedFileEventMerger`(`src/sharedFileEvents.ts`)只交付 `fsPath`、
`identity`、`kind` 与盘上**版本 token**(`${mtimeMs}:${size}`,见
`SharedFileEvent.version`)。消费端真正想要的其余字段——模块名、归属进程、
内容 hash、字节数——由本模块按 `identity + version` **懒**解析,同一版本只算
一次。watcher 热路径本身不新增 IO:合并器保持同步(「首报即达」),不 `await`
的老消费端行为一字不变。

## 2. 字段面

| 字段 | 来源 | 缺省时机 |
|---|---|---|
| `fsPath` | 事件 / 入参 | 恒有 |
| `identity` | `normalizeFileIdentity(fsPath)`(与合并器同一把键) | 恒有 |
| `kind` | 事件(`create`/`change`/`delete`) | 恒有 |
| `fileName` | posix 归一路径的 basename | 恒有 |
| `ext` | `path.posix.extname(fileName)`(`.py`),无扩展为空串 | 恒有 |
| `module` | `resolveModuleDualName(fsPath, scriptRoot).fullModule`——**与热更双名称解析同一口径**(仅 `.py`、严格在脚本根内、非 `__init__.py`、非根下单层、拒绝穿越段) | 路径解不出(脚本根外、非 `.py` 等)——绝不编造 |
| `package` | `module` 首段 | `module` 缺省 |
| `processKind` | 路径归属,见 §5 | 判不出 |
| `processSource` | 归属成功为 `'path'`,否则 `'unresolved'` | 恒有 |
| `processReason` | `shared` / `ambiguous` / `unresolved` 的原因 | 归属到单一进程 |
| `processCandidates` | `ambiguous` 的候选(按路径出现序去重) | 其余结论 |
| `sha256` | 文件字节的 `createHash('sha256')`——与 `hotReloadDefHash`、热更 `sentDigest` 同一原语;**读取时点快照**,见 §3 | `kind === 'delete'`(无内容可哈希,**不是失败**)或读失败 |
| `size`、`mtimeMs` | token 可解析则取自 token,否则取自 `stat` | 两者皆不可得(无 token 且 `stat` 失败) |
| `version` | 事件携带的 token,否则本模块 stat 出来的 token | `stat` 失败且事件没带 |
| `reason` | `stat`/读失败原因(`'; '` 拼接) | 完整解析 |

失败铁律:**部分字段 + `reason`,绝不抛**——消费端在 watcher 回调里不 `await`,
抛出的 rejection 会变成未处理拒绝。

## 3. 解析与缓存(记忆化契约)

- 键 = `identity + version + 路径形态`(`fsPath`、`scriptRoot`)。内容仍按
  version 去重,而路径派生字段(`module`/`package`/进程归属)在根或路径写法
  变化时一律重算——因此运行期切换 `kbengine.hotReload.tempEdit.scriptRoot`
  绝不会回吐过期的模块名/进程,同一文件的两种写法也不会互相冒充;同根同版本
  仍回**同一个对象**(`toBe`)。
- 事件带 `version` → **零 `stat`**;`size`/`mtimeMs` 从 token 解出
  (`<mtimeMs>:<size>`,`mtimeMs` 可带小数)。token 形状不符(如用例里的
  `v1`)则两个字段缺省,同样**不回头 stat**。
- 事件不带 `version` → 本模块 stat 一次铸造键(`stat` 失败 ⇒ 记 `reason`、
  不成键、**不入缓存**,瞬时失败绝不钉死在该路径上)。
- `kind === 'delete'` → 不 stat、不读、不入缓存(终态,无内容可比)。
- 并发首算共享同一个在途 promise → 只读一次;同键后续请求回**同一个对象**
  (`toBe`)。同键换 `kind` 复用已解析字段、只换 `kind` 字段(不重读)。
- 失败态一落定即从缓存摘除;后续非删除事件可能再次尝试读取。
- 容量封顶:缓存是 LRU,上限 512 条(在途 promise 同样计数);淘汰后,后续
  非删除事件可能重读文件。
- **`sha256` 是读取时点的内容快照。** 事件带 version 时读必然发生在交付之后,
  两者之间若有并发写,hash 可能描述比 `version` 更新的内容。本模块**刻意不**
  为核对多 stat 一次——那会打破上面的零 stat 契约;边界如实写在这里。只要
  完整缓存键(identity + version + 路径形态)的缓存项还在且解析成功,内容变了
  而 `${mtimeMs}:${size}` 没变的写入就**不会触发重读**,因而对本解析器不可见
  ——这正是零 stat 契约的代价;缓存未命中时(例如淘汰、失败后重试,或路径、
  `scriptRoot` 变化),非删除事件仍可能重读文件;读取成功才会刷新快照。
- 缓存**每实例一份**:两个实例各自算出逐字段相等的对象(watcher 无关:
  `metaForPath` 与事件路径是同一实现、同一把缓存)。

`metaForPath(fsPath)` 就是 `metaFor({ fsPath, identity, kind: 'change' })`
——手动路径(无 watcher、无事件流)拿到的与事件路径一字不差。

## 4. 为何不同步 enrich

- 合并器「首报即达」是同步契约,而 `stat` 是异步的(KR-AUD-30 已把热路径从
  `statSync` 挪走);同步 enrich 要么阻塞 watcher 回调,要么把同步 IO 重新塞回
  事件热路径。
- 老消费端订阅完就返回、从不 `await`;把 enrich 变成同步,等于让索引失效这种
  「必须便宜且必达」的路径先过一遍 IO 与其失败模式。
- 因此 enrich 是**独立、懒、尽力而为**的一步:元信息行落在消费端已办完事之后,
  解析失败只少一行日志,绝不打断回调链。

## 5. 进程归属(KBEngine 脚本目录约定)

在「脚本根相对路径的目录段」上按序判定:

1. 路径必须落在**脚本根内**;其余(资产 `res/`、外部树、根下单层文件)一律
   `processKind` 缺省、`processSource = 'unresolved'`、
   `processReason = 'unresolved'`。
2. `base`、`cell`、`login`、`logger` **任意层级**都算进程段;`interfaces` 只在
   **一级目录**算进程段——嵌套的 `base/interfaces/…` 是该进程的接口包,归外层
   进程(`base/interfaces/Interface_X.py` → `baseapp`,不产生候选)。
3. 恰好一个进程段 → 该进程,`processSource = 'path'`,不带 `processReason`。
4. 出现两个及以上不同进程段(如 `base/cell/…` 异常布局)→
   `processKind = 'ambiguous'` 并给 `processCandidates`(按路径出现序),
   **不挑一个猜**。
5. 无进程段但含 `common`/`user` 目录 → `processKind = 'shared'` 并带
   `processReason`(共享脚本不指认单一进程)。
6. 都不成立(如 `entity_defs/`、`bots/`、脚本根外)→ 按第 1 条 unresolved。
   **绝不编造进程。**

## 6. 一行格式,两个消费端

`formatFileChangeMeta(meta)` 输出单行:

```
Avatar.py kind=change ext=.py module=cell.Avatar package=cell process=cellapp sha256=8c66f0378e91… version=1700000000000:19
```

- hash 只露前 12 位十六进制 + `…`,不可得写 `-`;
- 判不出的进程写 `process=unresolved`;
- `reason=…` **只在解析失败时出现**(干净行没有 `reason=`),归属说明写 `note=…`。

已接的两个消费端:

1. **热更投递**(`src/hotReload.ts`):`SetupHotReloadOptions.fileChangeMeta`
   ——注入后每条审计行之后按触发文件逐条补 `文件元信息: …`(module/process/
   hash/version),落在既有「KBEngine 热更新」日志通道;不注入则零 IO。元信息行
   是**追加**,不替换五要素审计行。
2. **python 索引事件**(`src/fileChangeMetaLog.ts`,`src/extension.ts` 接线):
   索引合并器的订阅者解析元信息后经既有 `kbengine.jumpLog` 开关落
   `py 变更 …`(「KBEngine Navigation」通道)——**默认关,关时零 IO(连解析都
   不发起)**。它是第二个订阅者,老订阅者的同步口径不动。

## 7. 测试与门禁

- `tests/fileChangeMeta.test.ts`——字段面、同口径模块名、delete/`stat`/读失败
  的如实部分字段、记忆化(并发与先后)、watcher 无关(`metaForPath` 与事件路径)、
  进程归属。
- `tests/fileChangeMetaConsumers.test.ts`——两处接线:注入后的热更审计元信息行、
  「不注入即无元信息行」、索引腿受 `jumpLog` 门控(关=零 IO,开=同一行格式)。
- 门禁:`pnpm exec vitest run`、`pnpm run compile`(tsc)、`pnpm run lint`。
