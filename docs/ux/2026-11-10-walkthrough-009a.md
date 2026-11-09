# UX-REVIEW-009a 走查场景准备记录 2026-11-10

## 环境与包信息(如实)

- 扩展版本:0.2.0(package.json;main 分支工作树,提交
  df113efa 前后一系列 UX-REVIEW 批次之后)
- 操作系统:Linux(宿主 7.0.0-42-generic;x86_64)
- 包类型:VSIX——纯 TS 通用包(scripts/package-pure-ts.mjs)与
  TS+Rust 平台包(scripts/platform-vsix.mjs,verify-platform-set.mjs
  校验);本批场景准备只备场景与包面,未执行安装走查(见「未验证」)
- 项目规模:见下表(生成器输出,确定性)

## 四种可重复场景

生成器:`scripts/ux-walkthrough-scenarios.sh <outdir>`
(源=tests/fixtures/kbengine-demo-assets,107 文件确定性装配;
重复运行先清空重建,输出带每场景 files/defs 清点)。

| 场景 | 内容 | 规模 | 预期观察面 |
| --- | --- | --- | --- |
| 1-empty | 空目录,零文件 | files=0 defs=0 | 发现面如实「未找到」,不虚构项目 |
| 2-valid-project | demo 资产全量(scripts/entity_defs 12 def + res/server 引擎配置) | files=107 defs=12 | 首次识别/实体浏览/命令面可用 |
| 3-missing-config | scripts/defs 在,res/server 整体缺席 | files=105 defs=12 | 缺配置闸(004d)如实降级+两个恢复入口 |
| 4-backend-unavailable | 引擎配置覆盖 dbInterface=127.0.0.1:13306(无监听;配置内含密码字段供遮蔽验证) | files=107 defs=12 | 连接检查/只读查询如实「连接失败:ECONNREFUSED」且 password 不出现 |

## 准备步骤(可重复)

1. `bash scripts/ux-walkthrough-scenarios.sh /tmp/kode-ux-scenarios`
2. 构建安装包(按需):`node scripts/package-pure-ts.mjs`(纯 TS 通用包)
   或平台包链(platform-vsix.mjs + verify-platform-set.mjs)
3. 逐场景以 VS Code「打开文件夹」打开对应目录,按 009b 清单走查

## 未验证(如实标记,不假称完成)

- 009b(从安装包首次识别→失败恢复的真实走查):本环境 xvfb 无显示、
  无真实交互桌面,**未执行**;
- 009c(Windows/macOS 实际桌面、屏幕阅读器场景):本环境不可达,
  **未验证**;
- 本批交付 = 场景与包面准备就绪 + 元数据记录;走查执行待真实桌面
  环境补录,验收项保持开放(009d 汇总口径)。
