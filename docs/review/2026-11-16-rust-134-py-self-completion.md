# RUST-134 Python self. 实体成员面收编 Rust 共享补全查询验收

日期:2026-11-16
任务行(todo.md):`RUST-134 (旧 LSP-001) Completion(声明、类型、实体属性/方法、RPC 参数、组件、内建 API)共享语义查询。`

## 结论

补全面在 def/XML 六面与 KBEngine./kbe. 模块别名面之外,补上最后一族:
**Python `self.<片段>` 实体成员面**——实体归属(def 语料唯一命中)→
本类属性(detail=类型)→ 三分面方法(base/cell/client,facet 标注)→
继承链成员(近祖先优先,`inheritedFrom` 标注,同名被本类/先出项遮蔽)。
TS 装配侧补全专用文档门 `isCompletionRustDocument`(.py 与语料文档均进
Rust 补全面;definition/hover 等其余面口径不变),直接切语义保持。

## 设计

- **判面**(completion.rs `python_self_completion`,py 臂 module face 优先、
  self face 兜底):
  - 首 `self.` 段才接管:prefix `rsplit_once('.')`,fragment 全词法字符,
    head 尾词 == "self";嵌套 `self.a.` 多段路径(head 尾词≠self)不接管
    (TS nested 面语义不同,不混装);
  - 实体归属 = py 路径 `/scripts/` 段后文件 stem → `corpus_def_for_entity`
    (hover.rs,RUST-133 批内新增):entities.xml 注册候选(注册表真相)
    优先,空则根内语料 stem 扫描回落;零命中/多命中 None 让位,绝不硬猜;
  - 片段大小写不敏感前缀过滤(TS python 面同口径);无命中 = 判面成立的
    空条目集(非 None,与「语料缺位」可区分后由 TS 空集不权威面兜底);
  - 继承链面 `chain_face` 按 **def 路径**定位(defs_root/category 探测锚在
    def 上,非 py 路径),缺父如实空,绝不虚构;
  - 同名遮蔽:本类属性/方法先出,`seen` 集合先见者胜(近祖先优先序);
- **HoverEngine 新增 `corpus_def`** pub(crate) 读面(def_files 私有字段不
  再开第二个口子,completion 与 hover 同饮一江水);
- **TS 门**(kodeCoreShadowFaces.ts):`isCompletionRustDocument` =
  语料文档 ∪ .py;仅 serveCompletionFromRust 使用,其余 5 处 serve 面
  (definition/hover/diagnostics 等)维持 isCorpusDocument 不动(blast
  radius 只限补全);空条目集不权威(RUST-021 修订)不变。

## 测试(8 例新增 + 既有 44 例保持绿)

- **Rust units 4 例**(tests/completion_units.rs,纯内存 loaded_engine):
  全量点序断言(本类属性→三分面方法→继承链,遮蔽/facet/inheritedFrom/
  detail 逐字段)/ 片段大小写不敏感过滤+无命中空集 / 嵌套·非 self·非实体
  py·scripts 外四路诚实 None / KBEngine. module face 不回归;
- **Rust dispatch 2 例**(tests/completion_dispatch.rs,内存 overlay):
  LSP 投影面(kind 10/2 + detail)实体成员全序 / 非 self 位与无 stem 语料
  py 双路 null;
- **TS 单测 2 例**(tests/kodeCoreShadowFaces.test.ts):py 文档镜像+请求
  +条目集采信(RUST-134 门)/ 真门外文档(schema)零请求直通;原「py 零
  请求」钉随语义翻新重铸;
- **TS E2E 1 例**(tests/kodeCoreServingE2E.test.ts,真实二进制):
  entities.xml + Avatar.def 镜像 → fixture 路径 py overlay `self.` →
  def 声明属性(name STRING/level/hp/experience)+ base 面方法
  (onAvatarDead)全量出项,detail/kind 逐字段。

## prove-red(三靶,cp 备份 + 变异 + cmp 字节还原,靶面互不掩护)

1. 摘 py 臂 self 兜底(直返 None)→ **恰 3 红**(units 全量点/过滤 +
   dispatch LSP 面);诚实 None 例保持绿 = 判别面正确;
2. 摘继承链成员(exists 恒 continue)→ **恰 1 红**(units 链序断言);
3. 摘 TS 补全门 py 臂(回 isCorpusDocument)→ **恰 1 红**(TS py 镜像钉)。

## 诚实边界

- **hooks 面/内建属性面不在 Rust**:self.id/self.name 等引擎内建属性与
  hooks 语义仍是 TS 既有链——Rust 只接管 def 语料可判面;TS 空集不权威
  面保证这类请求回落 TS 不饿死(直接切语义的自然边界,如实登记);
- `self.` 在非实体 py(无同 stem 语料 def、scripts/ 之外)Rust 回 None/
  null,TS 既有链接管(TS 面有独立归属规则,行为不变);
- LSP 投影只透 label/kind/detail;facet/inheritedFrom/context 面在结构化
  face(units 钉死)与 TS 消费面之间传递,不在 LSP items 上;
- 内建 API 模块符号面(KBEngine./kbe.)RUST-134 之前已在 Rust
  (python_process::completion),本批只补 self 臂不重排优先级。

## 门禁

- `cargo clippy --workspace --all-targets -- -D warnings`:0
- `cargo test --workspace`:RC=0,167 suite 全 ok 0 failed
- `pnpm lint`:0;`pnpm compile`(tsc):0
- vitest 全量:845 文件 10344 过 + 8 skip,RC=0(首轮 1 例
  hoverDeadlineContext 15ms 预算满载抖动,隔离复跑两次绿 + 全量复跑绿,
  非本批面)
- `xvfb-run -a npm run test:demo:editor`:25 passing,RC=0
