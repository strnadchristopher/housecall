//! Sparse seek lookup for our scanned FFmpeg fragmented MP4 outputs. No plaintext
//! file, whole-object download, or whole-index allocation is needed to seek.
use crate::{bad, ApiError};
use axum::http::StatusCode;
use chriscord_media::{Store, Upload};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read},
    sync::Arc,
};

const BOX_LIMIT: usize = 1024 * 1024;
const WINDOW: u32 = 8;

#[derive(Default, Deserialize)]
pub(crate) struct Query {
    #[serde(default)]
    pub time: f64,
    pub fragment: Option<u32>,
}
#[derive(Debug, Serialize)]
pub(crate) struct Window {
    pub duration: f64,
    /// Decimal byte offsets retain precision for disk-sized objects in JavaScript.
    pub init_end: String,
    pub fragments: Vec<Fragment>,
    pub next: Option<u32>,
}
#[derive(Debug, Serialize)]
pub(crate) struct Fragment {
    pub index: u32,
    pub start: f64,
    pub offset: String,
    pub end: String,
}
pub(crate) async fn lookup(
    store: Arc<Store>,
    meta: Upload,
    query: Query,
) -> Result<Window, ApiError> {
    if !query.time.is_finite() || query.time < 0.0 {
        return Err(bad("seek time must be finite and nonnegative"));
    }
    tokio::task::spawn_blocking(move || {
        // Nearby index entries share one read/decryption. Keep only four small
        // windows, independent of video size and number of fragments.
        let mut cache: std::collections::VecDeque<(u64, Vec<u8>)> = Default::default();
        index(meta.length, query, |start, length| {
            let end = start.checked_add(length as u64).ok_or_else(invalid)?;
            if end > meta.length || length > BOX_LIMIT {
                return Err(invalid());
            }
            let mut bytes = Vec::with_capacity(length);
            let mut cursor = start;
            while cursor < end {
                let base = cursor / 65536 * 65536;
                if !cache.iter().any(|(at, _)| *at == base) {
                    let stop = base.saturating_add(65536).min(meta.length);
                    let mut reader = store
                        .read_range(meta.id, base, stop)
                        .map_err(io::Error::other)?;
                    let mut block = vec![0; (stop - base) as usize];
                    reader.read_exact(&mut block)?;
                    if cache.len() == 4 {
                        cache.pop_front();
                    }
                    cache.push_back((base, block));
                }
                let block = &cache
                    .iter()
                    .find(|(at, _)| *at == base)
                    .ok_or_else(invalid)?
                    .1;
                let offset = (cursor - base) as usize;
                let count = (block.len() - offset).min((end - cursor) as usize);
                bytes.extend_from_slice(&block[offset..offset + count]);
                cursor += count as u64;
            }
            Ok(bytes)
        })
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "media seek task failed"))?
    .map_err(|_| {
        ApiError(
            StatusCode::CONFLICT,
            "media seek index unavailable; prepare this track again",
        )
    })
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid fragmented MP4 index")
}
fn u32_at(b: &[u8], at: usize) -> io::Result<u32> {
    Ok(u32::from_be_bytes(
        b.get(at..at + 4)
            .ok_or_else(invalid)?
            .try_into()
            .map_err(|_| invalid())?,
    ))
}
fn u64_at(b: &[u8], at: usize) -> io::Result<u64> {
    Ok(u64::from_be_bytes(
        b.get(at..at + 8)
            .ok_or_else(invalid)?
            .try_into()
            .map_err(|_| invalid())?,
    ))
}
fn boxes(mut bytes: &[u8]) -> io::Result<Vec<([u8; 4], &[u8])>> {
    let mut result = Vec::new();
    while !bytes.is_empty() {
        let size = u32_at(bytes, 0)? as usize;
        if size < 8 || size > bytes.len() {
            return Err(invalid());
        }
        let kind = bytes
            .get(4..8)
            .ok_or_else(invalid)?
            .try_into()
            .map_err(|_| invalid())?;
        result.push((kind, &bytes[8..size]));
        bytes = &bytes[size..];
    }
    Ok(result)
}
fn child<'a>(bytes: &'a [u8], kind: &[u8; 4]) -> io::Result<&'a [u8]> {
    boxes(bytes)?
        .into_iter()
        .find(|(k, _)| k == kind)
        .map(|(_, b)| b)
        .ok_or_else(invalid)
}
#[derive(Clone, Copy)]
struct Track {
    id: u32,
    scale: u32,
    default_duration: u32,
    video: bool,
}
fn tracks(moov: &[u8]) -> io::Result<Vec<Track>> {
    let defaults = child(moov, b"mvex")?;
    let mut tracks = Vec::new();
    for (_, trak) in boxes(moov)?.into_iter().filter(|(k, _)| k == b"trak") {
        let tkhd = child(trak, b"tkhd")?;
        let id = u32_at(tkhd, if tkhd.first() == Some(&1) { 20 } else { 12 })?;
        let mdia = child(trak, b"mdia")?;
        let mdhd = child(mdia, b"mdhd")?;
        let scale = u32_at(mdhd, if mdhd.first() == Some(&1) { 20 } else { 12 })?;
        let handler = child(mdia, b"hdlr")?.get(8..12).ok_or_else(invalid)?;
        if scale == 0 || (handler != b"vide" && handler != b"soun") {
            continue;
        }
        let mut default_duration = 0;
        for (kind, trex) in boxes(defaults)? {
            if kind == *b"trex" && u32_at(trex, 4)? == id {
                default_duration = u32_at(trex, 12)?;
            }
        }
        tracks.push(Track {
            id,
            scale,
            default_duration,
            video: handler == b"vide",
        });
    }
    Ok(tracks)
}
struct Table {
    at: u64,
    count: u32,
    width: usize,
    version: u8,
}
fn entry(
    read: &mut impl FnMut(u64, usize) -> io::Result<Vec<u8>>,
    table: &Table,
    n: u32,
) -> io::Result<(u64, u64)> {
    if n >= table.count {
        return Err(invalid());
    }
    let bytes = read(table.at + u64::from(n) * table.width as u64, table.width)?;
    let (time, offset, tail) = if table.version == 1 {
        (u64_at(&bytes, 0)?, u64_at(&bytes, 8)?, 16)
    } else {
        (
            u64::from(u32_at(&bytes, 0)?),
            u64::from(u32_at(&bytes, 4)?),
            8,
        )
    };
    // Fixed pipeline starts each fragment at a random-access sample. Reject
    // unsupported intra-fragment indexes instead of pretending they are seekable.
    if bytes[tail..] != [1, 1, 1] {
        return Err(invalid());
    }
    Ok((time, offset))
}
fn fragment_duration(bytes: &[u8], track: Track) -> io::Result<f64> {
    for (_, traf) in boxes(bytes)?
        .into_iter()
        .filter(|(kind, _)| kind == b"traf")
    {
        let tfhd = child(traf, b"tfhd")?;
        if u32_at(tfhd, 4)? != track.id {
            continue;
        }
        let flags = u32_at(tfhd, 0)? & 0x00ff_ffff;
        let mut at = 8 + if flags & 1 != 0 { 8 } else { 0 } + if flags & 2 != 0 { 4 } else { 0 };
        let default = if flags & 8 != 0 {
            u32_at(tfhd, at)?
        } else {
            track.default_duration
        };
        let tfdt = child(traf, b"tfdt")?;
        let mut decode = if tfdt.first() == Some(&1) {
            u64_at(tfdt, 4)?
        } else {
            u64::from(u32_at(tfdt, 4)?)
        };
        let mut end = decode as f64;
        let mut total_samples = 0u32;
        for (_, trun) in boxes(traf)?.into_iter().filter(|(kind, _)| kind == b"trun") {
            let flags = u32_at(trun, 0)? & 0x00ff_ffff;
            let samples = u32_at(trun, 4)?;
            // A zero-width malicious run must not turn a tiny box into unbounded CPU.
            total_samples = total_samples.checked_add(samples).ok_or_else(invalid)?;
            if total_samples > BOX_LIMIT as u32 {
                return Err(invalid());
            }
            at = 8 + if flags & 1 != 0 { 4 } else { 0 } + if flags & 4 != 0 { 4 } else { 0 };
            for _ in 0..samples {
                let duration = if flags & 0x100 != 0 {
                    let v = u32_at(trun, at)?;
                    at += 4;
                    v
                } else {
                    default
                };
                if duration == 0 {
                    return Err(invalid());
                }
                if flags & 0x200 != 0 {
                    at += 4;
                }
                if flags & 0x400 != 0 {
                    at += 4;
                }
                let composition = if flags & 0x800 != 0 {
                    let v = u32_at(trun, at)?;
                    at += 4;
                    if trun.first() == Some(&1) {
                        f64::from(v as i32)
                    } else {
                        f64::from(v)
                    }
                } else {
                    0.0
                };
                if at > trun.len() {
                    return Err(invalid());
                }
                decode = decode
                    .checked_add(u64::from(duration))
                    .ok_or_else(invalid)?;
                end = end.max(decode as f64 + composition);
            }
        }
        return Ok(end / f64::from(track.scale));
    }
    Err(invalid())
}
fn index(
    length: u64,
    query: Query,
    mut read: impl FnMut(u64, usize) -> io::Result<Vec<u8>>,
) -> io::Result<Window> {
    if length < 32 || !query.time.is_finite() || query.time < 0.0 {
        return Err(invalid());
    }
    let mut at = 0u64;
    let (init_end, tracks) = loop {
        let header = read(at, 8)?;
        let size = u64::from(u32_at(&header, 0)?);
        if size < 8 || at + size > length || at + size > BOX_LIMIT as u64 {
            return Err(invalid());
        }
        if &header[4..8] == b"moov" {
            let moov = read(at + 8, (size - 8) as usize)?;
            break (at + size, tracks(&moov)?);
        }
        at += size;
    };
    let track = *tracks
        .iter()
        .find(|t| t.video)
        .or_else(|| tracks.first())
        .ok_or_else(invalid)?;
    let tail = read(length - 16, 16)?;
    if u32_at(&tail, 0)? != 16 || &tail[4..8] != b"mfro" {
        return Err(invalid());
    }
    let index_size = u64::from(u32_at(&tail, 12)?);
    let media_end = length
        .checked_sub(index_size)
        .filter(|n| *n >= init_end && index_size >= 24)
        .ok_or_else(invalid)?;
    let header = read(media_end, 8)?;
    if &header[4..8] != b"mfra" || u64::from(u32_at(&header, 0)?) != index_size {
        return Err(invalid());
    }
    at = media_end + 8;
    let mut found = None;
    while at < length - 16 {
        let header = read(at, 24)?;
        let size = u64::from(u32_at(&header, 0)?);
        if size < 24 || at.checked_add(size).is_none_or(|n| n > length - 16) {
            return Err(invalid());
        }
        if &header[4..8] == b"tfra" && u32_at(&header, 12)? == track.id {
            let version = header[8];
            if version > 1 {
                return Err(invalid());
            }
            // FFmpeg writes one-byte traf/trun/sample numbers, each exactly1.
            if u32_at(&header, 16)? != 0 {
                return Err(invalid());
            }
            let width = if version == 1 { 19 } else { 11 };
            let count = u32_at(&header, 20)?;
            if count == 0 || 24 + u64::from(count) * width as u64 != size {
                return Err(invalid());
            }
            found = Some(Table {
                at: at + 24,
                count,
                width,
                version,
            });
            break;
        }
        at += size;
    }
    let table = found.ok_or_else(invalid)?;
    let (_, last_offset) = entry(&mut read, &table, table.count - 1)?;
    if last_offset < init_end || last_offset.checked_add(8).is_none_or(|n| n > media_end) {
        return Err(invalid());
    }
    let header = read(last_offset, 8)?;
    let size = u32_at(&header, 0)? as usize;
    if &header[4..8] != b"moof"
        || !(8..=BOX_LIMIT).contains(&size)
        || last_offset
            .checked_add(size as u64)
            .is_none_or(|n| n > media_end)
    {
        return Err(invalid());
    }
    let moof = read(last_offset + 8, size - 8)?;
    let mut duration = fragment_duration(&moof, track)?;
    for other in tracks.into_iter().filter(|other| other.id != track.id) {
        if let Ok(end) = fragment_duration(&moof, other) {
            duration = duration.max(end);
        }
    }
    let first = if let Some(n) = query.fragment {
        if n >= table.count {
            return Err(invalid());
        }
        n
    } else {
        let mut lo = 0;
        let mut hi = table.count;
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let (time, _) = entry(&mut read, &table, mid)?;
            if time as f64 / f64::from(track.scale) <= query.time {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo.saturating_sub(1)
    };
    let until = first.saturating_add(WINDOW).min(table.count);
    let mut fragments = Vec::new();
    for n in first..until {
        let (time, offset) = entry(&mut read, &table, n)?;
        let end = if n + 1 < table.count {
            entry(&mut read, &table, n + 1)?.1
        } else {
            media_end
        };
        if offset < init_end || end <= offset || end > media_end {
            return Err(invalid());
        }
        fragments.push(Fragment {
            index: n,
            start: time as f64 / f64::from(track.scale),
            offset: offset.to_string(),
            end: end.to_string(),
        });
    }
    Ok(Window {
        duration,
        init_end: init_end.to_string(),
        fragments,
        next: (until < table.count).then_some(until),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    fn atom(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend(kind);
        out.extend(payload);
        out
    }
    fn numbers(values: &[u32]) -> Vec<u8> {
        values.iter().flat_map(|n| n.to_be_bytes()).collect()
    }
    /// Sparse in-memory container fixture. Payload gaps need no allocation and
    /// prove offsets remain u64 beyond the JS exact-integer limit.
    fn fixture(count: u32, spacing: u64) -> (u64, BTreeMap<u64, Vec<u8>>) {
        let mut trak = atom(b"tkhd", &numbers(&[0, 0, 0, 1]));
        let mut mdia = atom(b"mdhd", &numbers(&[0, 0, 0, 1000]));
        let mut hdlr = numbers(&[0, 0]);
        hdlr.extend(b"vide");
        mdia.extend(atom(b"hdlr", &hdlr));
        trak.extend(atom(b"mdia", &mdia));
        let mut moov = atom(b"trak", &trak);
        moov.extend(atom(
            b"mvex",
            &atom(b"trex", &numbers(&[0, 1, 1, 2000, 0, 0])),
        ));
        let mut initial = atom(b"ftyp", b"isom");
        initial.extend(atom(b"moov", &moov));
        let init_end = initial.len() as u64;
        let mut chunks = BTreeMap::from([(0, initial)]);
        let mut tfra = numbers(&[1 << 24, 1, 0, count]);
        let mut media_end = init_end;
        for n in 0..count {
            let offset = init_end + u64::from(n) * spacing;
            let mut traf = atom(b"tfhd", &numbers(&[8, 1, 2000]));
            let mut tfdt = numbers(&[1 << 24]);
            tfdt.extend((u64::from(n) * 2000).to_be_bytes());
            traf.extend(atom(b"tfdt", &tfdt));
            traf.extend(atom(b"trun", &numbers(&[0, 1])));
            let moof = atom(b"moof", &atom(b"traf", &traf));
            media_end = offset + moof.len() as u64;
            chunks.insert(offset, moof);
            tfra.extend((u64::from(n) * 2000).to_be_bytes());
            tfra.extend(offset.to_be_bytes());
            tfra.extend([1, 1, 1]);
        }
        let table = atom(b"tfra", &tfra);
        let mut payload = table.clone();
        payload.extend(atom(b"mfro", &numbers(&[0, (8 + table.len() + 16) as u32])));
        let trailer = atom(b"mfra", &payload);
        let length = media_end + trailer.len() as u64;
        chunks.insert(media_end, trailer);
        (length, chunks)
    }
    fn lookup_fixture(
        length: u64,
        chunks: &BTreeMap<u64, Vec<u8>>,
        query: Query,
    ) -> io::Result<(Window, usize)> {
        let mut read_bytes = 0;
        let result = index(length, query, |start, size| {
            read_bytes += size;
            let (base, bytes) = chunks.range(..=start).next_back().ok_or_else(invalid)?;
            let offset = (start - base) as usize;
            Ok(bytes
                .get(offset..offset + size)
                .ok_or_else(invalid)?
                .to_vec())
        })?;
        Ok((result, read_bytes))
    }
    #[test]
    fn seeks_late_then_early_without_reading_payload_or_entire_index() {
        let (length, chunks) = fixture(10000, 128 * 1024 * 1024);
        let (late, read) = lookup_fixture(
            length,
            &chunks,
            Query {
                time: 19001.0,
                fragment: None,
            },
        )
        .unwrap();
        assert_eq!(late.duration, 20000.0);
        assert_eq!(late.fragments[0].index, 9500);
        assert_eq!(late.fragments.len(), WINDOW as usize);
        assert_eq!(late.next, Some(9508));
        assert!(read < 4096, "sparse query read {read} bytes");
        let (early, _) = lookup_fixture(length, &chunks, Query::default()).unwrap();
        assert_eq!(early.fragments[0].index, 0);
        let (last, _) = lookup_fixture(
            length,
            &chunks,
            Query {
                fragment: Some(9999),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(last.fragments.len(), 1);
        assert_eq!(last.next, None);
    }
    #[test]
    fn keeps_exact_large_offsets_and_rejects_missing_or_invalid_index() {
        let (length, mut chunks) = fixture(4, 1 << 53);
        let (window, _) = lookup_fixture(
            length,
            &chunks,
            Query {
                time: 6.0,
                fragment: None,
            },
        )
        .unwrap();
        assert!(window.fragments[0].offset.parse::<u64>().unwrap() > 1 << 53);
        assert!(lookup_fixture(
            length,
            &chunks,
            Query {
                time: f64::NAN,
                fragment: None
            }
        )
        .is_err());
        assert!(lookup_fixture(
            length,
            &chunks,
            Query {
                time: -1.0,
                fragment: None
            }
        )
        .is_err());
        assert!(lookup_fixture(
            length,
            &chunks,
            Query {
                fragment: Some(4),
                ..Default::default()
            }
        )
        .is_err());
        chunks.last_entry().unwrap().get_mut().truncate(12);
        assert!(lookup_fixture(length, &chunks, Query::default()).is_err());
    }
}
