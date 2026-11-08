//! Resumable encrypted media. All filesystem paths are generated opaque IDs.
//! HTTP callers MUST also authorize membership in `channel_id` before any read.
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

pub mod scan;

pub const MAX_CHUNK: usize = 4 * 1024 * 1024;

#[cfg(target_os = "linux")]
mod withsecure;
#[cfg(target_os = "linux")]
pub use withsecure::WithSecureScanner;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("media not found or not owned by this user")]
    NotFound,
    #[error("invalid upload input")]
    Invalid,
    #[error("upload offset or state conflict")]
    Conflict,
    #[error("media is quarantined or incomplete")]
    Quarantined,
    #[error("encrypted media integrity check failed")]
    Integrity,
    #[error("storage unavailable")]
    Io(#[from] io::Error),
    #[error("invalid stored metadata")]
    Metadata(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Uploading,
    Quarantined,
    Ready,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Upload {
    pub id: Uuid,
    pub owner_id: String,
    pub channel_id: String,
    pub filename: String,
    /// Serialize byte lengths as decimal strings in JS-facing DTOs.
    pub length: u64,
    pub offset: u64,
    pub status: Status,
    #[serde(default)]
    pub scan: Option<scan::Report>,
    chunks: Vec<Chunk>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Chunk {
    offset: u64,
    length: u32,
    file: String,
}

pub trait Scanner: Send + Sync {
    /// Read the entire stream and return success only after a definitive clean result.
    fn scan(&self, source: &mut dyn Read) -> io::Result<()>;
    fn engine(&self) -> scan::Engine {
        scan::Engine::Unspecified
    }
}
pub struct RejectScanner;
impl Scanner for RejectScanner {
    fn scan(&self, _: &mut dyn Read) -> io::Result<()> {
        Err(scan::Failure::error(
            scan::Verdict::Unavailable,
            scan::Reason::ScannerNotConfigured,
        ))
    }
    fn engine(&self) -> scan::Engine {
        scan::Engine::Disabled
    }
}

pub struct Store {
    root: PathBuf,
    cipher: Aes256Gcm,
    gate: Mutex<()>,
}
impl Store {
    pub fn new(root: impl AsRef<Path>, key: [u8; 32]) -> Result<Self> {
        fs::create_dir_all(root.as_ref())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.as_ref(), fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self {
            root: root.as_ref().to_owned(),
            cipher: Aes256Gcm::new_from_slice(&key).map_err(|_| Error::Invalid)?,
            gate: Mutex::new(()),
        })
    }
    pub fn create(
        &self,
        owner: &str,
        channel: &str,
        filename: &str,
        length: u64,
    ) -> Result<Upload> {
        if owner.is_empty()
            || channel.is_empty()
            || filename.is_empty()
            || filename.len() > 255
            || filename.chars().any(char::is_control)
            || filename.contains(['/', '\\'])
        {
            return Err(Error::Invalid);
        }
        let upload = Upload {
            id: Uuid::new_v4(),
            owner_id: owner.into(),
            channel_id: channel.into(),
            filename: filename.into(),
            length,
            offset: 0,
            status: Status::Uploading,
            scan: None,
            chunks: vec![],
        };
        fs::create_dir(self.dir(upload.id))?;
        self.save(&upload)?;
        Ok(upload)
    }
    pub fn inspect(&self, id: Uuid, owner: &str) -> Result<Upload> {
        let _guard = self.gate.lock().map_err(|_| Error::Conflict)?;
        self.owned(id, owner)
    }
    /// Internal metadata for membership authorization. Never expose before access checks.
    pub fn metadata(&self, id: Uuid) -> Result<Upload> {
        let _guard = self.gate.lock().map_err(|_| Error::Conflict)?;
        self.load(id)
    }
    pub fn append(
        &self,
        id: Uuid,
        owner: &str,
        expected_offset: u64,
        bytes: &[u8],
    ) -> Result<Upload> {
        if bytes.is_empty() || bytes.len() > MAX_CHUNK {
            return Err(Error::Invalid);
        }
        let _guard = self.gate.lock().map_err(|_| Error::Conflict)?;
        let mut meta = self.owned(id, owner)?;
        if meta.status != Status::Uploading || expected_offset != meta.offset {
            return Err(Error::Conflict);
        }
        let end = meta
            .offset
            .checked_add(bytes.len() as u64)
            .ok_or(Error::Invalid)?;
        if end > meta.length {
            return Err(Error::Invalid);
        }
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let aad = aad(id, meta.offset, bytes.len() as u32);
        let ciphertext = self
            .cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: bytes,
                    aad: &aad,
                },
            )
            .map_err(|_| Error::Integrity)?;
        let name = format!("{}.chunk", Uuid::new_v4());
        let path = self.dir(id).join(&name);
        let mut file = private_file(&path)?;
        file.write_all(&nonce)?;
        file.write_all(&ciphertext)?;
        file.sync_all()?;
        meta.chunks.push(Chunk {
            offset: meta.offset,
            length: bytes.len() as u32,
            file: name,
        });
        meta.offset = end;
        if let Err(err) = self.save(&meta) {
            let _ = fs::remove_file(path);
            return Err(err);
        }
        Ok(meta)
    }
    pub fn finalize(&self, id: Uuid, owner: &str, scanner: &dyn Scanner) -> Result<Upload> {
        let meta = {
            let _guard = self.gate.lock().map_err(|_| Error::Conflict)?;
            let mut meta = self.owned(id, owner)?;
            if meta.offset != meta.length || meta.status == Status::Ready {
                return Err(Error::Conflict);
            }
            // Quarantine before the external scan. No append is possible while quarantined.
            meta.status = Status::Quarantined;
            meta.scan = Some(scan::Report::pending(scanner.engine()));
            self.save(&meta)?;
            meta
        };
        // Do not hold the store-wide lock across scanner I/O. Deletion must cancel availability
        // immediately, and unrelated encrypted uploads must continue during a long scan.
        let mut reader = self.reader(meta.clone(), 0, meta.length)?;
        let mut observed = ScanInput {
            reader: &mut reader,
            failed: false,
        };
        let mut result = scanner.scan(&mut observed);
        if observed.failed {
            result = Err(scan::Failure::error(
                scan::Verdict::Incomplete,
                scan::Reason::SourceReadFailed,
            ));
        }
        let mut report = meta.scan.clone().ok_or(Error::Integrity)?;
        let released = report.finish(result, meta.length - reader.remaining, meta.length);
        let _guard = self.gate.lock().map_err(|_| Error::Conflict)?;
        let mut current = self.owned(id, owner)?;
        if current.status != Status::Quarantined
            || current.offset != meta.offset
            || current.length != meta.length
            || current.scan.as_ref().map(|value| value.attempt_id) != Some(report.attempt_id)
        {
            return Err(Error::Conflict);
        }
        current.scan = Some(report);
        if released {
            current.status = Status::Ready;
        }
        self.save(&current)?;
        if released {
            Ok(current)
        } else {
            Err(Error::Quarantined)
        }
    }
    /// Trusted server-generated streams only. HTTP upload endpoints must never expose this operation.
    /// A generated stream starts with an unknown declared length (`u64::MAX`), then fixes its
    /// length to the actual authenticated chunk offset before the normal fail-closed scan.
    pub fn finish_generated(&self, id: Uuid, owner: &str, scanner: &dyn Scanner) -> Result<Upload> {
        {
            let _guard = self.gate.lock().map_err(|_| Error::Conflict)?;
            let mut meta = self.owned(id, owner)?;
            if meta.status != Status::Uploading || meta.length != u64::MAX || meta.offset == 0 {
                return Err(Error::Conflict);
            }
            meta.length = meta.offset;
            self.save(&meta)?;
        }
        self.finalize(id, owner, scanner)
    }

    /// The caller must first authorize membership using metadata.channel_id.
    pub fn read_range(&self, id: Uuid, start: u64, end_exclusive: u64) -> Result<MediaReader> {
        let _guard = self.gate.lock().map_err(|_| Error::Conflict)?;
        let meta = self.load(id)?;
        if meta.status != Status::Ready {
            return Err(Error::Quarantined);
        }
        self.reader(meta, start, end_exclusive)
    }
    pub fn delete(&self, id: Uuid, owner: &str) -> Result<()> {
        let _guard = self.gate.lock().map_err(|_| Error::Conflict)?;
        self.owned(id, owner)?;
        fs::remove_dir_all(self.dir(id))?;
        Ok(())
    }
    fn reader(&self, meta: Upload, start: u64, end: u64) -> Result<MediaReader> {
        if start > end || end > meta.length {
            return Err(Error::Invalid);
        }
        let index = meta
            .chunks
            .partition_point(|c| c.offset + u64::from(c.length) <= start);
        let skip = meta
            .chunks
            .get(index)
            .map_or(0, |c| (start - c.offset) as usize);
        Ok(MediaReader {
            root: self.dir(meta.id),
            cipher: self.cipher.clone(),
            id: meta.id,
            chunks: meta.chunks,
            index,
            skip,
            current: io::Cursor::new(vec![]),
            remaining: end - start,
        })
    }
    fn dir(&self, id: Uuid) -> PathBuf {
        self.root.join(id.to_string())
    }
    fn owned(&self, id: Uuid, owner: &str) -> Result<Upload> {
        let m = self.load(id)?;
        if m.owner_id != owner {
            Err(Error::NotFound)
        } else {
            Ok(m)
        }
    }
    fn load(&self, id: Uuid) -> Result<Upload> {
        let f = File::open(self.dir(id).join("meta.json")).map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                Error::NotFound
            } else {
                Error::Io(e)
            }
        })?;
        let m: Upload = serde_json::from_reader(f)?;
        if m.id != id || m.offset > m.length {
            return Err(Error::Integrity);
        }
        let mut offset = 0;
        for c in &m.chunks {
            if c.offset != offset
                || c.length == 0
                || c.length as usize > MAX_CHUNK
                || !valid_chunk_name(&c.file)
            {
                return Err(Error::Integrity);
            }
            offset = offset
                .checked_add(u64::from(c.length))
                .ok_or(Error::Integrity)?;
        }
        if offset != m.offset {
            return Err(Error::Integrity);
        }
        Ok(m)
    }
    fn save(&self, m: &Upload) -> Result<()> {
        let temp = self.dir(m.id).join(format!("{}.tmp", Uuid::new_v4()));
        let mut f = io::BufWriter::new(private_file(&temp)?);
        serde_json::to_writer(&mut f, m)?;
        f.flush()?;
        f.get_ref().sync_all()?;
        fs::rename(&temp, self.dir(m.id).join("meta.json"))?;
        File::open(self.dir(m.id))?.sync_all()?;
        Ok(())
    }
}
fn valid_chunk_name(name: &str) -> bool {
    name.strip_suffix(".chunk")
        .and_then(|s| Uuid::parse_str(s).ok())
        .is_some()
        && !name.contains(['/', '\\'])
}
fn private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}
fn aad(id: Uuid, offset: u64, length: u32) -> Vec<u8> {
    let mut a = b"chriscord-media-v1".to_vec();
    a.extend(id.as_bytes());
    a.extend(offset.to_be_bytes());
    a.extend(length.to_be_bytes());
    a
}

