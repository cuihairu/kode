//! 协作取消探针(RUST-072):解析/流引擎长循环的取消感知通道。
//!
//! 语义:worker 线程执行一个 job 前把该请求的取消令牌设进本线程探针,
//! 引擎在协作点(解析阶段间/类表构建循环/收敛迭代头)查询,已取消即以
//! `Err("cancelled by request")` 向上传播——绝不返回部分结果冒充完整
//! (ARCH-004 口径);缓存路径遇取消不写入(部分解析绝不缓存)。
//! 无探针(独立调用/测试/TS 兜底直调)时恒未取消,行为与旧版完全一致。
//!
//! 跨线程:令牌是 `Arc<AtomicBool>`,取消方(main 线程 executor.cancel)
//! 与查询方(worker 线程引擎循环)共享同一堆对象,无需锁。

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

thread_local! {
    static PROBE: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
}

/// handler 取消错误的稳定文案(worker 结算按取消表裁定终态,文案只用于
/// 日志对账;改文案须同步 executor 单测断言)。
pub const CANCELLED_MSG: &str = "cancelled by request";

/// 本线程设定/清除取消令牌(worker 每 job 起跑前 Some,终态后 None,
/// 防线程复用串 job)。非 worker 线程永不设定。
pub fn set_probe(token: Option<Arc<AtomicBool>>) {
    PROBE.with(|probe| *probe.borrow_mut() = token);
}

/// 当前线程的取消状态;无探针 = false。
pub fn is_cancelled() -> bool {
    PROBE.with(|probe| {
        probe
            .borrow()
            .as_ref()
            .map(|token| token.load(Ordering::SeqCst))
            .unwrap_or(false)
    })
}

/// 协作点:已取消 → Err(调用链向上传播,engine 不产出结果)。
pub fn check_point() -> Result<(), &'static str> {
    if is_cancelled() {
        Err(CANCELLED_MSG)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_probe_is_never_cancelled() {
        set_probe(None);
        assert!(!is_cancelled());
        assert_eq!(check_point(), Ok(()));
    }

    #[test]
    fn probe_flag_flips_cancel_state() {
        let token = Arc::new(AtomicBool::new(false));
        set_probe(Some(Arc::clone(&token)));
        assert!(!is_cancelled());
        token.store(true, Ordering::SeqCst);
        assert!(is_cancelled());
        assert_eq!(check_point(), Err(CANCELLED_MSG));
        set_probe(None);
        assert!(!is_cancelled());
    }

    #[test]
    fn cancellation_is_visible_across_threads() {
        let token = Arc::new(AtomicBool::new(false));
        set_probe(Some(Arc::clone(&token)));
        // 主线程置位,本线程(=模拟 worker)探针可见。
        let writer = Arc::clone(&token);
        std::thread::spawn(move || writer.store(true, Ordering::SeqCst))
            .join()
            .expect("writer thread");
        assert!(is_cancelled());
        set_probe(None);
    }
}
