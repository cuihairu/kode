# MemoryStream — one class per file (用户令 2026-11-11 / user directive: static
# template, one class per file, project copies are user-editable).
# 拆分自 _KBEngine_common.pyi(cuihairu/kbengine typings,钉点 commit 见
# typings/README.md),由 scripts/derive-kbengine-stub-typings.mjs 生成;
# 改内容请重跑派生脚本,勿手工合并 / split by the derive script — regenerate
# there, do not hand-merge.
# 共享头部是有意的:逐类裁剪易漂移,桩内多余 import 无副作用(注解经
# __future__ 惰性求值)/ generous shared header on purpose: per-class pruning
# invites drift, unused stub imports are inert.
from __future__ import annotations

from typing import (
    Any,
    BinaryIO,
    Callable,
    Dict,
    IO,
    List,
    Literal,
    Sequence,
    TextIO,
    Tuple,
    Union,
    overload,
)

from ._KBEngine_common import Address, Callback, Vector3Like, WatcherValue
from .EntityCall import EntityCall
from .EntityComponentCall import EntityComponentCall
from .GlobalDataClient import GlobalDataClient
from .Entity import Entity
from .Proxy import Proxy
from .Space import Space
from .EntityComponent import EntityComponent
from .Entities import Entities

class MemoryStream:
    def __init__(self) -> None: ...
    def append(self, dataType: str, value: Any) -> None: ...
    def pop(self, dataType: str) -> Any: ...
    # 方法名即 bytes（非 __bytes__ dunder），lib/pyscript/py_memorystream.cpp:30
    def bytes(self) -> bytes: ...
    # 读/写位置：0 参取值 -> int，1 参设位置 -> None（py_memorystream.cpp:540/576）
    @overload
    def rpos(self) -> int: ...
    @overload
    def rpos(self, pos: int) -> None: ...
    @overload
    def wpos(self) -> int: ...
    @overload
    def wpos(self, pos: int) -> None: ...
    # val 须为 bytes 或 MemoryStream（py_memorystream.cpp:604-646）
    def fill(self, val: Union[bytes, "MemoryStream"]) -> None: ...
    def __reduce_ex__(self, protocol: int) -> Any: ...
