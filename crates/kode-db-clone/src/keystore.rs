//! 归档密钥独立存储(PDC-0205:默认加密归档,密钥不跟归档同存)。
//!
//! [`KeyStore`] 抽象密钥的生成与读取;[`FileKeyStore`] 把密钥落在调用方指定的
//! 独立目录(如用户数据目录),以 0600 权限写盘,且**拒绝**密钥目录落在归档
//! 输出目录内——结构上保证「密钥不跟归档同存」。归档帧永不包含密钥材料。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

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
        // id 只允许安全字符,防路径穿越。
        let safe: String = id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        self.root.join(format!("{safe}.key"))
    }
}

impl std::fmt::Debug for FileKeyStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileKeyStore").field("root", &self.root).finish()
    }
}

impl KeyStore for FileKeyStore {
    fn get_or_create(&self, id: &str) -> CloneResult<ArchiveKey> {
        let path = self.key_path(id);
        if path.exists() {
            let mut buf = Vec::new();
            fs::File::open(&path)
                .and_then(|mut f| f.read_to_end(&mut buf))
                .map_err(|e| CloneError::InvalidRule(format!("read key `{id}`: {e}")))?;
            let key: ArchiveKey = buf
                .as_slice()
                .try_into()
                .map_err(|_| CloneError::InvalidRule(format!("key `{id}` is not 32 bytes")))?;
            return Ok(key);
        }
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key)
            .map_err(|e| CloneError::InvalidRule(format!("generate key: {e}")))?;
        fs::create_dir_all(&self.root)
            .map_err(|e| CloneError::InvalidRule(format!("create key dir: {e}")))?;
        fs::write(&path, key)
            .map_err(|e| CloneError::InvalidRule(format!("write key `{id}`: {e}")))?;
        // 0600:仅属主可读(密钥材料不该组/其他可读)。Unix 下强制;非 Unix
        // 依赖宿主 ACL/凭据存储策略(Windows 由用户目录 ACL 提供)。
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|e| CloneError::InvalidRule(format!("chmod key `{id}`: {e}")))?;
        Ok(key)
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
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(p)
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
}
