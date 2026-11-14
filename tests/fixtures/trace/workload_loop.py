"""FLOW-029 开销测量负载:固定量函数调用(默认 2000 次),供采集开销
预算实测(N 环境变量可调;main 断言全量执行,失败非零退出)。"""


def leaf(value):
    return value + 1


def ring(count):
    total = 0
    for i in range(count):
        total += leaf(i)
    return total


def main():
    import os

    count = int(os.environ.get('TRACE_LOOP_N', '2000'))
    total = ring(count)
    assert total == sum(range(count)) + count, 'loop result mismatch'
    print(f'loop-ok count={count} total={total}')


if __name__ == '__main__':
    main()
