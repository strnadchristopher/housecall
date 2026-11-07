use chriscord_media::*;
use proptest::prelude::*;
use std::{
    fs,
    io::{self, Read},
};
struct Clean;
impl Scanner for Clean {
    fn scan(&self, source: &mut dyn Read) -> io::Result<()> {
        io::copy(source, &mut io::sink())?;
        Ok(())
    }
}
struct Liar;
impl Scanner for Liar {
    fn scan(&self, _: &mut dyn Read) -> io::Result<()> {
        Ok(())
    }
}
#[test]
fn resume_encryption_ranges_and_access() {
    let tmp = tempfile::tempdir().unwrap();
    let key = [77; 32];
    let store = Store::new(tmp.path(), key).unwrap();
    let u = store.create("alice", "private", "test.txt", 11).unwrap();
    assert!(matches!(store.inspect(u.id, "bob"), Err(Error::NotFound)));
    assert!(matches!(
        store.append(u.id, "bob", 0, b"stolen"),
        Err(Error::NotFound)
    ));
    store.append(u.id, "alice", 0, b"hello ").unwrap();
    assert!(matches!(
        store.append(u.id, "alice", 0, b"hello "),
        Err(Error::Conflict)
    ));
    assert!(matches!(
        store.finalize(u.id, "alice", &Clean),
        Err(Error::Conflict)
    ));
    drop(store);
    let store = Store::new(tmp.path(), key).unwrap();
    assert_eq!(store.inspect(u.id, "alice").unwrap().offset, 6);
    store.append(u.id, "alice", 6, b"world").unwrap();
    assert!(matches!(
        store.read_range(u.id, 0, 11),
        Err(Error::Quarantined)
    ));
    assert!(matches!(
        store.finalize(u.id, "alice", &RejectScanner),
        Err(Error::Quarantined)
    ));
    assert!(matches!(
        store.finalize(u.id, "alice", &Liar),
        Err(Error::Quarantined)
    ));
    store.finalize(u.id, "alice", &Clean).unwrap();
    let mut bytes = vec![];
    store
        .read_range(u.id, 3, 9)
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, b"lo wor");
    for e in fs::read_dir(tmp.path().join(u.id.to_string())).unwrap() {
        let p = e.unwrap().path();
        if p.extension().unwrap() == "chunk" {
            let encrypted = fs::read(p).unwrap();
            assert!(!encrypted.windows(5).any(|w| w == b"hello" || w == b"world"));
        }
    }
    let wrong = Store::new(tmp.path(), [78; 32]).unwrap();
    assert!(
        wrong
            .read_range(u.id, 0, 11)
            .unwrap()
            .read_to_end(&mut vec![])
            .is_err()
    );
    store.delete(u.id, "alice").unwrap();
    assert!(matches!(store.metadata(u.id), Err(Error::NotFound)));
}
#[test]
fn malformed_and_overflow_uploads_fail_closed() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::new(tmp.path(), [3; 32]).unwrap();
    assert!(s.create("a", "c", "../escape", 1).is_err());
    let u = s.create("a", "c", "large.bin", u64::MAX).unwrap();
    assert_eq!(u.length, u64::MAX); // No artificial total-size cap or JS-number narrowing.
    assert!(s.append(u.id, "a", u64::MAX, b"x").is_err());
    assert!(s.append(u.id, "a", 0, &vec![0; MAX_CHUNK + 1]).is_err());
    let mut meta: serde_json::Value = serde_json::from_slice(
        &fs::read(tmp.path().join(u.id.to_string()).join("meta.json")).unwrap(),
    )
    .unwrap();
    meta["chunks"] = serde_json::json!([{"offset":0,"length":1,"file":"../../escape.chunk"}]);
    meta["offset"] = 1.into();
    fs::write(
        tmp.path().join(u.id.to_string()).join("meta.json"),
        serde_json::to_vec(&meta).unwrap(),
    )
    .unwrap();
    assert!(matches!(s.metadata(u.id), Err(Error::Integrity)));
}
#[test]
fn ciphertext_tamper_is_detected_before_output() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::new(tmp.path(), [6; 32]).unwrap();
    let u = s.create("a", "c", "x", 3).unwrap();
    s.append(u.id, "a", 0, b"abc").unwrap();
    s.finalize(u.id, "a", &Clean).unwrap();
    let p = fs::read_dir(tmp.path().join(u.id.to_string()))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().unwrap() == "chunk")
        .unwrap();
    let mut bytes = fs::read(&p).unwrap();
    bytes[15] ^= 1;
    fs::write(p, bytes).unwrap();
    let mut out = vec![];
    assert!(
        s.read_range(u.id, 0, 3)
            .unwrap()
            .read_to_end(&mut out)
            .is_err()
    );
    assert!(out.is_empty());
}
#[test]
fn zero_length_and_range_edge_cases() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::new(tmp.path(), [6; 32]).unwrap();
    let u = s.create("a", "c", "empty", 0).unwrap();
    s.finalize(u.id, "a", &Clean).unwrap();
    assert_eq!(
        s.read_range(u.id, 0, 0).unwrap().read(&mut [0; 1]).unwrap(),
        0
    );
    assert_eq!(parse_range("bytes=3-5", 10).unwrap(), (3, 6));
    assert_eq!(parse_range("bytes=-3", 10).unwrap(), (7, 10));
    assert_eq!(parse_range("bytes=5-", 10).unwrap(), (5, 10));
    assert_eq!(
        parse_range("bytes=0-18446744073709551615", 10).unwrap(),
        (0, 10)
    );
    for h in [
        "bytes=-0",
        "bytes=0-1,3-4",
        "bytes= 1-2",
        "bytes=9-8",
        "bytes=10-",
        "bytes=+1-2",
        "bytes=18446744073709551616-",
    ] {
        assert!(parse_range(h, 10).is_err(), "{h}");
    }
}
proptest! {
 #[test] fn range_parser_never_panics_and_success_is_bounded(header in ".{0,150}", length in any::<u64>()) {
   if let Ok((start,end))=parse_range(&header,length) { prop_assert!(start<end);prop_assert!(end<=length); }
 }
 #[test] fn arbitrary_bytes_roundtrip(data in prop::collection::vec(any::<u8>(),1..8192), cut in 1usize..8192) {
   let tmp=tempfile::tempdir().unwrap();let s=Store::new(tmp.path(),[31;32]).unwrap(); let u=s.create("a","c","test",data.len() as u64).unwrap();
   let cut=cut.min(data.len()); s.append(u.id,"a",0,&data[..cut]).unwrap();if cut<data.len(){s.append(u.id,"a",cut as u64,&data[cut..]).unwrap();} s.finalize(u.id,"a",&Clean).unwrap();
   let mut out=vec![];s.read_range(u.id,0,data.len() as u64).unwrap().read_to_end(&mut out).unwrap(); prop_assert_eq!(out,data);
 }
}
#[test]
#[ignore = "explicit large fixture: writes and reads >2 GiB, run separately"]
fn multi_gib_interrupted_upload() {
    let tmp = tempfile::Builder::new()
        .prefix("media-large-")
        .tempdir_in(concat!(env!("CARGO_MANIFEST_DIR"), "/target"))
        .unwrap();
    let key = [9; 32];
    let length = 2u64 * 1024 * 1024 * 1024 + 123;
    let mut s = Store::new(tmp.path(), key).unwrap();
    let u = s.create("a", "c", "multi-gib.bin", length).unwrap();
    let chunk = vec![0x5a; MAX_CHUNK];
    let mut offset = 0;
    while offset < length {
        let n = (length - offset).min(MAX_CHUNK as u64) as usize;
        s.append(u.id, "a", offset, &chunk[..n]).unwrap();
        offset += n as u64;
        if offset == 1024 * 1024 * 1024 {
            drop(s);
            s = Store::new(tmp.path(), key).unwrap();
            assert_eq!(s.inspect(u.id, "a").unwrap().offset, offset);
        }
    }
    s.finalize(u.id, "a", &Clean).unwrap();
    let mut r = s.read_range(u.id, length - 123, length).unwrap();
    let mut out = vec![];
    r.read_to_end(&mut out).unwrap();
    assert_eq!(out, vec![0x5a; 123]);
    println!(
        "verified bytes={length}; interrupted/reopened at=1073741824; encrypted chunk size max={MAX_CHUNK}; scanner=fixture drain (not malware scanning)"
    );
}

