# RUST-164 审计结案:生成稳定排序/格式避免无意义 diff;manifest/hash/源映射/schema 版本

日期:2026-11-17
性质:审计结案(基线零改动)——确定性生成与零写纪律已系统性建成并有字节级测试钉;manifest/hash/schema 版本裁定不建(无消费面)。

## 稳定排序/格式(已建)

- **排序全确定**:实体/属性/方法名 localeCompare 排序(buildEntityTypeStubPlan :338/:397,collectEntityTypeMethods :477);kbe_types 别名按名字序发射(解析后不再互相引用,输出与输入序无关,pythonTypeStubs.ts:584);KBEngine 导入名与跨分件 import 均排序(:697/:721);方法段固定序 Base/Cell/Client(:459);
- **格式确定**:头部固定文本无时间戳(「确定性,无时间戳」pythonTypeStubs.ts:608 头注钉);生成物身份 marker 固定(KBE_STUB_GENERATED_MARKER='# KBEngine.pyi — kode generated' 等);pyrightconfig 托管写入经 applyEdits/modify 保 JSONC 格式保注释(固定 insertSpaces/tabSize)。

## 避免无意义 diff(已建,字节级钉)

- **内容确定**:tests/pythonTypeStubs.test.ts:613「同一输入两次构建逐字节一致(零写语义的前提)」——同输入=同字节输出,无时间戳/无序扰动=无意义 diff 结构性不可能;
- **零写**:内容一致三车道零写(RUST-163 审计:copy-if-absent/实体桩比对/kbe_types 分件比对),零写零提示钉(:967)、types.xml 增/改/删三事件静默重导出内容一致零写钉(:1120)、entityStubRegen 再生链钉——盘面 mtime/内容不被无意义触碰。

## 源映射(已建)

RUST-160 在案:逐符号源行注释+渲染期行映射+CodeLens 逆向镜(sourceKind 判别)。

## manifest/hash/schema 版本(裁定不建)

- **无消费面**:生成物身份已由头注 marker 携带(哪条车道生成、管理目录、覆盖契约「手工修改会在下次生成时被覆盖」已文档化);无任何机器消费方读 manifest(hash 校验/完整性审计/外部工具均不存在);
- 死产物纪律:无消费面不建(RUST-158/160 同裁定);若未来出现消费方(CI 桩完整性校验/reset 精确区分手改文件),届时随消费面一起建 manifest+hash+数字 schema 版本。

## 结论

确定性生成+零写纪律已满足「稳定排序/格式、避免无意义 diff、源映射」;manifest/hash/schema 版本登记为无消费面不建。基线零改动。
