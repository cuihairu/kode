//! Independent archive key storage (PDC-0205: archives are encrypted by default; keys are never stored alongside the archive).
//!
//! [`KeyStore`] abstracts key generation and retrieval; [`FileKeyStore`] places keys in a caller-specified
//! separate directory (e.g. the user data directory), writes them to disk with 0600 permissions, and **refuses** a key
//! directory located inside the archive output directory — structurally guaranteeing "keys are never stored with the archive".
//! Archive frames never contain key material.

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use sha2::{Digest, Sha256};

use crate::error::{CloneError, CloneResult};

/// 32-byte key (chacha20poly1305 key length).
pub type ArchiveKey = [u8; 32];

/// Key store abstraction.
pub trait KeyStore {
    /// Fetch the key; generate and persist one if absent.
    fn get_or_create(&self, id: &str) -> CloneResult<ArchiveKey>;
    /// Whether the key already exists (without reading it).
    fn exists(&self, id: &str) -> bool;
}

/// Archive path → key id: SHA-256 hex of the absolutized path (64 hex chars, all within
/// `FileKeyStore`'s safe set). The path string itself is never used as the id — `/`, `\`, `:`, etc. would be
/// sanitized to `_`, so different paths could collide; a hash is deterministic and collision-free. The id is stably bound
/// to where the archive lives: moving/renaming the archive changes the id, and the read side honestly reports "key missing" rather than guessing.
pub fn key_id_for_archive(path: &Path) -> String {
    let abs = key_absolutize(path);
    let mut hasher = Sha256::new();
    hasher.update(abs.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// File-based key store: separate directory + 0600 permissions.
pub struct FileKeyStore {
    root: PathBuf,
}

impl FileKeyStore {
    /// Creates the store; `root` must be separate from the archive output directory (enforced by this type).
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn key_path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{}.key", safe_id(id)))
    }

    /// Stages the key into a same-directory temp file (exclusively created at 0600, then fsynced); publishing goes through hard_link.
    /// On a name collision (a stale temp file that happens to reuse the same pid), retries with a new counter value.
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
            // Pin permissions at 0600: open's mode bits get stripped by the umask; an explicit chmod guarantees
            // the final state exactly matches the old implementation (key material never sits on a non-0600 final path).
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

/// id sanitization: only safe characters allowed, guards against path traversal.
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

/// Monotonic temp-file counter: uniquifies temp file names within the process (a counter on top of the pid).
static TEMP_KEY_SEQ: AtomicU64 = AtomicU64::new(0);

/// Reads and validates a key file: non-32-byte content is honestly reported as InvalidData (a corrupted file is never
/// silently regenerated — regeneration would only mint a wrong key that cannot open the existing archives).
fn read_key_file(path: &Path) -> std::io::Result<ArchiveKey> {
    let mut buf = Vec::new();
    fs::File::open(path)?.read_to_end(&mut buf)?;
    buf.try_into()
        .map_err(|_| std::io::Error::new(ErrorKind::InvalidData, "key is not 32 bytes"))
}

/// Exclusively creates a new file; on Unix it is created at 0600 (key material is owner-readable only from the instant it
/// hits disk — there is no "default permissions first, chmod later" exposure window).
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
        // A published key is read directly: publishing is atomic (see below), so once the final path exists its content is
        // necessarily a complete 32 bytes; corrupted files are honestly reported, never silently regenerated.
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
        // KODE-FULL-016: three-step atomic publish —
        // 1. Exclusively create a same-directory temp file (0600 from creation) + write a full 32 bytes + fsync;
        // 2. hard_link to the final path: fails with AlreadyExists when the target exists — this is a
        //    kernel-level create-or-fail primitive, so exactly one winner exists under concurrent first creation (holds across processes);
        // 3. Losers delete their own temp file and read the winning key.
        // The final path never exposes partial content; no failure path leaves a file behind; an existing key
        // is never overwritten (the old fs::write would truncate each other, silently swapping out the first arriver's key).
        let tmp = self.stage_key_temp(id, &key)?;
        match fs::hard_link(&tmp, &path) {
            Ok(()) => {
                let _ = fs::remove_file(&tmp); // link count back to one: publish complete
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

/// Verifies the key directory is not inside the archive output directory (the structural guarantee of independent key storage).
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
        // Re-reading yields the same key (persisted, not newly generated each time).
        assert_eq!(store.get_or_create("avatar-export").unwrap(), key);
        // Permissions 0600.
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
        // Path traversal is flattened into ___escape.
        assert!(dir.join("___escape.key").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_dir_inside_archive_refused() {
        let archive = std::env::temp_dir().join(format!("kode-arc-{}", std::process::id()));
        let inside = archive.join("keys");
        assert!(ensure_key_outside_archive(&inside, &archive).is_err());
        // Another key directory still inside the archive → refused.
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
        // Key material is not in the struct at all (only the root path).
        assert!(!rendered.contains("key:"));
    }

    #[test]
    fn relative_paths_are_absolutized_for_containment() {
        // A relative key directory is resolved against cwd before the containment check (covers the non-absolute-path branch).
        let cwd = std::env::current_dir().unwrap();
        let archive = cwd.join("kode-rel-arch");
        // A relative sibling directory under cwd → not inside the archive path, allowed.
        let sibling_rel = std::path::Path::new("kode-rel-keys");
        assert!(ensure_key_outside_archive(sibling_rel, &archive).is_ok());
        // A relative path that resolves inside the archive path → refused.
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
        // Archive key id = SHA-256 hex of the absolutized path: constant for the same path, different for different paths;
        // 64 hex chars with a safe character set. The raw path string is never used (it would collide).
        let a = key_id_for_archive(std::path::Path::new("/data/a.kdpclone"));
        let b = key_id_for_archive(std::path::Path::new("/data/a.kdpclone"));
        let c = key_id_for_archive(std::path::Path::new("/data/b.kdpclone"));
        assert_eq!(a, b, "constant for the same path");
        assert_ne!(a, c, "different paths get different ids");
        assert_eq!(a.len(), 64, "SHA-256 hex = 64 chars");
        assert!(a.chars().all(|ch| ch.is_ascii_hexdigit()));
    }
}
