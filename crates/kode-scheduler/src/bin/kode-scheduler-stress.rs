//! 调度器长期压力车道 CLI(RUST-083 旧 CORE-018)。
//!
//! 用法:
//!   cargo run -p kode-scheduler --bin kode-scheduler-stress [选项]
//!     --ops 100000       入队操作总数(缺省 100000)
//!     --seed 1           随机种子(缺省 1;失败时按同 seed 回放)
//!     --max-queued 0     有界队列上限,0 = 无界
//!     --cooldown 50      交互冷却 ms
//!     --starvation 5000  后台抗饥饿上限 ms
//!     --check-every 1000 每 N 个操作断言一次全部不变量
//!     --cancel-pct 5     取消注入比例(0..=100)
//!
//! 退出码 0 = 全部不变量成立;非 0 = 发现违规(死锁/永久 pending/取消泄漏/
//! 内存无界),stdout 输出违规分类与诊断,供 CI 归档。
//!
//! CI 里的 long-running 跑法:KODE_STRESS_OPS=2000000(见 .github/workflows/ci.yml)。

use kode_scheduler::stress::{run_stress, stress_storm_probe, StressOptions};
use std::env;

fn arg(args: &[String], name: &str, fallback: &str) -> String {
    let index = args.iter().position(|a| a == name);
    index
        .and_then(|i| args.get(i + 1))
        .map(String::from)
        .unwrap_or_else(|| fallback.to_string())
}

fn parse_u64(text: &str, fallback: u64) -> u64 {
    text.parse().unwrap_or(fallback)
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    // CI 长跑经环境变量注大;命令行参数优先(本地复现用)。
    let total_ops = parse_u64(
        &arg(
            &args,
            "--ops",
            &env::var("KODE_STRESS_OPS").unwrap_or_default(),
        ),
        100_000,
    );
    let seed = parse_u64(
        &arg(
            &args,
            "--seed",
            &env::var("KODE_STRESS_SEED").unwrap_or_default(),
        ),
        1,
    );
    let max_queued = parse_u64(
        &arg(
            &args,
            "--max-queued",
            &env::var("KODE_STRESS_MAX_QUEUED").unwrap_or_default(),
        ),
        0,
    ) as usize;
    let interactive_cooldown_ms = parse_u64(
        &arg(
            &args,
            "--cooldown",
            &env::var("KODE_STRESS_COOLDOWN").unwrap_or_default(),
        ),
        50,
    );
    let starvation_limit_ms = parse_u64(
        &arg(
            &args,
            "--starvation",
            &env::var("KODE_STRESS_STARVATION").unwrap_or_default(),
        ),
        5_000,
    );
    let check_every = parse_u64(
        &arg(
            &args,
            "--check-every",
            &env::var("KODE_STRESS_CHECK_EVERY").unwrap_or_default(),
        ),
        1_000,
    );
    let cancel_rate_pct = parse_u64(
        &arg(
            &args,
            "--cancel-pct",
            &env::var("KODE_STRESS_CANCEL_PCT").unwrap_or_default(),
        ),
        5,
    ) as u8;

    let opts = StressOptions {
        total_ops,
        max_queued,
        interactive_cooldown_ms,
        starvation_limit_ms,
        check_every,
        cancel_rate_pct,
    };

    eprintln!(
        "STRESS-ENV seed={seed} ops={total_ops} max_queued={max_queued} cooldown={interactive_cooldown_ms}ms \
starvation={starvation_limit_ms}ms check_every={check_every} cancel_pct={cancel_rate_pct}"
    );

    let elapsed = std::time::Instant::now();

    // 风暴合并面:高密度同文件事件,查事件丢失/无法排空。
    let storm_events = 100_000 + 1000 * total_ops.min(100_000);
    match stress_storm_probe(seed, storm_events) {
        Ok((seen, merged, landed)) => eprintln!(
            "STORM-OK events={seen} merged={merged} landed={landed} ({}s)",
            elapsed.elapsed().as_secs()
        ),
        Err(v) => {
            eprintln!("VIOLATION kind={} detail={}", v.kind, v.detail);
            std::process::exit(1);
        }
    }

    match run_stress(seed, opts) {
        Ok(report) => {
            let secs = elapsed.elapsed().as_secs();
            println!(
                "STRESS-OK created={created} completed={completed} failed={failed} cancelled={cancelled} \
cancel_successes={cancel_successes} checks={checks_run} peaks_queued={peak_queued} \
peak_retained={peak_retained} pauses={pauses} recoveries={recoveries} merged={merged_tasks} \
stale_dropped={stale_dropped} anti_starvation={anti_starvation_promotions} ({secs}s)",
                created = report.created,
                completed = report.completed,
                failed = report.failed,
                cancelled = report.cancelled,
                cancel_successes = report.cancel_successes,
                checks_run = report.checks_run,
                peak_queued = report.peak_queued,
                peak_retained = report.peak_retained,
                pauses = report.pauses,
                recoveries = report.recoveries,
                merged_tasks = report.merged_tasks,
                stale_dropped = report.stale_dropped,
                anti_starvation_promotions = report.anti_starvation_promotions,
            );
        }
        Err(v) => {
            eprintln!("VIOLATION kind={} detail={}", v.kind, v.detail);
            std::process::exit(1);
        }
    }
}