/// Reads at most one decrypted chunk into memory; whole-file RAM usage is bounded.
pub struct MediaReader {
    root: PathBuf,
    cipher: Aes256Gcm,
    id: Uuid,
    chunks: Vec<Chunk>,
    index: usize,
    skip: usize,
    current: io::Cursor<Vec<u8>>,
    remaining: u64,
}
struct ScanInput<'a> {
    reader: &'a mut MediaReader,
    failed: bool,
}
impl Read for ScanInput<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let result = self.reader.read(out);
        if result
            .as_ref()
            .is_err_and(|error| error.kind() != io::ErrorKind::Interrupted)
        {
            self.failed = true;
        }
        result
    }
}
impl Read for MediaReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 || out.is_empty() {
            return Ok(0);
        }
        if self.current.position() as usize == self.current.get_ref().len() {
            let c = self
                .chunks
                .get(self.index)
                .ok_or_else(|| io::Error::other("truncated encrypted media"))?;
            let mut data = vec![];
            File::open(self.root.join(&c.file))?
                .take(MAX_CHUNK as u64 + 29)
                .read_to_end(&mut data)?;
            if data.len() != c.length as usize + 28 {
                return Err(io::Error::other("invalid encrypted chunk length"));
            }
            let plain = self
                .cipher
                .decrypt(
                    Nonce::from_slice(&data[..12]),
                    Payload {
                        msg: &data[12..],
                        aad: &aad(self.id, c.offset, c.length),
                    },
                )
                .map_err(|_| io::Error::other("media authentication failed"))?;
            self.current = io::Cursor::new(plain);
            self.current.set_position(self.skip as u64);
            self.skip = 0;
            self.index += 1;
        }
        let count = out
            .len()
            .min(self.remaining.try_into().unwrap_or(usize::MAX));
        let n = self.current.read(&mut out[..count])?;
        self.remaining -= n as u64;
        Ok(n)
    }
}

