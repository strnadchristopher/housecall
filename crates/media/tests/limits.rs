//! Tiny synthetic fixtures: no disk-filling or ignored multi-GiB tests.
use housecall_media::{Error, Limits, Scanner, Store};
use std::{
    io::{self, Read},
    sync::Arc,
};

fn limits() -> Limits {
    Limits {
        total_bytes: 12,
        owner_bytes: 8,
        upload_bytes: 6,
        pending_per_owner: 2,
        uploads: 4,
    }
}
struct Clean;
impl Scanner for Clean {
    fn scan(&self, input: &mut dyn Read) -> io::Result<()> {
        io::copy(input, &mut io::sink()).map(|_| ())
    }
}
#[test]
fn huge_lengths_owner_global_and_delete_reservations() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::with_limits(dir.path(), [1; 32], limits()).unwrap();
    assert!(matches!(
        s.create("a", "c", "huge", u64::MAX),
        Err(Error::TooLarge)
    ));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    let a = s.create("a", "c", "one", 6).unwrap();
    assert!(matches!(s.create("a", "c", "two", 3), Err(Error::Capacity)));
    let b = s.create("b", "c", "two", 6).unwrap();
    assert!(matches!(
        s.create("c", "c", "three", 1),
        Err(Error::Capacity)
    ));
    s.delete(a.id, "a").unwrap();
    s.create("a", "c", "replacement", 6).unwrap();
    s.delete(b.id, "b").unwrap();
}
#[test]
fn unfinished_count_and_ready_quarantine_accounting_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::with_limits(dir.path(), [1; 32], limits()).unwrap();
    let a = s.create("a", "c", "one", 2).unwrap();
    s.append(a.id, "a", 0, b"ok").unwrap();
    s.finalize(a.id, "a", &Clean).unwrap();
    let b = s.create("a", "c", "two", 2).unwrap();
    s.append(b.id, "a", 0, b"no").unwrap();
    assert!(
        s.finalize(b.id, "a", &housecall_media::RejectScanner)
            .is_err()
    );
    s.create("a", "c", "three", 0).unwrap();
    assert!(matches!(
        s.create("a", "c", "four", 0),
        Err(Error::PendingLimit)
    ));
    drop(s);
    let s = Store::with_limits(dir.path(), [1; 32], limits()).unwrap();
    assert!(matches!(
        s.create("a", "c", "four", 0),
        Err(Error::PendingLimit)
    ));
    let mut bytes = vec![];
    s.read_range(a.id, 0, 2)
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, b"ok");
    s.delete(b.id, "a").unwrap();
    s.create("a", "c", "four", 2).unwrap();
}
#[test]
fn total_file_count_counts_ready_and_zero_byte_uploads() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::with_limits(dir.path(), [2; 32], limits()).unwrap();
    for i in 0..4 {
        let owner = format!("owner{i}");
        let m = s.create(&owner, "c", "empty", 0).unwrap();
        s.finalize(m.id, &owner, &Clean).unwrap();
    }
    assert!(matches!(
        s.create("another", "c", "empty", 0),
        Err(Error::Capacity)
    ));
}
#[test]
fn parallel_creates_cannot_oversubscribe() {
    let dir = tempfile::tempdir().unwrap();
    let s = Arc::new(Store::with_limits(dir.path(), [2; 32], limits()).unwrap());
    let barrier = Arc::new(std::sync::Barrier::new(12));
    let workers: Vec<_> = (0..12)
        .map(|i| {
            let s = s.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                s.create(&format!("owner{i}"), "c", "file", 6).is_ok()
            })
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .filter_map(|w| w.join().unwrap().then_some(()))
            .count(),
        2
    );
}
#[test]
fn existing_over_budget_survives_and_only_new_growth_is_denied() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::new(dir.path(), [3; 32]).unwrap();
    let m = s.create("a", "c", "legacy", 9).unwrap();
    s.append(m.id, "a", 0, b"123456789").unwrap();
    s.finalize(m.id, "a", &Clean).unwrap();
    drop(s);
    let s = Store::with_limits(dir.path(), [3; 32], limits()).unwrap();
    assert!(matches!(s.create("a", "c", "new", 1), Err(Error::Capacity)));
    let mut bytes = vec![];
    s.read_range(m.id, 0, 9)
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, b"123456789");
    s.delete(m.id, "a").unwrap();
    s.create("a", "c", "new", 6).unwrap();
}
#[test]
fn malformed_persisted_metadata_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::new(dir.path(), [4; 32]).unwrap();
    let a = s.create("a", "c", "one", 1).unwrap();
    drop(s);
    let path = dir.path().join(a.id.to_string()).join("meta.json");
    std::fs::write(&path, b"{broken").unwrap();
    assert!(matches!(
        Store::with_limits(dir.path(), [4; 32], limits()),
        Err(Error::Metadata(_))
    ));
}
#[test]
fn legacy_interrupted_derivatives_above_u64_reopen_and_reclaim_exactly() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::new(dir.path(), [4; 32]).unwrap();
    let source = s.create("a", "c", "source", 2).unwrap();
    s.append(source.id, "a", 0, b"ok").unwrap();
    s.finalize(source.id, "a", &Clean).unwrap();
    let video = s.create("a", "c", "video", 1).unwrap();
    let thumbnail = s.create("a", "c", "thumbnail", 1).unwrap();
    drop(s);
    // Reproduce pre-fix transcode metadata without allocating giant files. Old
    // derivatives were ordinary uploads with unknown-length sentinel reservations.
    for id in [video.id, thumbnail.id] {
        let path = dir.path().join(id.to_string()).join("meta.json");
        let mut meta: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        meta["length"] = serde_json::json!(u64::MAX);
        meta.as_object_mut().unwrap().remove("generated");
        std::fs::write(path, serde_json::to_vec(&meta).unwrap()).unwrap();
    }
    let mut budgets = limits();
    budgets.pending_per_owner = 4;
    let s = Store::with_limits(dir.path(), [4; 32], budgets).unwrap();
    let mut bytes = vec![];
    s.read_range(source.id, 0, 2)
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, b"ok");
    for id in [video.id, thumbnail.id] {
        assert_eq!(s.inspect(id, "a").unwrap().length, u64::MAX);
        assert!(matches!(s.append(id, "a", 0, b"x"), Err(Error::TooLarge)));
    }
    assert!(matches!(s.create("a", "c", "new", 1), Err(Error::Capacity)));
    assert!(matches!(s.create("b", "c", "new", 1), Err(Error::Capacity)));
    s.delete(video.id, "a").unwrap();
    assert!(matches!(
        s.create("b", "c", "still-full", 1),
        Err(Error::Capacity)
    ));
    s.delete(thumbnail.id, "a").unwrap();
    let replacement = s.create("a", "c", "replacement", 6).unwrap();
    assert!(matches!(
        s.create("a", "c", "owner-full", 1),
        Err(Error::Capacity)
    ));
    s.create("b", "c", "global-remainder", 4).unwrap();
    assert!(matches!(
        s.create("c", "c", "global-full", 1),
        Err(Error::Capacity)
    ));
    s.delete(replacement.id, "a").unwrap();
    s.create("a", "c", "replacement-again", 6).unwrap();
    drop(s);
    let s = Store::with_limits(dir.path(), [4; 32], budgets).unwrap();
    let mut bytes = vec![];
    s.read_range(source.id, 0, 2)
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, b"ok");
}
#[test]
fn failed_create_does_not_consume_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("media");
    let s = Store::with_limits(&path, [5; 32], limits()).unwrap();
    std::fs::remove_dir(&path).unwrap();
    std::fs::write(&path, b"not a directory").unwrap();
    assert!(s.create("a", "c", "one", 6).is_err());
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    s.create("a", "c", "one", 6).unwrap();
    s.create("b", "c", "two", 6).unwrap();
}
#[test]
fn bounded_generated_stream_releases_unused_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::with_limits(dir.path(), [6; 32], limits()).unwrap();
    let m = s.create_generated("a", "c", "generated", 6).unwrap();
    s.append(m.id, "a", 0, b"hi").unwrap();
    assert!(s.append(m.id, "a", 2, b"large").is_err());
    let m = s.finish_generated(m.id, "a", &Clean).unwrap();
    assert_eq!(m.length, 2);
    s.create("a", "c", "next", 6).unwrap();
    drop(s);
    let s = Store::with_limits(dir.path(), [6; 32], limits()).unwrap();
    assert_eq!(s.inspect(m.id, "a").unwrap().length, 2);
}

#[test]
fn deleting_multiple_zero_byte_ready_uploads_for_same_owner_is_safe() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::with_limits(dir.path(), [7; 32], limits()).unwrap();
    let a = s.create("a", "c", "one", 0).unwrap();
    s.finalize(a.id, "a", &Clean).unwrap();
    let b = s.create("a", "c", "two", 0).unwrap();
    s.finalize(b.id, "a", &Clean).unwrap();
    s.delete(a.id, "a").unwrap();
    s.delete(b.id, "a").unwrap();
    s.create("a", "c", "replacement", 6).unwrap();
}
#[test]
fn over_budget_incomplete_reservations_block_append_but_remain_inspectable() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::new(dir.path(), [8; 32]).unwrap();
    let m = s.create("a", "c", "old", 9).unwrap();
    drop(s);
    let s = Store::with_limits(dir.path(), [8; 32], limits()).unwrap();
    assert_eq!(s.inspect(m.id, "a").unwrap().length, 9);
    assert!(matches!(s.append(m.id, "a", 0, b"x"), Err(Error::TooLarge)));
    s.delete(m.id, "a").unwrap();
    s.create("a", "c", "new", 6).unwrap();
}
