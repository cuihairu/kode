//! 归档容器格式原语:魔数/版本/标志位/头长/大小上限、帧序列读取(`read_frames`)、
//! 帧 AEAD 加解密(`aead_seal`/`aead_open`)、头部加密位探测(`is_encrypted`)。
//! 只认字节与帧边界,不构造清单(`ArchiveMeta`/`TableMeta` 留在 archive.rs);
//! 写入面/读取面经 `use` 引回本层符号。

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use sha2::{Digest, Sha256};

use super::ArchiveKey;
use crate::error::{CloneError, CloneResult};

/// 魔数(9 字节)。
pub(super) const MAGIC: &[u8; 9] = b"KDPCLONE1";
/// 归档格式版本(读取面只认这一版;升级须新版本号+迁移读取)。
pub(super) const FORMAT_VERSION: u8 = 1;
/// 标志位:bit0 = 帧经 chacha20poly1305 加密。
pub(super) const FLAG_ENCRYPTED: u8 = 0x01;
/// 头长:魔数 9 + 版本 1 + 标志 1。
pub(super) const HEADER_LEN: usize = MAGIC.len() + 2;
/// 归档大小上限:开档与写档都按此拒绝(防解压/拼接攻击与失控导出)。
pub const MAX_ARCHIVE_SIZE: u64 = 4 * 1024 * 1024 * 1024;
/// chacha20poly1305 认证标签长:帧头记的是**明文字节长**,加密时密文=明文+本值。
pub(super) const AEAD_TAG_LEN: usize = 16;
/// 清单里的格式名。
pub(super) const FORMAT_NAME: &str = "kdpclone";

/// 大小上限检查(开档按文件长度,写档按累计字节数)。
pub(super) fn enforce_size_cap(limit: u64, len: u64) -> CloneResult<()> {
    if len > limit {
        return Err(CloneError::ArchiveError(format!(
            "archive size {len} exceeds the {limit}-byte limit"
        )));
    }
    Ok(())
}

/// 帧序列读取:逐帧重建头部作 AEAD 关联数据,明文 SHA-256 逐帧核对。
pub(super) fn read_frames(
    r: &mut dyn Read,
    encrypted: bool,
    key: Option<&ArchiveKey>,
) -> CloneResult<BTreeMap<String, Vec<u8>>> {
    let mut files = BTreeMap::new();
    while let Some(name_len) = read_u32_or_eof(r)? {
        if name_len == 0 || name_len > 255 {
            return Err(CloneError::ArchiveError(format!(
                "archive frame name length {name_len} is out of range"
            )));
        }
        let mut name_buf = vec![0u8; name_len as usize];
        r.read_exact(&mut name_buf)
            .map_err(|e| CloneError::ArchiveError(format!("read frame name: {e}")))?;
        let name = String::from_utf8(name_buf)
            .map_err(|_| CloneError::ArchiveError("frame name is not UTF-8".into()))?;
        let mut nonce = [0u8; 12];
        if encrypted {
            r.read_exact(&mut nonce)
                .map_err(|e| CloneError::ArchiveError(format!("read frame nonce: {e}")))?;
        }
        let mut len8 = [0u8; 8];
        r.read_exact(&mut len8)
            .map_err(|e| CloneError::ArchiveError(format!("read frame length: {e}")))?;
        let data_len = u64::from_le_bytes(len8);
        enforce_size_cap(MAX_ARCHIVE_SIZE, data_len)?;
        let mut sha = [0u8; 32];
        r.read_exact(&mut sha)
            .map_err(|e| CloneError::ArchiveError(format!("read frame checksum: {e}")))?;
        // 帧头 data_len 为明文字节长;加密时密文多出认证标签长。
        let payload_len = usize::try_from(if encrypted {
            data_len
                .checked_add(AEAD_TAG_LEN as u64)
                .ok_or_else(|| CloneError::ArchiveError("frame length overflow".into()))?
        } else {
            data_len
        })
        .map_err(|_| CloneError::ArchiveError("frame too large for this platform".into()))?;
        let mut payload = vec![0u8; payload_len];
        r.read_exact(&mut payload)
            .map_err(|e| CloneError::ArchiveError(format!("read frame `{name}`: {e}")))?;
        let mut aad = Vec::with_capacity(4 + name.len() + 8 + 32 + 12);
        aad.extend_from_slice(&(name.len() as u32).to_le_bytes());
        aad.extend_from_slice(name.as_bytes());
        if encrypted {
            aad.extend_from_slice(&nonce);
        }
        aad.extend_from_slice(&len8);
        aad.extend_from_slice(&sha);
        let plaintext = if encrypted {
            let Some(k) = key else {
                return Err(CloneError::ArchiveError(
                    "archive is encrypted; its key is required to open it".into(),
                ));
            };
            aead_open(k, &nonce, &payload, &aad)?
        } else {
            payload
        };
        if Sha256::digest(&plaintext).as_slice() != sha {
            return Err(CloneError::ArchiveError(format!(
                "sha256 mismatch in frame `{name}`; archive is corrupted"
            )));
        }
        if files.insert(name.clone(), plaintext).is_some() {
            return Err(CloneError::ArchiveError(format!(
                "duplicate archive frame `{name}`"
            )));
        }
    }
    Ok(files)
}