#[cfg(unix)]
#[test]
fn clamd_protocol_accepts_only_definitive_clean_response() {
    use std::{io::Write, os::unix::net::UnixListener, time::Duration};
    for (reply, clean) in [
        (b"stream: OK\0".as_slice(), true),
        (b"stream: Eicar-Test-Signature FOUND\0", false),
        (b"INSTREAM size limit exceeded. ERROR\0", false),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let socket = tmp.path().join("clamd.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let reply = reply.to_vec();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut command = [0; 10];
            stream.read_exact(&mut command).unwrap();
            assert_eq!(&command, b"zINSTREAM\0");
            let mut total = vec![];
            loop {
                let mut size = [0; 4];
                stream.read_exact(&mut size).unwrap();
                let n = u32::from_be_bytes(size) as usize;
                if n == 0 {
                    break;
                }
                let mut buf = vec![0; n];
                stream.read_exact(&mut buf).unwrap();
                total.extend(buf);
            }
            assert_eq!(total, b"fixture media bytes");
            stream.write_all(&reply).unwrap();
        });
        let scanner = ClamdScanner {
            socket,
            timeout: Duration::from_secs(2),
        };
        assert_eq!(
            scanner.scan(&mut b"fixture media bytes".as_slice()).is_ok(),
            clean
        );
        worker.join().unwrap();
    }
}

#[cfg(unix)]
#[test]
#[ignore = "requires isolated live clamd fixture via CHRISCORD_TEST_CLAMD_SOCKET"]
fn live_clamd_releases_clean_and_quarantines_eicar() {
    let socket = std::env::var("CHRISCORD_TEST_CLAMD_SOCKET").expect("set isolated scanner socket");
    let scanner = ClamdScanner {
        socket: socket.into(),
        timeout: std::time::Duration::from_secs(30),
    };
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::new(tmp.path(), [45; 32]).unwrap();
    let clean = b"Chriscord clean scanner fixture.";
    let upload = store
        .create("fixture", "channel", "clean.txt", clean.len() as u64)
        .unwrap();
    store.append(upload.id, "fixture", 0, clean).unwrap();
    assert_eq!(
        store
            .finalize(upload.id, "fixture", &scanner)
            .unwrap()
            .status,
        Status::Ready
    );
    let eicar = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    let upload = store
        .create(
            "fixture",
            "channel",
            "antivirus-test.txt",
            eicar.len() as u64,
        )
        .unwrap();
    store.append(upload.id, "fixture", 0, eicar).unwrap();
    assert!(matches!(
        store.finalize(upload.id, "fixture", &scanner),
        Err(Error::Quarantined)
    ));
    assert!(matches!(
        store.read_range(upload.id, 0, eicar.len() as u64),
        Err(Error::Quarantined)
    ));
    println!(
        "Live ClamAV: clean encrypted upload released; EICAR test string remains quarantined and unreadable."
    );
}
