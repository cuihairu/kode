//! RUST-127 持久化缓存落盘写入面:崩溃安全写入 + 损坏可清理重建。
//!
//! 写协议(单条目全有或全无,RUST-127 行逐句):
//! 1. **临时文件 + 原子 rename**:写入永远先落
//!    `{dir}/tmp-{keyhex}-{pid}-{nanos}.tmp`,`sync_all`(fsync)到盘后
//!    `rename` 到 `{dir}/{keyhex}.bin`——同卷 rename 原子,读者看到的条目
//!    要么旧要么新,永无半态。rename 前崩溃只留孤儿 tmp(下次 open 清扫),
//!    rename 后崩溃条目必完整。
//! 2. **帧格式** = `[KODEPS01][payload_len u64 LE][payload][指纹 u64 LE]`:
//!    魔数+版本给格式身份(旧格式/外杂质 → 损坏),尾指纹(内容 + 长度)
//!    给字节损坏检测。
//! 3. **损坏可清理重建**:读侧命中坏帧(魔数错/长度不符/指纹不符)= 立即
//!    删除该条目并按未命中(`Ok(None)`)返回——坏字节永不出库,调用方按
//!    miss 语义重建,零正确性损失。
//!
//! 诚实边界:
//! - **WAL 不做**——单条目 rename 原子已给全有或全无;WAL 解决多条目事务
//!   语义,本面无此需求(RUST-128 格式基准 SQLite/redb 时按需回看)。
//! - rename 的原子性本身是文件系统语义,进程内测试钉的是协议形状:tmp 用
//!   后即清、损坏帧必被清理且永不被服务、孤儿 tmp 开库即扫、外来文件不动。
//! - payload 为不透明字节;解析产物序列化格式与压缩属 RUST-128 基准面。

use std::path::{Path, PathBuf};

use crate::parse_cache::content_fingerprint_bytes;
use crate::persist_key::PersistCacheKey;

/// 帧魔数 + 格式版本(`KODEPS01` = kode persist frame v1)。
const MAGIC: &[u8; 8] = b"KODEPS01";
const LEN_BYTES: usize = 8;
const FP_BYTES: usize = 8;
/// 魔数 + 长度头 + 尾指纹的最小帧长。
const FRAME_OVERHEAD: usize = MAGIC.len() + LEN_BYTES + FP_BYTES;
const TMP_PREFIX: &str = "tmp-";
const ENTRY_EXT: &str = ".bin";

/// 持久化缓存库:一个目录一组 `{keyhex}.bin` 条目,key 来自
/// [`persist_cache_key`](crate::persist_key::persist_cache_key)(RUST-126
/// 五因子契约)。全部操作打真实文件系统,无进程内镜像(条目身份以盘为准)。
#[derive(Debug, Clone)]
pub struct PersistStore {
    dir: PathBuf,
}

impl PersistStore {
    /// 打开(不存在则建)并清扫上次崩溃残留的孤儿 tmp 文件。
    pub fn open(dir: &Path) -> std::io::Result<PersistStore> {
        std::fs::create_dir_all(dir)?;
        let store = PersistStore {
            dir: dir.to_path_buf(),
        };
        store.sweep_tmp_files()?;
        Ok(store)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 条目落盘路径(32 hex + `.bin`;文件名只含 key hex,路径零注入面)。
    pub fn entry_path(&self, key: &PersistCacheKey) -> PathBuf {
        self.dir.join(format!("{}{ENTRY_EXT}", key.hex()))
    }

    /// 崩溃安全写入:temp 全量帧 + fsync → rename 原子就位。任何一步失败
    /// 都尽力清掉 temp(半途失败不留毒 tmp),错误原样上抛。
    pub fn write(&self, key: &PersistCacheKey, payload: &[u8]) -> std::io::Result<()> {
        // open 之后的目录可能被外部删掉;写入面兜底重建,不让一次清库杀死后续写。
        std::fs::create_dir_all(&self.dir)?;
        let temp = self.temp_path(key);
        let result = Self::write_frame(&temp, payload);
        if let Err(err) = result {
            let _ = std::fs::remove_file(&temp);
            return Err(err);
        }
        match std::fs::rename(&temp, self.entry_path(key)) {
            Ok(()) => {
                self.sync_dir_best_effort();
                Ok(())
            }
            Err(err) => {
                let _ = std::fs::remove_file(&temp);
                Err(err)
            }
        }
    }

    /// 读条目:未命中 `Ok(None)`;命中坏帧 = 删除该条目(清理)后同样按
    /// 未命中返回——损坏可清理重建。真实 IO 错误(权限等)原样上抛。
    pub fn read(&self, key: &PersistCacheKey) -> std::io::Result<Option<Vec<u8>>> {
        let path = self.entry_path(key);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        };
        match Self::decode_frame(&bytes) {
            Some(payload) => Ok(Some(payload)),
            None => {
                let _ = std::fs::remove_file(&path);
                Ok(None)
            }
        }
    }

