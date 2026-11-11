# DBG-COMPAT 批 A+B(01-04):引擎目标 Python 版本来源与 debugpy 兼容策略 —— 修复纪实(2026-11-12)

账本:`todo.md`「Python 3.7.3 调试工具链兼容」DBG-COMPAT-01..04。口径基线
= [调试安装约束](../zh/guide/python-debugger-compatibility.md)(并发文档
会话落,本批不碰其文件):Python 3.7.x → `debugpy==1.7.0` 严格 +
`ms-python.debugpy@2024.0.0`;3.8 → 1.8.1 线;3.9 → 1.8.13 线;
`2024.0.1` Python 扩展是复现基线非官方声称。

## 缺陷定位(修前)

- `src/autoDebugpy.ts` 全局常量 `EMBEDDED_PYTHON_VERSION='3.12.13'` +
  `MIN_DEBUGPY_VERSION='1.8.0'` 对**所有工程**一刀切:3.7 工程被同步/
  预检闸拒绝它唯一可用的 debugpy 1.7.0,并被 `-U debugpy` 指引推上
  1.8.x(1.8.0 起官方要求 ≥3.8,该包在 3.7 引擎里 import 即崩);
- `debugpyPreflightAllowsInjection` 对资产树包**只查目录存在**:1.8.0
  的包在树里就放行注入(存在 ≠ 兼容);
- 一键安装/手装指引写死 `-U debugpy`,无视目标;
- 目标版本来源缺失:没有「引擎目标 Python」的概念,判不了兼容。

## 修复

1. **新模块 `src/backend/pythonTarget.ts`(01/02)**:
   - `resolvePythonTarget`:设置 `kbengine.debug.pythonTarget`(新增,
     x.y.z)→ 引擎二进制扫描(`<profile.engineRoot>/kbe/bin/server`,
     前 3 个二进制 × 头部 32MB,latin1 `/3\.\d+\.\d+/g` 候选,跨二进制
     投票:≥2 二进制同现一候选才认;单二进制单候选降级认并如实标注弱
     证据)→ 都无 = **诚实未知**(带来源 detail,绝不回落常量/开发机
     解释器;逐工作区走活动 profile,多工程互不串用);
   - `debugpyPolicyFor`:3.7 → 严格锁 1.7.0(过高也拒);3.8 → 1.8.1、
     3.9 → 1.8.13(pin+下限闸,接受更高);3.10+ → 下限 1.8.0 无精确
     pin;3.6 等无已核实线 / 未知 → 无策略(不盲装);
   - `debugpyVersionSatisfiesPolicy` 单一裁决闸(同步/预检/资产树核对
     三处共用);`debugpyInstallSpecFor` 精确 pip 参数(`==pin` /
     `>=floor`,不再 `-U`);
   - `debugExtensionOn37Line`:ms-python.debugpy 2024.0.x 线核查
     (05 的判定面,接线在批 C)。
2. **同步闸重铸(04)**:`syncDebugpyPackage(ctx, assetsRoot, pythonTarget)`
   ——目标未知拒绝盲同步;探测代码增 `python` 字段(源解释器三段版本),
   **源解释器 Python 行 ≠ 目标行拒绝同步**(pydevd 原生扩展按 CPython
   版本编译=ABI 规则);debugpy 版本不满足策略拒绝(3.7 严格锁文案说明
   1.8.0 起要求 ≥3.8)。「错误平台包」的拒绝蕴含在探测机制里:同步源是
   在目标解释器上**成功 import** 的 debugpy(不可加载的 wheel 根本进不
   了探测),且我们从不从 wheel 直拷。用户手放目录保护(workspaceState
   记账 + skipped-user)原样保留,新旧包不混合(整树替换语义不变)。
3. **预检重铸(03/04)**:`checkInterpreterDebugpy(deps, pythonTarget)`
   探测输出两行(源 Python 行 + debugpy 版本);kind 面从
   `debugpy-outdated` 换 **`debugpy-incompatible`**(过高/过低/无支持线
   同类)+ 新 `target-unknown`(只报装没装,不判兼容不给安装建议);
   缺包建议按策略给精确 pin。`debugpyPreflightAllowsInjection(status,
   pythonTarget, assetsPackageVersion)`:预检 ok 放行;否则读资产树
   `<assets>/scripts/common/debugpy/__init__.__version__` 与策略核对
   (读不出/不满足拦下);目标未知=包可读放行(兼容性不背书);3.6
   等无支持线=资产树包也不放行。
