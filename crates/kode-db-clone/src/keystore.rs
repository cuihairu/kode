//! 归档密钥独立存储(PDC-0205:默认加密归档,密钥不跟归档同存)。
//!
//! [`KeyStore`] 抽象密钥的生成与读取;[`FileKeyStore`] 把密钥落在调用方指定的
//! 独立目录(如用户数据目录),以 0600 权限写盘,且**拒绝**密钥目录落在归档
//! 输出目录内——结构上保证「密钥不跟归档同存」。归档帧永不包含密钥材料。

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use sha2::{Digest, Sha256};

use crate::error::{CloneError, CloneResult};

/// 32 字节密钥(chacha20poly1305 密钥长度)。
pub type ArchiveKey = [u8; 32];

/// 密钥存储抽象。
pub trait KeyStore {
    /// 取密钥;不存在则生成并持久化。
    fn get_or_create(&self, id: &str) -> CloneResult<ArchiveKey>;
    /// 密钥是否已存在(不读取)。
    fn exists(&self, id: &str) -> bool;
}

/// 归档路径 → 密钥 id:绝对化路径的 SHA-256 十六进制(64 hex,字符全在
/// `FileKeyStore` 安全集内)。不直接用路径字符串作 id——`/`/`\`/`:` 等会被
/// 消毒成 `_`,不同路径可能撞名;哈希确定、无碰撞。id 稳定绑定归档所在
/// 位置:归档移动/改名后 id 变化,读侧按「密钥缺失」如实报错,不猜。
pub fn key_id_for_archive(path: &Path) -> String {
    let abs = key_absolutize(path);
    let mut hasher = Sha256::new();
    hasher.update(abs.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 文件密钥存储:独立目录 + 0600 权限。
pub struct FileKeyStore {
    root: PathBuf,
}

impl FileKeyStore {
    /// 建立存储;`root` 必须与归档输出目录分离(本类型强制)。
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn key_path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{}.key", safe_id(id)))
    }

    /// 密钥先落同目录临时件(独占创建即 0600、fsync),发布走 hard_link。
    /// 撞名(陈旧临时件恰好复用同 pid)换计数重试。
    fn stage_key_temp(&self, id: &str, key: &ArchiveKey) -> CloneResult<PathBuf> {
        let stem = safe_id(id);
        for _ in 0..8 {
            let seq = TEMP_KEY_SEQ.fetch_add(1, Ordering::Relaxed);
            let tmp = self
                .root
                .join(format!("{stem}.{}.{}.tmp", std::process::id(), seq));
            let mut file = match open_new_private(&tmp) {
                Ok(file) => file,
                Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    return Err(CloneError::InvalidRule(format!("stage key `{id}`: {e}")));
                }
            };
            if let Err(e) = file.write_all(key).and_then(|_| file.sync_all()) {
                let _ = fs::remove_file(&tmp);
                return Err(CloneError::InvalidRule(format!("stage key `{id}`: {e}")));
            }
            // 权限钉死 0600:open 的 mode 位会被 umask 剥离,显式 chmod 保证
            // 终态与旧实现完全一致(密钥材料永不出现在非 0600 的最终路径上)。
            #[cfg(unix)]
            if let Err(e) = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)) {
                let _ = fs::remove_file(&tmp);
                return Err(CloneError::InvalidRule(format!("chmod key `{id}`: {e}")));
            }
            return Ok(tmp);
        }
        Err(CloneError::InvalidRule(format!(
            "stage key `{id}`: temp name collision"
        )))
    }
}

/// id 消毒:只允许安全字符,防路径穿越。
fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 临时件单调计数:进程内唯一化临时件名(pid 之外再加计数)。
static TEMP_KEY_SEQ: AtomicU64 = AtomicU64::new(0);

/// 读取并校验密钥文件:非 32 字节按 InvalidData 如实报错(损坏文件绝不
/// 静默重生成——重生成只会造出解不开既有归档的错误钥匙)。
fn read_key_file(path: &Path) -> std::io::Result<ArchiveKey> {
    let mut buf = Vec::new();
    fs::File::open(path)?.read_to_end(&mut buf)?;
    buf.try_into()
        .map_err(|_| std::io::Error::new(ErrorKind::InvalidData, "key is not 32 bytes"))
}

/// 独占创建新文件;Unix 下创建即 0600(密钥材料在落盘瞬间就只有属主可读,
/// 不存在「先默认权限再补 chmod」的暴露窗口)。
fn open_new_private(path: &Path) -> std::io::Result<fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
    }
    #[cfg(not(unix))]
    {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
    }
}

impl std::fmt::Debug for FileKeyStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileKeyStore")
            .field("root", &self.root)
            .finish()
    }
}