    /// 删除条目;不存在视为已删(幂等)。
    pub fn remove(&self, key: &PersistCacheKey) -> std::io::Result<()> {
        match std::fs::remove_file(self.entry_path(key)) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err),
        }
    }

    /// 清库:删除全部本店条目(`*.bin`)与残留 tmp,返回删除的条目数;
    /// 目录内外来文件(非本店命名形态)一律不动。
    pub fn clear(&self) -> std::io::Result<usize> {
        let mut removed = 0usize;
        for entry in std::fs::read_dir(&self.dir)? {
            let entry = entry?;
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            let is_entry = name.ends_with(ENTRY_EXT);
            if (is_entry || Self::is_store_tmp(name))
                && std::fs::remove_file(entry.path()).is_ok()
                && is_entry
            {
                removed += 1;
            }
        }
        Ok(removed)
    }

    fn temp_path(&self, key: &PersistCacheKey) -> PathBuf {
        // pid + 纳秒:并发写者(同进程线程/不同进程)temp 名互撞概率可忽略;
        // 撞了也是 File::create 竞态报错,不产生半条目。
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        self.dir.join(format!(
            "{TMP_PREFIX}{}-{}-{nanos}.tmp",
            key.hex(),
            std::process::id()
        ))
    }

    fn is_store_tmp(name: &str) -> bool {
        name.starts_with(TMP_PREFIX) && name.ends_with(".tmp")
    }

    fn sweep_tmp_files(&self) -> std::io::Result<()> {
        for entry in std::fs::read_dir(&self.dir)? {
            let entry = entry?;
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            if Self::is_store_tmp(name) {
                // 孤儿 tmp 属崩溃残留,删除失败(权限)不阻塞开库。
                let _ = std::fs::remove_file(entry.path());
            }
        }
        Ok(())
    }

    fn write_frame(temp: &Path, payload: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(temp)?;
        file.write_all(&Self::encode_frame(payload))?;
        // fsync 到盘之后才允许 rename:掉电窗口内的条目也完整。
        file.sync_all()
    }

    fn sync_dir_best_effort(&self) {
        // 目录 fsync 让 rename 本身落盘;平台不支持/失败不致命(尽力而为)。
        if let Ok(dir) = std::fs::File::open(&self.dir) {
            let _ = dir.sync_all();
        }
    }

    fn encode_frame(payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(FRAME_OVERHEAD + payload.len());
        frame.extend_from_slice(MAGIC);
        frame.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        frame.extend_from_slice(payload);
        frame.extend_from_slice(&content_fingerprint_bytes(payload).to_le_bytes());
        frame
    }

    /// 帧解码:任一校验不过(过短/魔数错/长度不符/指纹不符)→ `None`。
    fn decode_frame(bytes: &[u8]) -> Option<Vec<u8>> {
        if bytes.len() < FRAME_OVERHEAD || &bytes[0..MAGIC.len()] != MAGIC {
            return None;
        }
        let len = u64::from_le_bytes(
            bytes[MAGIC.len()..MAGIC.len() + LEN_BYTES]
                .try_into()
                .ok()?,
        ) as usize;
        if len != bytes.len() - FRAME_OVERHEAD {
            return None;
        }
        let payload_start = MAGIC.len() + LEN_BYTES;
        let payload = &bytes[payload_start..payload_start + len];
        let fp_start = payload_start + len;
        let stored = u64::from_le_bytes(bytes[fp_start..fp_start + FP_BYTES].try_into().ok()?);
        if content_fingerprint_bytes(payload) != stored {
            return None;
        }
        Some(payload.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kode-vfs-persist-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn key_of(path: &str) -> PersistCacheKey {
        crate::persist_key::persist_cache_key(
            &crate::persist_key::PersistKeyFactors {
                core_schema: "1",
                engine_profile: "seed-a",
                root_identity: "/ws",
                workspace_config: "cfg",
                parser_version: "0.2.0",
            },
            path,
        )
    }

    fn entry_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn write_then_read_roundtrip_with_clean_layout() {
        let dir = temp_dir("roundtrip");
        let store = PersistStore::open(&dir).unwrap();
        let key = key_of("/ws/A.def");
        store.write(&key, b"payload-1").unwrap();
        assert_eq!(
            store.read(&key).unwrap().as_deref(),
            Some(b"payload-1".as_slice())
        );
        // 布局:恰好一个 {hex}.bin,写后无残留 tmp。
        let names = entry_names(&dir);
        assert_eq!(names, vec![format!("{}{ENTRY_EXT}", key.hex())]);
        assert!(store.entry_path(&key).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn overwrite_same_key_replaces_content_atomically() {
        let dir = temp_dir("overwrite");
        let store = PersistStore::open(&dir).unwrap();
        let key = key_of("/ws/A.def");
        store.write(&key, b"first").unwrap();
        store.write(&key, b"second-payload").unwrap();
        assert_eq!(
            store.read(&key).unwrap().as_deref(),
            Some(b"second-payload".as_slice())
        );
        // 覆盖写不堆积:仍只有一个条目文件。
        assert_eq!(entry_names(&dir).len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_entry_reads_none_not_error() {
        let dir = temp_dir("missing");
        let store = PersistStore::open(&dir).unwrap();
        assert_eq!(store.read(&key_of("/ws/never.def")).unwrap(), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn empty_payload_roundtrips() {
        let dir = temp_dir("empty");
        let store = PersistStore::open(&dir).unwrap();
        let key = key_of("/ws/E.def");
        store.write(&key, b"").unwrap();
        assert_eq!(store.read(&key).unwrap().as_deref(), Some(&[][..]));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn corrupted_payload_byte_is_cleaned_and_reads_miss() {
        let dir = temp_dir("corrupt-byte");
        let store = PersistStore::open(&dir).unwrap();
        let key = key_of("/ws/A.def");
        store.write(&key, b"good-payload").unwrap();
        // 保持帧长度不变,翻转一个 payload 字节 → 指纹必不过。
        let path = store.entry_path(&key);
        let mut bytes = std::fs::read(&path).unwrap();
        let mid = bytes.len() - FP_BYTES - 1;
        bytes[mid] ^= 0xff;
        std::fs::write(&path, &bytes).unwrap();
        // 损坏可清理重建:返回 miss 且坏条目已出库。
        assert_eq!(store.read(&key).unwrap(), None);
        assert!(!path.exists(), "坏条目必须被清理,不得留在库内");
        // 清理后按 miss 重建:再写再读,完好如初。
        store.write(&key, b"rebuilt").unwrap();
        assert_eq!(
            store.read(&key).unwrap().as_deref(),
            Some(b"rebuilt".as_slice())
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn truncated_frame_is_cleaned_and_reads_miss() {
        let dir = temp_dir("truncate");
        let store = PersistStore::open(&dir).unwrap();
        let key = key_of("/ws/T.def");
        store.write(&key, b"longer-payload").unwrap();
        let path = store.entry_path(&key);
        let bytes = std::fs::read(&path).unwrap();
        // 长度头说有 N,文件只剩一半 → 长度校验必不过。
        std::fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();
        assert_eq!(store.read(&key).unwrap(), None);
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn foreign_magic_frame_is_cleaned_and_reads_miss() {
        let dir = temp_dir("magic");
        let store = PersistStore::open(&dir).unwrap();
        let key = key_of("/ws/M.def");
        store.write(&key, b"payload").unwrap();
        let path = store.entry_path(&key);
        // 整文件换外杂质(长度随意)→ 魔数校验必不过。
        std::fs::write(&path, b"not-a-frame-at-all").unwrap();
        assert_eq!(store.read(&key).unwrap(), None);
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_sweeps_orphan_tmp_but_keeps_foreign_files() {
        let dir = temp_dir("sweep");
        // 模拟 rename 前崩溃:库里留孤儿 tmp + 一个外来文件。
        std::fs::write(dir.join("tmp-deadbeef-42-1.tmp"), b"half-frame").unwrap();
        std::fs::write(dir.join("notes.txt"), b"keep me").unwrap();
        let store = PersistStore::open(&dir).unwrap();
        assert!(
            !dir.join("tmp-deadbeef-42-1.tmp").exists(),
            "孤儿 tmp 必须开库即扫"
        );
        assert!(dir.join("notes.txt").exists(), "外来文件不得误伤");
        let _ = store;
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn remove_is_idempotent_and_clear_keeps_foreign_files() {
        let dir = temp_dir("clear");
        let store = PersistStore::open(&dir).unwrap();
        let a = key_of("/ws/A.def");
        let b = key_of("/ws/B.def");
        store.write(&a, b"a").unwrap();
        store.write(&b, b"b").unwrap();
        std::fs::write(dir.join("notes.txt"), b"keep").unwrap();
        std::fs::write(dir.join("tmp-leftover-7-9.tmp"), b"x").unwrap();
        // remove 幂等:不存在也 Ok。
        store.remove(&a).unwrap();
        store.remove(&a).unwrap();
        assert_eq!(store.read(&a).unwrap(), None);
        // clear:两个 .bin 全清、tmp 清、外来文件不动。
        assert_eq!(store.clear().unwrap(), 1, "返回值只计本店条目");
        assert!(store.read(&b).unwrap().is_none());
        assert!(!dir.join("tmp-leftover-7-9.tmp").exists());
        assert!(dir.join("notes.txt").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dir_accessor_exposes_store_root() {
        let dir = temp_dir("dir-accessor");
        let store = PersistStore::open(&dir).unwrap();
        assert_eq!(store.dir(), dir.as_path());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn write_failure_removes_temp_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("write-fail");
        let store = PersistStore::open(&dir).unwrap();
        let key = key_of("/ws/W.def");
        // 目录只读:write_frame 建 tmp 必 EACCES → 失败路径清理 tmp
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        assert!(store.write(&key, b"payload").is_err());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let names = entry_names(&dir);
        assert!(names.is_empty(), "失败后不得残留: {names:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_failure_removes_temp_and_errors() {
        let dir = temp_dir("rename-fail");
        let store = PersistStore::open(&dir).unwrap();
        let key = key_of("/ws/R.def");
        // 目标位预置目录:rename(file→dir) 必失败 → 失败路径清理 tmp
        std::fs::create_dir(store.entry_path(&key)).unwrap();
        assert!(store.write(&key, b"payload").is_err());
        let tmp_left: Vec<String> = entry_names(&dir)
            .into_iter()
            .filter(|n| n.starts_with(TMP_PREFIX))
            .collect();
        assert!(tmp_left.is_empty(), "失败后不得残留 tmp: {tmp_left:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn read_io_error_on_directory_entry_propagates() {
        let dir = temp_dir("read-eisdir");
        let store = PersistStore::open(&dir).unwrap();
        let key = key_of("/ws/D.def");
        std::fs::create_dir(store.entry_path(&key)).unwrap();
        // fs::read(目录) = EISDIR:真实 IO 错误原样上抛,不当未命中
        assert!(store.read(&key).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn remove_io_error_on_directory_entry_propagates() {
        let dir = temp_dir("remove-eisdir");
        let store = PersistStore::open(&dir).unwrap();
        let key = key_of("/ws/RM.def");
        std::fs::create_dir(store.entry_path(&key)).unwrap();
        assert!(store.remove(&key).is_err());
        // 不存在 = 幂等 Ok(NotFound 分支既有口径对照)
        assert!(store.remove(&key_of("/ws/absent.def")).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn frame_length_mismatch_reads_miss_after_cleanup() {
        let dir = temp_dir("len-mismatch");
        let store = PersistStore::open(&dir).unwrap();
        let key = key_of("/ws/L.def");
        // 手构帧:魔数 + 与真实载荷不符的长度头 + 载荷 + 指纹 → decode None
        let mut frame = Vec::new();
        frame.extend_from_slice(MAGIC);
        frame.extend_from_slice(&7u64.to_le_bytes());
        frame.extend_from_slice(b"payload-x");
        frame.extend_from_slice(&[0u8; FP_BYTES]);
        std::fs::write(store.entry_path(&key), &frame).unwrap();
        assert_eq!(store.read(&key).unwrap(), None);
        assert!(!store.entry_path(&key).exists(), "坏帧条目应被清理");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    // 非 UTF8 文件名(0xff/0xfe)仅 Linux 原生文件系统放行;macOS APFS 按
    // UTF-8 校验路径,fs::write 直接 EILSEQ(nightly darwin 44645370378)。
    #[cfg(target_os = "linux")]
    fn clear_and_sweep_skip_non_utf8_names() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        let dir = temp_dir("non-utf8");
        // 开库前放非 UTF8 名文件:sweep 与 clear 两面都须跳过
        let alien = OsString::from_vec(vec![0xff, 0xfe, b'.', b'b', b'i', b'n']);
        std::fs::write(dir.join(&alien), b"x").unwrap();
        let store = PersistStore::open(&dir).unwrap();
        let key = key_of("/ws/A.def");
        store.write(&key, b"p").unwrap();
        assert_eq!(store.clear().unwrap(), 1, "只清自己的条目");
        assert!(
            std::fs::read_dir(&dir)
                .unwrap()
                .any(|e| e.unwrap().file_name() == alien),
            "非 UTF8 名外来文件不得被动"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
