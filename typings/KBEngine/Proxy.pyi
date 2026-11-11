# Proxy — one class per file (用户令 2026-11-11 / user directive: static
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
from .MemoryStream import MemoryStream
from .GlobalDataClient import GlobalDataClient
from .Entity import Entity
from .Space import Space
from .EntityComponent import EntityComponent
from .Entities import Entities

class Proxy(Entity):
    # 内部属性:baseapp 登录成功后注入,脚本只读,勿赋值 / internal attributes
    # injected by baseapp on login; read-only from scripts, do not assign.
    # (名字表 name list: entitydef/common.h:142-143;注入点 injection:
    # server/baseapp/baseapp.cpp:4241-4246)
    __ACCOUNT_NAME__: str
    __ACCOUNT_PASSWORD__: str
    clientAddr: Address
    clientEnabled: bool
    hasClient: bool
    roundTripTime: float
    timeSinceHeardFromClient: float

    def disconnect(self) -> None: ...
    def getClientType(self) -> int: ...
    def getClientDatas(self) -> Tuple[bytes, bytes]: ...
    def giveClientTo(self, proxy: Proxy) -> None: ...
    def streamFileToClient(
        self, resourceName: str, desc: str = "", id: int = -1
    ) -> int: ...
    def streamStringToClient(
        self, data: Union[str, bytes], desc: str = "", id: int = -1
    ) -> int: ...
