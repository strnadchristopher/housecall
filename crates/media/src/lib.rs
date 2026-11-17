//! Resumable encrypted media. All filesystem paths are generated opaque IDs.
//! HTTP callers MUST also authorize membership in `channel_id` before any read.
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
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
    #[error("upload exceeds the configured file limit")]
    TooLarge,
    #[error("media admission capacity unavailable")]
    Capacity,
    #[error("too many incomplete uploads")]
    PendingLimit,
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
    #[serde(default)]
    generated: bool,
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

/// Logical byte reservations, including incomplete and quarantined uploads.
/// One Store must exclusively own its directory; this mutex is not a cross-process lock.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub total_bytes: u64,
    pub owner_bytes: u64,
    pub upload_bytes: u64,
    pub pending_per_owner: u64,
    pub uploads: u64,
}
impl Limits {
    /// Compatibility for library callers. Production servers must use finite limits.
    pub const UNLIMITED: Self = Self {
        total_bytes: u64::MAX,
        owner_bytes: u64::MAX,
        upload_bytes: u64::MAX,
        pending_per_owner: u64::MAX,
        uploads: u64::MAX,
    };
    pub fn validate(&self) -> Result<()> {
        if [
            self.total_bytes,
            self.owner_bytes,
            self.upload_bytes,
            self.pending_per_owner,
            self.uploads,
        ]
        .contains(&0)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}
#[derive(Default)]
struct OwnerUsage {
    files: u64,
    bytes: u128,
    pending: u64,
}
#[derive(Default)]
struct Accounting {
    // Legacy interrupted generators can each reserve u64::MAX. Their aggregate is
    // valid even above u64 limits; startup must reach recovery without truncation.
    bytes: u128,
    owners: HashMap<String, OwnerUsage>,
    // Retain the committed reservation independently of metadata after uncertain I/O errors.
    entries: HashMap<Uuid, (String, u64, bool)>,
    blocked: bool,
}
impl Accounting {
    fn add(&mut self, m: &Upload) -> Result<()> {
        let owner = self.owners.entry(m.owner_id.clone()).or_default();
        let bytes = self
            .bytes
            .checked_add(u128::from(m.length))
            .ok_or(Error::Integrity)?;
        let owner_bytes = owner
            .bytes
            .checked_add(u128::from(m.length))
            .ok_or(Error::Integrity)?;
        let owner_files = owner.files.checked_add(1).ok_or(Error::Integrity)?;
        let pending = m.status != Status::Ready;
        let owner_pending = owner
            .pending
            .checked_add(u64::from(pending))
            .ok_or(Error::Integrity)?;
        if self.entries.contains_key(&m.id) {
            return Err(Error::Integrity);
        }
        self.bytes = bytes;
        owner.files = owner_files;
        owner.bytes = owner_bytes;
        owner.pending = owner_pending;
        self.entries
            .insert(m.id, (m.owner_id.clone(), m.length, pending));
        Ok(())
    }
    fn admit(&self, m: &Upload, limits: Limits) -> Result<()> {
        if m.length > limits.upload_bytes {
            return Err(Error::TooLarge);
        }
        let owner = self.owners.get(&m.owner_id);
        if owner.map_or(0, |v| v.pending) >= limits.pending_per_owner {
            return Err(Error::PendingLimit);
        }
        if self.blocked
            || u64::try_from(self.entries.len()).map_err(|_| Error::Capacity)? >= limits.uploads
            || self
                .bytes
                .checked_add(u128::from(m.length))
                .is_none_or(|v| v > u128::from(limits.total_bytes))
            || owner
                .map_or(0, |v| v.bytes)
                .checked_add(u128::from(m.length))
                .is_none_or(|v| v > u128::from(limits.owner_bytes))
        {
            return Err(Error::Capacity);
        }
        Ok(())
    }
    fn remove(&mut self, id: Uuid) {
        if let Some((owner, bytes, pending)) = self.entries.remove(&id) {
            let usage = self.owners.get_mut(&owner).expect("accounted owner");
            self.bytes -= u128::from(bytes);
            usage.bytes -= u128::from(bytes);
            usage.pending -= u64::from(pending);
            usage.files -= 1;
            if usage.files == 0 {
                self.owners.remove(&owner);
            }
        }
    }
    fn committed(&mut self, m: &Upload) -> Result<()> {
        // Only shrink reservations or mark ready after a successful durable metadata save.
        self.remove(m.id);
        self.add(m)
    }
}

pub struct Store {
    root: PathBuf,
    cipher: Aes256Gcm,
    limits: Limits,
    gate: Mutex<Accounting>,
    #[cfg(test)]
    fail_next_save: std::sync::atomic::AtomicBool,
}
impl Store {
    pub fn new(root: impl AsRef<Path>, key: [u8; 32]) -> Result<Self> {
        Self::with_limits(root, key, Limits::UNLIMITED)
    }
    pub fn with_limits(root: impl AsRef<Path>, key: [u8; 32], limits: Limits) -> Result<Self> {
        limits.validate()?;
        fs::create_dir_all(root.as_ref())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.as_ref(), fs::Permissions::from_mode(0o700))?;
        }
        let store = Self {
            root: root.as_ref().to_owned(),
            cipher: Aes256Gcm::new_from_slice(&key).map_err(|_| Error::Invalid)?,
            limits,
            gate: Mutex::new(Accounting::default()),
            #[cfg(test)]
            fail_next_save: std::sync::atomic::AtomicBool::new(false),
        };
        // A single startup reconciliation. Unknown directories/malformed metadata must not
        // silently reset usage. Existing over-budget data remains readable and deletable.
        let mut accounting = Accounting::default();
        for entry in fs::read_dir(&store.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                return Err(Error::Integrity);
            }
            let name = entry.file_name();
            let name = name.to_str().ok_or(Error::Integrity)?;
            let id = Uuid::parse_str(name).map_err(|_| Error::Integrity)?;
            if name != id.to_string() {
                return Err(Error::Integrity);
            }
            accounting.add(&store.load(id)?)?;
        }
        *store.gate.lock().map_err(|_| Error::Conflict)? = accounting;
        Ok(store)
    }
    pub fn create(
        &self,
        owner: &str,
        channel: &str,
        filename: &str,
        length: u64,
    ) -> Result<Upload> {
        self.create_inner(owner, channel, filename, length, false)
    }
    /// Reserve a bounded maximum for a trusted generated stream; release unused bytes
    /// when its authenticated length is fixed. HTTP clients cannot select this mode.
    pub fn create_generated(
        &self,
        owner: &str,
        channel: &str,
        filename: &str,
        maximum: u64,
    ) -> Result<Upload> {
        self.create_inner(
            owner,
            channel,
            filename,
            maximum.min(self.limits.upload_bytes),
            true,
        )
    }
    fn create_inner(
        &self,
        owner: &str,
        channel: &str,
        filename: &str,
        length: u64,
        generated: bool,
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
            generated,
            chunks: vec![],
        };
        let mut accounting = self.gate.lock().map_err(|_| Error::Conflict)?;
        accounting.admit(&upload, self.limits)?;
        accounting.add(&upload)?;
        if let Err(error) = fs::create_dir(self.dir(upload.id)) {
            accounting.remove(upload.id);
            return Err(error.into());
        }
        if let Err(error) = self.save(&upload) {
            // A failed rename/fsync can leave uncertain durable state. Only reclaim after
            // actual removal; if cleanup fails, stop admission until operator reconciliation.
            if fs::remove_dir_all(self.dir(upload.id)).is_err() {
                accounting.blocked = true;
            } else {
                accounting.remove(upload.id);
            }
            return Err(error);
        }
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
        let mut accounting = self.gate.lock().map_err(|_| Error::Conflict)?;
        let mut meta = self.owned(id, owner)?;
        if meta.length > self.limits.upload_bytes {
            return Err(Error::TooLarge);
        }
        if accounting.blocked
            || accounting.bytes > u128::from(self.limits.total_bytes)
            || accounting
                .owners
                .get(owner)
                .is_some_and(|v| v.bytes > u128::from(self.limits.owner_bytes))
        {
            return Err(Error::Capacity);
        }
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
        let write = (|| -> Result<()> {
            file.write_all(&nonce)?;
            file.write_all(&ciphertext)?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(error) = write {
            drop(file);
            if fs::remove_file(&path).is_err() {
                accounting.blocked = true;
            }
            return Err(error);
        }
        drop(file);
        meta.chunks.push(Chunk {
            offset: meta.offset,
            length: bytes.len() as u32,
            file: name,
        });
        meta.offset = end;
        if let Err(err) = self.save(&meta) {
            accounting.blocked = true;
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
        let mut accounting = self.gate.lock().map_err(|_| Error::Conflict)?;
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
        accounting.committed(&current)?;
        if released {
            Ok(current)
        } else {
            Err(Error::Quarantined)
        }
    }
    /// Trusted server-generated streams only. HTTP upload endpoints must never expose this operation.
    /// A generated stream reserves its maximum up front, then fixes its length to the actual
    /// authenticated offset before the normal fail-closed scan. Legacy unlimited streams
    /// remain finishable by library callers.
    pub fn finish_generated(&self, id: Uuid, owner: &str, scanner: &dyn Scanner) -> Result<Upload> {
        {
            let mut accounting = self.gate.lock().map_err(|_| Error::Conflict)?;
            let mut meta = self.owned(id, owner)?;
            if meta.status != Status::Uploading
                || (!meta.generated && meta.length != u64::MAX)
                || meta.offset == 0
            {
                return Err(Error::Conflict);
            }
            meta.length = meta.offset;
            meta.generated = false;
            self.save(&meta)?;
            accounting.committed(&meta)?;
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
        let mut accounting = self.gate.lock().map_err(|_| Error::Conflict)?;
        self.owned(id, owner)?;
        fs::remove_dir_all(self.dir(id))?;
        accounting.remove(id);
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
        if m.id != id
            || m.owner_id.is_empty()
            || m.channel_id.is_empty()
            || m.offset > m.length
            || (m.status == Status::Ready && m.offset != m.length)
        {
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
        #[cfg(test)]
        if self
            .fail_next_save
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(Error::Io(io::Error::other(
                "injected metadata write failure",
            )));
        }
        let temp = self.dir(m.id).join(format!("{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut f = io::BufWriter::new(private_file(&temp)?);
            serde_json::to_writer(&mut f, m)?;
            f.flush()?;
            f.get_ref().sync_all()?;
            fs::rename(&temp, self.dir(m.id).join("meta.json"))?;
            File::open(self.dir(m.id))?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
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
    let mut a = b"housecall-media-v1".to_vec();
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

#[cfg(test)]
mod admission_failure_tests {
    use super::*;
    #[test]
    fn failed_create_metadata_write_rolls_back_and_restart_is_clean() {
        let dir = tempfile::tempdir().unwrap();
        let limits = Limits {
            total_bytes: 6,
            owner_bytes: 6,
            upload_bytes: 6,
            pending_per_owner: 1,
            uploads: 1,
        };
        let s = Store::with_limits(dir.path(), [8; 32], limits).unwrap();
        s.fail_next_save
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(s.create("a", "c", "file", 6), Err(Error::Io(_))));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        let m = s.create("a", "c", "file", 6).unwrap();
        drop(s);
        let s = Store::with_limits(dir.path(), [8; 32], limits).unwrap();
        assert!(s.create("b", "c", "file", 1).is_err());
        s.delete(m.id, "a").unwrap();
        s.create("b", "c", "file", 6).unwrap();
    }
}
