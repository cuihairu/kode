# RUST-225 验收纪要:Graph view 小图即时渲染/大图按需加载;Webview CSP 禁用远程 CDN

日期:2026-11-17。本纪要对账 RUST-225(旧 UI-008,主 todo 排队项)的验收口径与既有交付证据。结论:**图按需加载三面(浅层即时/分页续取/展开按需)与 CSP 禁远程 CDN 均有既有面与测试钉,本批为纯对账收口(零代码增量)。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 小图即时渲染 | 调用链图浅层优先:defCallChain 广度优先、默认深度 3、frontier 空即停——初始只渲染小邻域,秒开;关系图(RUST-178)焦点+双向邻接即时出图,不预构建全量 | `src/backend/defCallChain.ts:231,245`;`src/backend/entityRelationsBrowser.ts`(焦点/邻接/子图投影);钉 `tests/defCallChain.test.ts:152-154`(depth 0/1 精确断言) |
| 大图按需加载 | 三形态按需:①调用链深度参数 drill-down(用户要更深的图才更深的扫);②Python 全项目调用图分页续取(RUST-077-W 分页元信息 pageNext/cancelled,逐维续取上限防御)——大图走分页拉取不是一次性全量;③实体关系图 expandRelations 节点展开(未展开节点带 relationsExpand 指令,点击才展开;expand 幂等三拒) | `src/backend/defCallChain.ts:43`;`src/backend/pythonCallGraphRust.ts:85,103,121-160`(分页续取);`src/entityDependencyWebView.ts:237,444`(RUST-178 钉 16+7) |
| CSP 禁用远程 CDN | 统一入口 webviewSecurity:`default-src 'none'` 断一切外联/外帧/连接,script-src 只认本次渲染 nonce+扩展自带本地资源源(cspSource),img-src 默认不开、需导出图时经 extraImgSources 显式开洞(data:/blob:);mermaid.tiny.js 与 chart.min.js 离线打包进 media/ 走 vscode-webview: 源,不引 CDN;全仓 src/ 零 unpkg/jsdelivr/CDN 引用 | `src/webviewSecurity.ts:35-43`(webviewScriptCsp);`:45-55`(webviewAssetUri 离线资产);钉 `tests/webviewSecurity.test.ts:54-64`(default-src 'none'+nonce-only+extra-sources 机制,测试里 https://cdn.example.com 是参数机制假 fixture 非生产引用);监控面板钉 :178-183(Chart.js 离线 `vscode-webview:`) |
| CSP 全面接线 | 全部 webview HTML 面走同一 CSP 入口(monitoring/database/configVisualizer/entityDependency/entityFlow/telnet/log/traceReplay 等 9+ 构建器),无旁路面;KR-AUD-38/43/49/50/53 审计项落此 | `src/webviewSecurity.ts` 消费者 9+ 文件;`src/entityFlowWebView.ts:298-302`(KR-AUD-50/53 nonce+离线 mermaid) |

## 本批增量

- 零代码增量:图按需三形态与 CSP 禁 CDN 均有既有实现与钉(defCallChain/pythonCallGraphRust/entityRelationsBrowser/webviewSecurity 套件),再造属仪式性重复。

## 诚实条款

- 「大图按需」三种形态按图类型分布:调用链=深度参数、全项目调用图=分页续取、实体关系图=节点展开——不存在单一的「大图开关」;验收按各图自身的按需机制计。
- 全项目调用图分页是**数据层分页**(Rust RPC 逐维续取),面板侧聚合后仍可能一次渲染大 mermaid;超大图的渲染层虚拟化不在既有面(浏览器端 DOM 规模上限是自然边界,未做虚拟滚动,如实)。
- CSP 的 extraScriptSources 参数存在是机制面(个别面板传扩展自有 webview 源),生产代码无任何公网源;「禁用远程 CDN」由 default-src 'none' 默认拒绝+零 CDN 引用双向成立,不是逐面板人工保证。
