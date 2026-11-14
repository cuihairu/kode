# KSEM-CFG-09(SEM-039)配置关联约束检查 — 批次纪实

日期:2026-11-14。todo.md SEM-039(旧 KSEM-CFG-09):检查配置关联约束。验收:逐条核实路径基准、字段组合、引用目标等可静态检查关系;端口冲突按绑定地址/协议/部署角色判断,不简单全局去重。

## 交付面

- **纯核 `src/backend/configRelationChecks.ts`**(零 vscode 零 IO),两入口:
  - **`checkEngineConfigRelations(tree)`**(引擎最终配置树,入口 `<root>` 包裹归一与 configContract 同口径):
    - **端口 claim 分类**(端口冲突判定第一刀):`role = local-bind`(引擎本机监听:externalTcp/externalUdp 三段、各段 telnet、loginapp http_cbport、interfaces 监听区间)/ `outbound-target`(远端目标:bots 登录 loginapp 的端口段、dbmgr 数据库端口、InterfacesServiceAddr 条目端口——**远端目标不参与本机冲突**);telnet 缺元素/非整数回落目录文档化的各段引擎默认端口(defaulted,数值可算);externalTcp `0 = 使用默认` 数值未文档化 → 区间不可解,重叠算术诚实排除;
    - **哨兵逐段语义**(不全局套同一哨兵):loginapp udp `-1` = 不启用、machine udp `0` = 不启用(目录逐段注释取证);哨兵禁用的 claim 不参与重叠;哨兵+对端显式正值 → disabled-sentinel finding(显式值不生效);
    - **端口冲突判定**(第二刀,验收同款):仅 local-bind、同 (协议族 tcp/udp, 绑定面 external/telnet/http-cb/interfaces-listen) 内做闭区间重叠;协议不同不冲突(tcp/udp 各自空间)、绑定面不同不冲突(external 绑 external 面、http-cb 绑 http_cbhost、静态判不出地址相等,跨面比较=假阳性制造机);跨进程同面重叠 = `machineDependent: true`(真冲突与否取决于部署机器,**不裁定**,双方路径都给来源);任一方 telnet → 自愈注记(目录段注释「端口被占用则向后尝试 NNNN..」);
    - **字段组合**(逐条核实):bots `port_max` 小于下限 → 引擎夹断取下限(目录注释,自愈,info);external 段 min>max **无引擎夹断文档** → 只报算术事实 `range-empty-candidate`(info + 不裁定声明,绝不虚称引擎行为);
    - **引用目标**:dbmgr.databaseInterfaces 无 `default` → error(目录注释「至少存在一个 default」);`InterfacesServiceAddr.enable=false` + 已配置 item → 条目不生效(目录注释「enable 为 false 则相关数据不转发」);
  - **`checkProjectPathBaseline(structure)`**(CFG-08 注册表消费):路径基准双向——代码读取路径无绑定覆盖(uncovered-read,带读取点来源)/ 声明绑定无代码读取证据(unused-binding,带 schema 来源);只报事实与来源不裁定(未覆盖=零约束,未使用=可能由外部工具读取)。
- **CFG-08 核加宽(行为向后兼容)**:`ProjectConfigStructure` 增 `uncoveredReads`(原「未绑定路径 continue 静默丢」→ 显式报出供路径基准面消费);既有 CFG-08 测试零改动全绿。
- 测试 18 例:真实引擎 defaults 夹具解析(tests/fixtures/config/kbengine_defaults.xml,基线零冲突)+ 变异树构造冲突。

## 诚实边界(逐条核实的缺席面,明示)

- `machine.addresses` 条目无格式/关系引擎证据 → **不实现检查**(诚实缺席,不硬造);
- external 段 min>max 的引擎行为无文档 → 不声称夹断/报错,只报区间为空的算术事实;
- 跨绑定面同号不报(地址相等静态判不出,报了就是假阳性);跨进程同面重叠不裁定同一物理机;
- http_cbport「仅第一个 loginapp 开启」的实例数静态不可知,claim 照登、重叠 machineDependent。

## prove-red(字节还原闭环)

1. **不简单全局去重面**:摘除 scope 同面判定(退化为全局按号去重)→ 2 红(协议分离例 + 绑定面分离例,均跨进程构造)→ `cp` 备份 + python 替换 + 还原 `cmp` 字节一致;
2. **路径基准面**:摘除 uncovered/unused 两条 push → 2 红 → 还原 `cmp` 字节一致。

## 坑账

1. **prove-red 夹具构造**:首轮摘 scope 判定 0 红——变异落在同进程段(段内已被 section 去重跳过,scope 摘除无从显现);跨进程跨协议/跨面才抓得住判定面,变异必须构造跨段样本;
2. **真实 defaults 的注释元素**:`InterfacesServiceAddr` 的 `<item>` 在引擎 defaults 里是注释掉的(不入树,只有 sourceComments)——「enable=false + items」测试须手动挂 item;解析树非默认形态时勿按目录键想当然;
3. **`<root>` 包裹归一要两端做**:parseConfigXml 空名包裹 → 核入口 normalizeRootNode(configContract 同口径),测试侧变异树同样要归一,否则 findByPath 全 null;
4. **重叠对 paths 顺序** = claim 表序:TELNET_DEFAULTS 键序(baseapp 在 loginapp 前)决定 findings paths 顺序,测试期望按表序写,勿按段名字母序脑补。

## 门禁

compile 0 / eslint 0 / vitest 全量 785 文件 9803 过 + 4 skip(RC=0)/ xvfb demo 25 RC=0;分面先行:configRelationChecks 18 例 + CFG 全车道(configContract/configValueValidation/configFieldIdentity/configProjectStructure)71 例全绿后跑全量。
