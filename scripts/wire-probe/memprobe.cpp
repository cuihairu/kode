// 尽力交叉验证(非门禁):仅包含 memorystream.h,编出标量/STRING/BLOB 字节,
// 与规范推导黄金样本对拍。编译级通过(2026-11-01:标量/STRING/BLOB 三面全编译,
// 见 docs/review 对拍注记);链接级需完整 KBEngine 构建(Boost/Python/openssl),
// 会话内不可行 → 跳过链接,黄金样本以规范推导(memorystream.h:224-233 STRING=
// 字节+0x00 无长度前缀;:543-560 appendBlob=u32 长度+字节)为权威。
//
// 编译验证命令:
//   g++ -std=c++11 -c -I <kbengine>/kbe/src/lib -I <kbengine>/kbe/src/lib/common \
//       -o /tmp/memprobe.o scripts/wire-probe/memprobe.cpp
#include "memorystream.h"
using namespace KBEngine;
#include <cstdio>
int main() {
    MemoryStream s;
    s << (uint8_t)255;
    s << (uint16_t)65535;
    s << "hello";
    s.appendBlob("\xde\xad\xbe\xef", 4);
    const uint8_t* p = s.data();
    size_t n = s.size();
    for (size_t i = 0; i < n; i++) printf("%02x", p[i]);
    printf("\n");
    return 0;
}
