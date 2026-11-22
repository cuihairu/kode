---
name: kbengine-client-sdk-tests
description: 按 kbengine 工作区的 entity_defs 接口生成 python 客户端 SDK 骨架,并据此自动产出 pytest 用例（属性面/回调面/Exposed 面/组件对账/发送接缝）。用户要给 KBEngine 客户端接口生成测试用例、或要求基于 def 文件生成测试时使用。
---

# KBEngine 客户端 SDK 测试用例生成

两步:先用 kode 生成器产出 python 客户端骨架,再按工作区 def 接口对账生成 pytest 用例。def 文件是真值源,骨架只是产物——用例的每一处断言都要能回指 def 的某一节。

## 第一步:生成 python 骨架

编辑器内命令 `kbengine.clientSdk.generate`（勾选 Python）;或 headless CLI（CI/脚本）:

```bash
cargo build -p kode-server --bin client-sdk-gen --release

./target/release/client-sdk-gen \
  --assets-root <资产根目录> \
  --language python \
  --out <输出目录>                    # 缺省 <资产根>/scripts/client_entities
```

收集契约与类型映射见 `docs/guide/client-sdk.md`（本仓文档,勿在此重复维护）。骨架要点:

- 按 `scripts/entities.xml` 登记序每实体一个 `<EntityName>.py`;输出目录按包消费（`from client_entities.Avatar import Avatar`）
- 客户端可见属性=类级注解（`Flags` 含客户端域）;纯服务端属性不进面
- `ClientMethods` → 回调位（方法体 TODO）;带 `<Exposed>` 的 Base/CellMethods → `base_call_*`/`cell_call_*` 包装,未 Exposed 不生成
- FIXED_DICT → `ClientSdkFixedDicts.py`（`@dataclass`）;组件 → `ClientSdkComponents.py`
- 骨架纯标准库零依赖,import/实例化不需要引擎在 PYTHONPATH

## 第二步:按 def 接口生成 pytest 用例

对着工作区 `entity_defs/*.def` 逐面写断言,模板五面:

1. **属性面**： 客户端可见属性在 `get_type_hints(<Entity>)` 里（注解是 PEP 563 字符串形态,必须用 `get_type_hints` 求值,不能拿 `__annotations__` 直接比类型）;服务端域（`BASE`/`CELL`/`CELL_PRIVATE`/`CELL_PUBLIC` 无 client 侧）断言缺席
2. **类型对账**: 注解解析结果与 def `<Type>` 按映射表对上（`UINT32`→`int`、`STRING`→`str`、组件槽→组件 dataclass 类）
3. **回调面**: `ClientMethods` 逐个 `callable(getattr(...))`
4. **Exposed 面**: `base_call_*`/`cell_call_*` 存在且经发送接缝路由——继承骨架实现 `on_base_outgoing`/`on_cell_outgoing` 记录调用,断言方法名与参数序列;未 Exposed 方法断言 `hasattr` 为假
5. **伴随件**: FIXED_DICT/组件 dataclass 可实例化,字段与 def 对账

用例文件开头把骨架输出目录挂上 `sys.path`。本仓演示（对 `tests/fixtures/kbengine-demo-assets` 生成后 6 例全绿,2026-11-18）:

```python
import sys
from pathlib import Path
from typing import get_type_hints

sys.path.insert(0, str(Path(__file__).parent))

from client_entities.Avatar import Avatar
from client_entities.ClientSdkComponents import Inventory


def test_avatar_property_surface_matches_def():
    for prop in ("name", "level", "hp", "experience"):
        assert prop in Avatar.__annotations__
    # 服务端域不进客户端面: skillSlots Flags=BASE、sight Flags=CELL_PUBLIC
    assert "skillSlots" not in Avatar.__annotations__
    assert "sight" not in Avatar.__annotations__


def test_avatar_type_annotations():
    hints = get_type_hints(Avatar)
    assert hints["name"] is str
    assert hints["hp"] is int
    assert hints["bag"] is Inventory


def test_avatar_client_methods_are_callback_slots():
    for cb in ("onHPChanged", "onLevelUp", "onMonsterNear"):
        assert callable(getattr(Avatar, cb))


def test_avatar_exposed_wrappers_route_to_seams():
    sent = []

    class AvatarUnderTest(Avatar):
        def on_base_outgoing(self, _method, _args):
            sent.append(("base", _method, _args))

    ent = AvatarUnderTest(1001)
    ent.base_call_reqCastSkill(3)
    assert ent.entity_id == 1001
    assert sent == [("base", "reqCastSkill", [3])]


def test_unexposed_methods_not_generated():
    assert not hasattr(Avatar, "base_call_cellAddExperience")
    assert not hasattr(Avatar, "base_call_onAvatarDead")
    assert not hasattr(Avatar, "cell_call_respawn")


def test_component_companion_shape():
    inv = Inventory()
    assert inv.__class__.__name__ == "Inventory"
```

## 第三步:跑绿口径

```bash
python3 -m pytest <用例文件> -q
```

零红才交付。骨架重生成（def 变更后）先 `python3 -m py_compile` 全量过再用例对账,断言失败时先分清是骨架缺口还是 def 语义变更,不盲目改用例迁就骨架。

## 边界

- 只断言接口形状（属性/方法签名/路由行为）,不断言引擎运行时语义——骨架是纯数据载体,没有引擎在环
- def 未登记进 `entities.xml` 的实体不在骨架内,别为它写用例
- 生成文件勿手改;要改形状改生成器（`crates/kode-server/src/client_sdk/` + `src/sdk-gen/` 双侧同步）
