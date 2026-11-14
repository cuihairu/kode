# -*- coding: utf-8 -*-
"""FLOW-024 采集负载:登录序形态。

正常链:onClientEnabled(方法) → buildLoginMsg(方法) → sanitizeName(模块函数);
异常链:loadAccount(方法) 在本地行起 KeyError,onClientEnabled 捕获——异常
位置与传播形态都在真实文件行上(采集器按 co_firstlineno 记 def 声明行)。
"""


class Account:
    def onClientEnabled(self):
        self.lastError = None
        self.buildLoginMsg("hero")
        try:
            self.loadAccount("hero")
        except KeyError as ex:
            self.lastError = "missing:%s" % ex.args[0]

    def buildLoginMsg(self, name):
        return {"name": sanitizeName(name)}

    def loadAccount(self, name):
        accounts = {}
        return accounts[name]


def sanitizeName(name):
    return name.strip()


def main():
    account = Account()
    account.onClientEnabled()
    assert account.lastError == "missing:hero", account.lastError
