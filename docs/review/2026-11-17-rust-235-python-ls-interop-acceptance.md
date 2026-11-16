# RUST-235 验收纪要:Python LS 互操作(Pylance/Pyright、Python 环境、.pyi 优先级)(纯对账)

日期:2026-11-17。本纪要对账 RUST-235(旧 QA-006,主 todo 排队项)的验收口径与交付证据。结论:**三维全部由已验收姐妹项承载——职责冲突矩阵(RUST-148 已勾)、.pyi 优先级真机阶梯(RUST-170 已勾)、Python 环境族(venv 三套件+profileHealth),整合验收零代码缺口,纯对账收口。**

## 验收维度 → 交付证据映射

| 维度 | 既有面 | 证据 |
| --- | --- | --- |
| Pylance/Pyright 职责与冲突 | 冲突矩阵决策记录(职责总分立/kode 只补 def 域面,禁重复 diagnostics/completion 轰炸);拦截策略=**不劫持** Pylance go-to-definition,用户 stub 权威;pyrightconfig 五闸(类型/user-owned previous 全等/root 冲突/extraPaths 用户闸/缺省闸),不经确认不覆盖既有配置 | RUST-148(f732df03,`docs/design/python-language-service-conflict-matrix.md`)+RUST-161+RUST-162 三项已勾;semanticTokens 默认关(多 provider 抢位归矩阵裁定,opt-in) |
| .pyi 优先级 | 真机两服务器(Pylance/Pyright)实测解析序=**stubPath → extraPaths → 同目录 .pyi**(importer 目录不是绝对 import 首选,不凭猜测宣称);e2e 逐级裁层断言 | RUST-170(106b5990 已勾)+`src/test/electron/suite/pylanceStubPriority.test.ts`(stubPath 胜三层→裁 stubPath 回退 extraPaths→同目录兜底) |
| 不同 Python 环境 | venv 扫描修剪规则(依赖/构建目录剪枝,venv 点目录不剪,有界深度);环境标记存在性探测(pyvenv.cfg=venv/conda-meta=conda/无标记不冒充);unix/windows 双布局解释器定位;坏环境不认领(有标记无 python/有 python 无标记都拒);解释器缺失/离盘=profileHealth interpreter-missing 问题(带 setting 入口);PRJ-005 语言服务三态 | `tests/venvDiscovery.test.ts`(6+ 例)+`tests/venvInterpreterPicker.test.ts`+`tests/profileInterpreter.test.ts`+`src/backend/venvInterpreterPicker.ts`/`src/pythonProcessConfig.ts`;profileHealth(RUST-229 当日六类含 interpreter 面) |

## 自我验收证据

- 三姐妹项(RUST-148/161/162/170)均已勾且各带 prove-red+门禁记录(todo.md:409/424/425/433)。
- venv 三套件当日全量 unit 10659(2113d5f4 门禁)内绿;pylanceStubPriority 属 electron 套件,CI/nightly 链覆盖,形态与断言在案。

## 诚实条款

- 本条是**整合验收条目**:三维各自的增量交付与验证在姐妹项内完成,本纪要不重复记账;若未来矩阵裁定变更(如 semanticTokens 默认翻转),属 RUST-148 域的续批非本条缺口。
- 「不同 Python 环境」的实测面=venv/conda 标记探测+双 OS 布局+解释器绑定;pyenv-win/系统级多版本切换器无专测(解释器路径自由指定承载,如实记账)。