/// Strict single HTTP byte range. Multi-ranges deliberately rejected to bound amplification.
pub fn parse_range(header: &str, length: u64) -> Result<(u64, u64)> {
    let value = header.strip_prefix("bytes=").ok_or(Error::Invalid)?;
    let (left, right) = value.split_once('-').ok_or(Error::Invalid)?;
    if length == 0
        || !left.bytes().all(|b| b.is_ascii_digit())
        || !right.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Error::Invalid);
    }
    if left.is_empty() {
        let suffix: u64 = right.parse().map_err(|_| Error::Invalid)?;
        if suffix == 0 {
            return Err(Error::Invalid);
        }
        Ok((length.saturating_sub(suffix), length))
    } else {
        let start: u64 = left.parse().map_err(|_| Error::Invalid)?;
        let end = if right.is_empty() {
            length
        } else {
            right
                .parse::<u64>()
                .map_err(|_| Error::Invalid)?
                .saturating_add(1)
                .min(length)
        };
        if start >= end || start >= length {
            return Err(Error::Invalid);
        }
        Ok((start, end))
    }
}

/// ClamAV INSTREAM client. Timeouts/errors/size-limit replies always remain quarantined.
#[cfg(unix)]
pub struct ClamdScanner {
    pub socket: PathBuf,
    pub timeout: std::time::Duration,
}
#[cfg(unix)]
impl Scanner for ClamdScanner {
    fn scan(&self, source: &mut dyn Read) -> io::Result<()> {
        use std::os::unix::net::UnixStream;
        let mut socket = UnixStream::connect(&self.socket)?;
        socket.set_read_timeout(Some(self.timeout))?;
        socket.set_write_timeout(Some(self.timeout))?;
        socket.write_all(b"zINSTREAM\0")?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = source.read(&mut buf)?;
            if n == 0 {
                break;
            }
            socket.write_all(&(n as u32).to_be_bytes())?;
            socket.write_all(&buf[..n])?;
        }
        socket.write_all(&0u32.to_be_bytes())?;
        let mut response = vec![];
        socket.take(4096).read_to_end(&mut response)?;
        scan::clamd_reply(&response)
    }
    fn engine(&self) -> scan::Engine {
        scan::Engine::Clamav
    }
}
