# RUST-163 结案:增量生成仅刷新受影响 stubs;输出原子写入、不改未受影响文件 mtime

日期:2026-11-17
性质:盘点+补原子写入——增量/mtime 两面已建成;「原子写入」缺口补齐(0f506461)。

## 增量与 mtime(已建,三车道逐一)

1. **KBEngine 桩包复制**:copy-if-absent(exists→continue)——在盘文件永不触碰,mtime 恒不动;
2. **entity_types.pyi**:内容比对零写(unchanged=readFile===content→跳过写盘,mtime 不动);陈旧探测单独成段(读失败按陈旧,5200bfc0 两段分离回归修复);
3. **kbe_types.pyi 分件**:逐模块镜像独立内容比对零写(pythonTypeStubs.ts:849-860 同闸);分件只按 groupCustomTypesByModule 键生成,未涉及模块不出新内容即零写;
4. def 单文件再生→entity plan 内存重建+updateEntityPlan fire,但落盘仍走 unchanged-skip——「仅刷新受影响 stubs」的磁盘面=内容真的变了才写。

## 原子写入(本笔补齐,0f506461)

缺口:三条车道默认 deps 写盘均为直接 writeFileSync——断电/并发读(语言服务器/watcher)可落半截桩。补齐:pythonStubExport.ts `writeFileAtomic`(同目录 `<target>.kode-tmp` 临时件+rename 换名,同目录 rename 原子;失败 rmSync 清理临时件不残留、原错照抛),`fileSystemStubExportDeps.writeFile` 接线——三条车道(KBEngine 桩包/实体桩/类型桩)一次性覆盖;测试注入 deps(自带 writeFile)不受影响。

## 测试与验证

- tests/pythonStubExport.test.ts +3 钉:成功写零临时件残留/覆盖写换名替换/rename 故障注入(目标位被目录占住→错误面必含 "rename"=钉住走的是临时件+换名而非直写,且零 .kode-tmp 残留);
- prove-red:writeFile 恢复直写变异→故障注入钉红,cp+cmp 字节还原→25 绿;
- 门禁:eslint 0/tsc 0/unit 861 文件 10410+8skip EXIT=0/xvfb demo 25 RC=0。

## 结论

增量刷新+mtime 保序已由三车道内容比对/copy-if-absent 满足;原子写入缺口已补齐并钉死。基线增量=写盘路径一处+测试三钉。