/// 帧边界读取 `u32`:干净 EOF 返回 None(帧序列自然结束),半头即截断错误。
pub(super) fn read_u32_or_eof(r: &mut dyn Read) -> CloneResult<Option<u32>> {
    let mut buf = [0u8; 4];
    let mut filled = 0;
    while filled < buf.len() {
        let n = r
            .read(&mut buf[filled..])
            .map_err(|e| CloneError::ArchiveError(format!("read archive: {e}")))?;
        if n == 0 {
            if filled == 0 {
                return Ok(None);
            }
            return Err(CloneError::ArchiveError(
                "truncated archive (partial frame header)".into(),
            ));
        }
        filled += n;
    }
    Ok(Some(u32::from_le_bytes(buf)))
}

pub(super) fn aead_seal(
    key: &ArchiveKey,
    nonce: &[u8; 12],
    plaintext: &[u8],
    aad: &[u8],
) -> CloneResult<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| CloneError::ArchiveError("archive key must be 32 bytes".into()))?;
    cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CloneError::ArchiveError("frame encryption failed".into()))
}

pub(super) fn aead_open(
    key: &ArchiveKey,
    nonce: &[u8; 12],
    ciphertext: &[u8],
    aad: &[u8],
) -> CloneResult<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| CloneError::ArchiveError("archive key must be 32 bytes".into()))?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| {
            CloneError::ArchiveError(
                "frame authentication failed (wrong key or corrupted archive)".into(),
            )
        })
}

/// 只读头部加密位(不解析帧)。读侧用它决定是否需要向密钥存储要钥匙:
/// 加密档无钥在 `Archive::open` 报错,提前探位可给「密钥缺失」更准的话术。
pub fn is_encrypted(path: &Path) -> CloneResult<bool> {
    let mut f =
        File::open(path).map_err(|e| CloneError::ArchiveError(format!("open archive: {e}")))?;
    let mut head = [0u8; HEADER_LEN];
    f.read_exact(&mut head)
        .map_err(|_| CloneError::ArchiveError("archive is smaller than its header".into()))?;
    if &head[0..MAGIC.len()] != MAGIC {
        return Err(CloneError::ArchiveError(
            "not a kode player clone archive (bad magic)".into(),
        ));
    }
    let version = head[MAGIC.len()];
    if version != FORMAT_VERSION {
        return Err(CloneError::ArchiveError(format!(
            "unsupported archive version {version} (expected {FORMAT_VERSION}); refusing to guess"
        )));
    }
    Ok(head[MAGIC.len() + 1] & FLAG_ENCRYPTED != 0)
}