4. **一键安装/指引(03)**:`DebugpyInstallRunner(path, pipArgs)`——
   spawn `<解释器> -m pip <installSpec>`,不再统一 `-U`;
   `buildManualInstallGuide(interpreterPath, installCommand, port)` 用
   预检 spec 拼可复制命令;目标未知(spec null)指引先设置目标,不给
   盲装命令。安装后版本核对:精确 pin 下 pip 解析即目标版本;若环境
   异常致版本不符,下一次预检以 `debugpy-incompatible` 如实报实际
   版本与期望(不假成功)。
5. **接线**:`debugConfig.ts`(defaultCheckDebugpy 带目标;安装/指引走
   spec)、`serverControls.ts` 三点(注入闸 resolves 目标+读资产树版本;
   起监听前同步带目标;debugpySync 命令带目标)、`package.json` +
   `package.nls{,.zh-cn}.json` 新设置 `kbengine.debug.pythonTarget`。
   删除 `EMBEDDED_PYTHON_VERSION`/`MIN_DEBUGPY_VERSION`/
   `compareVersions`(autoDebugpy 版)。

## prove-red(HEAD 上 4/4 红)

stash 5 个源文件 → HEAD 兼容探针(旧签名调用、断言修后应有行为):

| 探针 | HEAD 行为(红) | 修后 |
| --- | --- | --- |
| sync 3.7+1.7.0 放行 | `error`(MIN 1.8.0 错杀) | `synced` |
| 预检 1.7.0 判可用 | `debugpy-outdated` | `ok` |
| 手装指引不含 -U | 含 `-U debugpy` | 精确 spec 命令 |
| 资产树存在≠放行 | `true`(exists-only) | 版本核对拦下 |

恢复 stash 后逐文件重跑套件确认复原;探针文件已删(断言面由正式套件
承载)。

## 测试

- 新 `tests/pythonTarget.test.ts`(18 例):来源优先级(设置优先不触
  引擎探测/非法设置/无引擎根/无二进制/投票判定/弱证据标注/无单一可信
  候选/扇出上限 3)、扫描(latin1 零位移/噪声滤 minor≥40 patch≥100)、
  投票(≥2 可信/互斥未知/单二进制单候选降级)、策略表(3.7 严格/3.8/
  3.9/3.10+/3.6/未知)、裁决闸、安装参数、扩展线(2024.0.x 在线,
  2024.1 起离线)、`pythonTargetDeps` 生产装配(配置源注入/活动 profile
  引擎根/无选择 null);
- `tests/autoDebugpy.test.ts`:同步组重排——目标未知拒绝、3.7+1.7.0
  放行(账本缺陷反转)、3.7+1.8.0 严格拒、ABI 行不一致拒、缺 python
  字段拒、modern 下限拒 + 既有流程面(记账/跳过/升级/手放保护/EROFS)
  全带目标回归;删 compareVersions 钉;
- `tests/debugpyPreflight.test.ts` 重写:两行探测、ok 带目标与 spec、
  精确 pin 建议(断言不含 `-U`)、debugpy-incompatible 双向(3.7+1.8.0
  / 3.12+1.7.0)、target-unknown 诚实态、3.6 无支持线、放行判定 3 参
  面 6 例(兼容放行/不兼容拦/读不出拦/未知放行不背书/3.6 不放行)、
  `readAssetsDebugpyVersion` 真布局往返;
- `tests/debugpyPortProbe.test.ts`:cause 更名 + 不兼容/target-unknown
  分支 + 无 spec 不给安装动作 + 手装指引双形态 + install runner 双参;
- `tests/debugConfigAttachConnect.test.ts` + `helpers/
  debugConfigAttachHarness.ts`:preflight 替身带 target/installSpec;
  手装指引断言改精确命令;过老文案断言改「不兼容」;
- `tests/cov-debug-process.test.ts`:真实链 5 例(假解释器 JSON 增
  `python` 字段)+ 预检 2 例带目标 + install runner 双参。

## 门禁

- `npm run lint` 0;`tsc -p ./` 0;`tsc -p tsconfig.mocha.json` 0;
- `npm run test:unit` 全量:见 todo.md 勾行注(结果与唯一既知红
  KodeHotReload.py@199 记录);
