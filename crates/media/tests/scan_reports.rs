//! Synthetic scan outcomes; these tests do not establish real malware-engine coverage.
use chriscord_media::{
    Error, Scanner, Status, Store,
    scan::{Coverage, Engine, Failure, Reason, Verdict},
};
use std::{
    io::{self, Read},
    sync::{Arc, Barrier},
};
struct Outcome(Option<(Verdict, Reason)>);
impl Scanner for Outcome {
    fn scan(&self, source: &mut dyn Read) -> io::Result<()> {
        io::copy(source, &mut io::sink())?;
        match self.0 {
            None => Ok(()),
            Some((verdict, reason)) => Err(Failure::error(verdict, reason)),
        }
    }
    fn engine(&self) -> Engine {
        Engine::Unspecified
    }
}
fn uploaded(store: &Store) -> uuid::Uuid {
    let upload = store.create("owner", "room", "synthetic.bin", 3).unwrap();
    store.append(upload.id, "owner", 0, b"abc").unwrap();
    upload.id
}
#[test]
fn classified_outcomes_persist_without_changing_quarantine_or_range_gates() {
    for (verdict, reason, coverage) in [
        (
            Verdict::Detected,
            Reason::BlockingFinding,
            Coverage::Unknown,
        ),
        (
            Verdict::Incomplete,
            Reason::EngineLimit,
            Coverage::EngineLimited,
        ),
        (
            Verdict::Incomplete,
            Reason::EncryptedOrUnsupported,
            Coverage::EngineLimited,
        ),
        (
            Verdict::TimedOut,
            Reason::ScannerTimedOut,
            Coverage::Unknown,
        ),
        (
            Verdict::Rejected,
            Reason::UnclassifiedRejection,
            Coverage::Unknown,
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path(), [4; 32]).unwrap();
        let id = uploaded(&store);
        assert!(matches!(
            store.finalize(id, "owner", &Outcome(Some((verdict, reason)))),
            Err(Error::Quarantined)
        ));
        drop(store);
        let reopened = Store::new(dir.path(), [4; 32]).unwrap();
        let upload = reopened.inspect(id, "owner").unwrap();
        let scan = upload.scan.unwrap();
        assert_eq!(upload.status, Status::Quarantined);
        assert_eq!(scan.verdict, verdict);
        assert_eq!(scan.reason, reason);
        assert_eq!(scan.coverage, coverage);
        assert_eq!(scan.bytes_consumed, 3);
        assert!(scan.finished_at_ms.is_some());
        assert!(matches!(
            reopened.read_range(id, 0, 3),
            Err(Error::Quarantined)
        ));
        assert!(matches!(
            reopened.inspect(id, "other"),
            Err(Error::NotFound)
        ));
        let clean = reopened.finalize(id, "owner", &Outcome(None)).unwrap();
        assert_eq!(clean.status, Status::Ready);
        assert_eq!(clean.scan.unwrap().coverage, Coverage::StreamConsumed);
    }
}
#[test]
fn old_ready_metadata_is_not_given_an_invented_scan_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path(), [4; 32]).unwrap();
    let id = uploaded(&store);
    store.finalize(id, "owner", &Outcome(None)).unwrap();
    let path = dir.path().join(id.to_string()).join("meta.json");
    let mut meta: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    meta.as_object_mut().unwrap().remove("scan");
    std::fs::write(path, serde_json::to_vec(&meta).unwrap()).unwrap();
    let upload = store.inspect(id, "owner").unwrap();
    assert_eq!(upload.status, Status::Ready);
    assert!(upload.scan.is_none());
}
#[test]
fn stale_clean_attempt_cannot_overwrite_newer_detected_verdict() {
    struct Delayed {
        started: Arc<Barrier>,
        finish: Arc<Barrier>,
    }
    impl Scanner for Delayed {
        fn scan(&self, source: &mut dyn Read) -> io::Result<()> {
            io::copy(source, &mut io::sink())?;
            self.started.wait();
            self.finish.wait();
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::new(dir.path(), [4; 32]).unwrap());
    let id = uploaded(&store);
    let started = Arc::new(Barrier::new(2));
    let finish = Arc::new(Barrier::new(2));
    let worker = {
        let store = store.clone();
        let started = started.clone();
        let finish = finish.clone();
        std::thread::spawn(move || store.finalize(id, "owner", &Delayed { started, finish }))
    };
    started.wait();
    assert_eq!(
        store.inspect(id, "owner").unwrap().scan.unwrap().verdict,
        Verdict::Pending
    );
    assert!(matches!(
        store.finalize(
            id,
            "owner",
            &Outcome(Some((Verdict::Detected, Reason::BlockingFinding)))
        ),
        Err(Error::Quarantined)
    ));
    finish.wait();
    assert!(matches!(worker.join().unwrap(), Err(Error::Conflict)));
    let current = store.inspect(id, "owner").unwrap();
    assert_eq!(current.status, Status::Quarantined);
    assert_eq!(current.scan.unwrap().verdict, Verdict::Detected);
}
#[test]
fn source_read_failure_is_not_reported_as_a_scanner_outage() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path(), [4; 32]).unwrap();
    let id = uploaded(&store);
    let chunk = std::fs::read_dir(dir.path().join(id.to_string()))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "chunk"))
        .unwrap();
    std::fs::remove_file(chunk).unwrap();
    assert!(matches!(
        store.finalize(id, "owner", &Outcome(None)),
        Err(Error::Quarantined)
    ));
    assert_eq!(
        store.inspect(id, "owner").unwrap().scan.unwrap().reason,
        Reason::SourceReadFailed
    );
}
