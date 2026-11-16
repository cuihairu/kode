# RUST-234 验收纪要:VS Code Extension Host + native server e2e(纯对账)

日期:2026-11-17。本纪要对账 RUST-234(旧 QA-005,主 todo 排队项)的验收口径与交付证据。结论:**Integration e2e 面既有且真实运行——mocha Extension Host 套件 29 文件,cellDataFullChain 即「真实 Rust 门」(kode-server 二进制 spawn+`$/kode/semantics/cellDataKeys`,断言用户可见五面联动),本日 xvfb demo 25 例实测 RC=0。纯对账收口。**

## 验收维度 → 交付证据映射

| 维度 | 交付面 | 证据 |
| --- | --- | --- |
| VS Code Extension Host e2e | `src/test/electron/`(runTest.ts 多形态运行器+suite 29 套件):导航(demo/multiRoot/dirtyBuffer/freshFile/deleted/renamed)、hover(plainVariableHover/hoverCancelConverge)、面板冒烟(panelOpenSmoke/vsixSmoke)、语言服务(serviceAttribution/pylanceStubPriority)、韧性(stormRecovery/longSession 三族/gitHistoryHostImpact)、KSEM-CELL-15 未保存 def 编辑全链 | `npm run test:demo:editor`/`--field`/`--vsix` 三形态脚本(package.json:2530-2532);CI ci.yml 烟测门+nightly 全链(kode-ci-gate 结构在案) |
| native server(Rust Core)e2e | cellDataFullChain:自动发现 kode-server 二进制(win32/posix 双名),spawn 真进程走 `$/kode/semantics/cellDataKeys`;runTest.ts:97 头注「五面联动;真实 Rust 门」,二进制缺席整模式自动降级(不静默假绿) | `src/test/electron/suite/cellDataFullChain.test.ts`(未保存 def 插属性后补全/F12/inlay/hover/诊断一起更新=用户可见结果五面联动断言);二进制陈旧时给出 rebuild 指引报错 |
| 对比用户可见结果 | 套件断言全是可见面(hover 内容/F12 落点/inlay 值/补全项/诊断/面板/CodeLens),非内部状态偷窥 | demoNavigation/plainVariableHover/dirtyBufferNavigation 等断言形态;本日实测:`xvfb-run -a npm run test:demo:editor` **25 passing RC=0**(2026-11-17,含 RUST-229 hover 禁用标注改动后的真机回归) |

## 自我验收证据

- 本日实测 `xvfb-run -a npm run test:demo:editor` RC=0,25 例 4s 全过(Extension Host pid 退出码 0);该跑兼作 RUST-229(当日 hover.ts 新增禁用标注分支)的真编辑器回归。
- 全量 vitest 10659(2113d5f4 门禁)+CI mocha 烟测门/nightly 全链结构在案。

## 诚实条款

- **二进制缺席=自动降级**:kode-server 二进制不在时 cellData 全链套件跳过(warn 非红)——CI 门保证二进制在(nightly 全链),本地裸跑可能降级为 TS-only 面,如实记账。
- field/long-session 长会话族是 nightly 形态非本日逐套实测;本日实测口径=demo 形态 25 例。
- 「对比用户可见结果」无跨 TS/Rust 双实现的逐项 diff 形态(那是 RUST-233 differential 面);Integration 面的对比=断言可见结果正确性(金标/深等断言在 parity 套件),如实划界。