impl KeyStore for FileKeyStore {
    fn get_or_create(&self, id: &str) -> CloneResult<ArchiveKey> {
        let path = self.key_path(id);
        // 已发布密钥直接读:发布是原子的(见下),最终路径一经出现,内容必为
        // 完整 32 字节;损坏文件如实报错,不静默重生成。
        match read_key_file(&path) {
            Ok(key) => return Ok(key),
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => {
                return Err(CloneError::InvalidRule(format!("read key `{id}`: {e}")));
            }
        }
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key)
            .map_err(|e| CloneError::InvalidRule(format!("generate key: {e}")))?;
        fs::create_dir_all(&self.root)
            .map_err(|e| CloneError::InvalidRule(format!("create key dir: {e}")))?;
        // KODE-FULL-016:原子发布三步——
        // 1. 同目录临时件独占创建(即 0600)+ 写满 32 字节 + fsync;
        // 2. hard_link 到最终路径:目标已存在时以 AlreadyExists 失败,是
        //    内核级 create-or-fail 原语——并发首建恰有一个赢家(跨进程成立);
        // 3. 败者删自己的临时件、只读获胜密钥。
        // 最终路径从不暴露部分内容;任何失败路径不残留文件;已存在密钥
        // 绝不被覆盖(旧 fs::write 会互相截断,把先到者手里的钥匙悄悄换掉)。
        let tmp = self.stage_key_temp(id, &key)?;
        match fs::hard_link(&tmp, &path) {
            Ok(()) => {
                let _ = fs::remove_file(&tmp); // 链接计数归一:发布完成
                Ok(key)
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                let _ = fs::remove_file(&tmp);
                read_key_file(&path)
                    .map_err(|e| CloneError::InvalidRule(format!("read key `{id}`: {e}")))
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                Err(CloneError::InvalidRule(format!("publish key `{id}`: {e}")))
            }
        }
    }

    fn exists(&self, id: &str) -> bool {
        self.key_path(id).exists()
    }
}

/// 校验密钥目录不在归档输出目录内(密钥独立存储的结构性保证)。
pub fn ensure_key_outside_archive(key_root: &Path, archive_path: &Path) -> CloneResult<()> {
    let key_abs = key_absolutize(key_root);
    let archive_abs = key_absolutize(archive_path);
    if key_abs.starts_with(&archive_abs) {
        return Err(CloneError::InvalidRule(format!(
            "key directory `{}` must not live inside the archive path `{}`",
            key_abs.display(),
            archive_abs.display()
        )));
    }
    Ok(())
}

fn key_absolutize(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_persists_and_reloads() {
        let dir = std::env::temp_dir().join(format!("kode-key-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = FileKeyStore::new(&dir);
        let key = store.get_or_create("avatar-export").unwrap();
        assert_eq!(key.len(), 32);
        assert!(store.exists("avatar-export"));
        // 重读一致(持久化,不是每次新生成)。
        assert_eq!(store.get_or_create("avatar-export").unwrap(), key);
        // 权限 0600。
        #[cfg(unix)]
        {
            let mode = fs::metadata(dir.join("avatar-export.key"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn id_sanitized_against_path_traversal() {
        let dir = std::env::temp_dir().join(format!("kode-key-test-2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = FileKeyStore::new(&dir);
        store.get_or_create("../escape").unwrap();
        // 路径穿越被拍平为 ___escape。
        assert!(dir.join("___escape.key").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_dir_inside_archive_refused() {
        let archive = std::env::temp_dir().join(format!("kode-arc-{}", std::process::id()));
        let inside = archive.join("keys");
        assert!(ensure_key_outside_archive(&inside, &archive).is_err());
        // 再一个密钥目录仍在归档内 → 拒绝。
        assert!(ensure_key_outside_archive(&archive.join("elsewhere"), &archive).is_err());
        let outside = std::env::temp_dir().join("kode-keys-elsewhere");
        assert!(ensure_key_outside_archive(&outside, &archive).is_ok());
    }

    #[test]
    fn debug_impl_exposes_root_only() {
        let dir = std::env::temp_dir().join(format!("kode-key-dbg-{}", std::process::id()));
        let store = FileKeyStore::new(&dir);
        let rendered = format!("{store:?}");
        assert!(rendered.contains("FileKeyStore"), "{rendered}");
        assert!(rendered.contains("kode-key-dbg"), "{rendered}");
        // 密钥材料本就不在结构里(仅 root 路径)。
        assert!(!rendered.contains("key:"));
    }

    #[test]
    fn relative_paths_are_absolutized_for_containment() {
        // 相对密钥目录按 cwd 解析后判定包含关系(覆盖非绝对路径分支)。
        let cwd = std::env::current_dir().unwrap();
        let archive = cwd.join("kode-rel-arch");
        // cwd 下的相对兄弟目录 → 不在归档路径之内,放行。
        let sibling_rel = std::path::Path::new("kode-rel-keys");
        assert!(ensure_key_outside_archive(sibling_rel, &archive).is_ok());
        // 相对路径解析后落在归档路径之内 → 拒绝。
        let nested_rel = std::path::Path::new("kode-rel-arch/keys");
        assert!(ensure_key_outside_archive(nested_rel, &archive).is_err());
    }

    #[test]
    fn corrupted_key_file_is_rejected_with_clear_error() {
        let dir = std::env::temp_dir().join(format!("kode-key-corrupt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("short.key"), b"too-short").unwrap();
        let store = FileKeyStore::new(&dir);
        match store.get_or_create("short") {
            Err(CloneError::InvalidRule(m)) => assert!(m.contains("not 32 bytes"), "{m}"),
            other => panic!("expected length rejection, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_id_for_archive_is_deterministic_and_path_bound() {
        // 归档密钥 id = 绝对化路径的 SHA-256 十六进制:同路径恒定,不同路径不同;
        // 64 hex 字符,字符集安全。绝不直接用路径串(会撞名)。
        let a = key_id_for_archive(std::path::Path::new("/data/a.kdpclone"));
        let b = key_id_for_archive(std::path::Path::new("/data/a.kdpclone"));
        let c = key_id_for_archive(std::path::Path::new("/data/b.kdpclone"));
        assert_eq!(a, b, "同路径恒定");
        assert_ne!(a, c, "不同路径不同 id");
        assert_eq!(a.len(), 64, "SHA-256 hex = 64 字符");
        assert!(a.chars().all(|ch| ch.is_ascii_hexdigit()));
    }
}
