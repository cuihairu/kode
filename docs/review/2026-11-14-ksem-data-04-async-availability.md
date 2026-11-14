# KSEM-DATA-04(SEM-045)表达异步可用性 — 纪实

日期:2026-11-14。todo.md SEM-045(旧 KSEM-DATA-04):表达异步可用性。验收:共享数据发现写点不代表读时已存在;get/default、删除及进程域对类型和提示产生影响。

## 交付面

### 数据模型(`src/backend/globalDataIndexCore.ts`)

- `kind` 扩为 `'write' | 'read' | 'delete'`:`del alias.dict[K]` 下标形态判删除(行内前缀 `del ` 令牌,`[^\w]` 边界防 `mydel` 误判;词法掩码已剔注释/字符串伪 del——访问段必须是代码先于 del 判定);`del x.get(k)` 非法语法不判——`.get` 臂恒 read;删除记录 valueText 恒 null、照常按键签名入倒排(读点侧可计数);
- `defaultText?: string | null` 新字段:`parseGetAccess` 重写捕获第二实参(首/次顶层逗号切分,深度+引号感知——`get("k", {"a": 1, "b": 2})` 不劈错;超参形态只取第二参);valueText 在 get 读点恒 null(审计钉既有口径不破),写点记录不设该字段(与读点面不混);查询侧经 `getKbeDataDictAccessAtPosition` 复用 `findKbeDataDictAccesses` 自动携带,RAW 行取文不受掩码影响。

### 进程域(`src/backend/pythonProcess.ts`)

- `dataDictProcessDomain(dict)`:`baseAppData` → {base}(引擎真源 baseapp.cpp:461)、`cellAppData` → {cell}(cellapp.cpp:200)、`globalData` → null(全进程注册 entity_app.h:419,不收窄);
- `dataDictSiteInDomain(file, dict)`:globalData 恒真;域化字典角色不在域内=false;`scripts/` 之外角色不可知=true(不猜,不声称出域)。

### 面(收窄只落类型/提示/补全,导航面不收窄)

- **hover**(`src/languageProviders/hover.ts` buildDataDictHover,+`document` 参数):查询文件出域 → 机制说明悬停(`仅 cell 进程注册;本文件属 base 进程——运行期无此属性,读取会抛 AttributeError`),不出类型面;删除点访问 → 无数据字典悬停(不出「读点」误导标注),删除计数由同键读点悬停承载;读点悬停恒带可用性 caveat(`写点运行时可能晚于本读点执行——键可能尚未存在`);删除计数行(`同键删除点 N 处(读取可能落在删除之后)`,>0 才出);跨进程域写点排除出类型面并如实补记(`另有 N 处跨进程域写点不入类型`);default 类型并入联合,≥2 类时逐类型产源行含 `- str ← 本读点 .get 默认值`(单类+default 也补来源行);
- **inlay**(`src/typeInlayHints.ts`):删除点显式跳过(否则删除位落进读点臂、按同键写点出 union 提示);出域文档该访问全跳(含写点形态——base 写 cellAppData 运行期无此属性);域内站点过滤(跨域写点不入 union);default 类型并入读点 union;
- **补全**(`src/languageProviders/completion.ts` provideDataDictKeyCompletions 重写):出域文档键位无项;键族只认域内访问点(纯跨域写点的键族不给项),写点数/首写点 detail 只数域内(如实不造来源);`scripts/` 外角色不可知不拦(DATA-02 既有 15 例全保——其夹具路径无 `scripts` 段);
- **导航不收窄(裁定)**:definition/references 按键身份跨角色互链保持现状——域收窄落类型/提示/补全三类信息面,导航面如实全量(审计钉改述保留)。

## 测试(`tests/dataDictAsyncAvailability.test.ts`,14 例)

纯核 5:del 删除态(值 null/普通读写不变)/伪 del 掩码剔除+`mydel` 边界/get 臂恒 read/defaultText 五形态(字面量/调用/单参 null/超参取第二/嵌套逗号不劈)+写点无该字段/进程域纯核(域表+不可知不声称)。
面 9:int+默认值 `: int | str`/纯默认值双面(`: str`+读点 0 处)/caveat 恒带/删除计数入悬停+删除位无类型面(hover 落回普通链+inlay 空)/base 读 cellAppData 机制说明/域内 cell 照常/出域 inlay 全跳+globalData 不收窄/跨域写点排除计数(`: int`,无 `| str`,`另有 1 处`)/补全域内 detail 只数域内+出域无项。

## 审计钉更新(`tests/globalDataIndexAudit.test.ts`)

del 钉 read→delete 翻转(SEM-045 落地);get-default 钉补 defaultText 断言(valueText 恒 null 口径保留);进程域钉改述为「域收窄只落类型/提示/补全,references 导航如实跨角色互链不收窄」(断言不变);l10n 钉(悬停中文硬编码)不动——本批仍未接 l10n,真实差距如实保留。

## prove-red(5 变异,cmp 字节还原后全复绿)

1. del 判定摘除(下标恒按解析 kind)→ 3 红(纯核 del/审计钉/删除位面);2. defaultText 恒 null → 4 红(捕获/union 并入/纯默认值双面/审计钉);3. hover 出域闸失效 → 1 红(机制说明例);4. inlay 删除跳过失效 → 1 红(删除位 inlay 例——不跳则删除位按同键写点出 `: int`);5. 补全出域闸失效 → 1 红(出域文档给项例)。

## 锚点

hover.ts 改动全在 provideHover(:313)之后,无位移;completion.ts provideDataDictKeyCompletions 重写 +16 → PythonCompletionProvider.provideCompletionItems 973→989 真位重探,ANCHORS 表+baseline mermaid+dated note 锁步,perfCallChainDoc 4/4 绿。

## 坑账

1. **Edit 锚截断残留**:补全面重写的 old_string 停在方法体中段,新块闭合后旧尾段(detailParts/item 构造)成孤儿——TS 必炸;编辑后立即整段复读补删。与本战役 DATA-02 的 TS1128 同族,规则不变:闭内重写必须锚完整分支体;
2. **测试夹具真实路径纪律**:首版进程域 hover 例用了杜撰 fileName(`/tmp/da04-root/...`),而 `resolveScopeRoot(document.uri.fsPath)` 按真实 workspace 根解析——杜撰路径查空根键恒 null,域内例全哑;夹具一律用 mkdtemp 真路径(setup 返回 paths),域判断用的 document.fileName 与索引查询用的 scopeRoot 必须同源;
3. **globalData 测试路径不受域影响但也要真实**:globalData 无域表(domain null)所以杜撰路径的域判断不触发,但 resolveScopeRoot 查询侧仍炸——「域无关」不等于「路径随便填」。

## 门禁

compile 0 / eslint 0(待全量跑)/ vitest 全量(见 todo.md 勾行时点数)/ xvfb demo 25 RC=0(待跑)。