- `xvfb-run -a npm run test:demo:editor` 25 RC=0。

## 批次 C(05/06):扩展版本检测与版本分支回归矩阵

1. **扩展版本检测接线(05)**:`pythonTarget.ts` 新增
   `readDebugpyExtensionVersion`(扩展宿主实测 `ms-python.debugpy` 版本;
   未装/packageJSON 异常 → null 诚实未知;registry 注入可测)+
   `debugExtensionCompatFor`(3.7 目标 × 扩展线判定:2024.0.x 在线;
   新线 → `extension-off-line`,文案给「安装特定版本...」选 2024.0.0 +
   齿轮「忽略升级」步骤,写明绝不自动降级、非 3.7 工程不受影响;扩展
   缺失 → `extension-missing` 诚实缺失;非 3.7/未知目标不看扩展线)。
   接线在 `serverControls.ts` 注入闸:预检放行后核查扩展线,命中问题
   只记 warning(会话去重,不逐组件 5 连播),**引擎侧注入照常**——
   监听不依赖扩展,扩展是 attach 侧依赖;只给步骤,绝不自动降级用户
   扩展。
2. **版本分支回归矩阵(06)**:新 `tests/dbgcompatVersionMatrix.test.ts`
   (16 例)把「目标 × 版本 × 生产入口」钉成一张账:安装参数全分支表;
   同步入口**真 fs 流**(3.7+1.7.0 synced 真复制可读回 / 3.7+1.8.0 严格
   拒且资产树零写入 / ABI 行不一致拒 / modern 下限拒+放行 / 未知目标
   拒盲同步(不触探测)/ 用户手放 skipped-user 原样);预检入口(3.7
   ok+精确 pin / 3.7+1.8.0 incompatible / modern 下限双向 / target-unknown
   无参数 / 3.6 无支持线);注入放行入口(资产树 1.7.0 放行 / 1.8.0 拦 /
   读不出拦 / 未知可读放行不背书 / 3.6 恒不放行);宿主新扩展 × 引擎旧
   目标(2024.1.1+3.7.3 → off-line 账本反例 / 2024.0.7+3.7.3 → ok /
   新线+3.12 → ok / 缺失 → 诚实缺失);远端口径(closed 指引带实测/
   目标版本无 -U、target-unknown 无安装动作)。各分支深钉仍在各自套件,
   本文件防修一处面时另一分支变卦。
3. **prove-red 说明**:05 为纯新增面(HEAD 上无此判定,不存在旧行为
   反转;测试文件本身在 HEAD 无法 import 即证明),06 为回归账本(零
   源码变更);本批行为变化仅在注入闸新增警告路径(additive),正式
   套件判别力断言承载。
4. 文档对账:features.md en+zh `kbengine.debug.pythonTarget` 行补扩展
   线核查子句;一键命令(`debugpyInjectCommand.ts`)不加扩展闸(用户
   显式动作,attach 侧既有预检/指引覆盖版本面)。

## 边界与诚实记录

- **引擎二进制扫描未对真实引擎二进制验证**(本机无 KBEngine 二进制
  剖面可测):投票/扫描机制以合成横幅单测钉住;真机二进制形态(去
  strip/链接方式差异)待 07/08 真机验收批复核——判不出时落「未知」
  态,可用 `kbengine.debug.pythonTarget` 显式指定兜底,不猜;
- **3.7.3 真机 debugpy.listen 未验证**(前轮纪实:临时构建 3.7.3 +
  cp37 wheel import OK 但 listen exit 139 未破案,见
  docs/zh/guide/python-debugger-compatibility.md §7):本批只收 01-04
  的**判定与装配面**,07/08(原生/纯 Python 路径与完整调试链)等真机
  验收,导入成功不抵扣监听/断点验证;
- 05/06 已收口(见上方批次 C 节);剩余 07/08(原生/纯 Python 路径与
  固定扩展完整调试链)等真机验收;
- 文档对账:`docs/guide{,/zh}/configuration.md` 的 debugpySync/
  autoDebugpy 段落在并发文档会话的脏树里,本批不吞;其
  python-debugger-compatibility.md 基线文档与本批行为一致(版本锁
  表同源),待其落库后如有措辞差再对齐;
- `docs/guide/python-debugger-compatibility.md`、`scripts/requirements/`
  为并发会话未跟踪文件,本批不提交。
