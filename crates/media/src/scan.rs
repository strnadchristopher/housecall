//! Sanitized scan facts. Stream consumption is not proof every embedded object was analyzed.
use serde::{Deserialize, Serialize};
use std::{
    fmt, io,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    Unspecified,
    Disabled,
    Clamav,
    Withsecure,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Pending,
    NoFinding,
    Detected,
    Rejected,
    Unavailable,
    TimedOut,
    Incomplete,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    AwaitingScanner,
    ScannerNotConfigured,
    ScannerUnavailable,
    ScannerTimedOut,
    EngineLimit,
    EncryptedOrUnsupported,
    BlockingFinding,
    UnclassifiedRejection,
    SourceNotConsumed,
    SourceReadFailed,
    EngineReportedNoFinding,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Coverage {
    Unknown,
    StreamConsumed,
    Incomplete,
    EngineLimited,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Report {
    pub attempt_id: Uuid,
    pub engine: Engine,
    pub verdict: Verdict,
    pub reason: Reason,
    pub coverage: Coverage,
    pub bytes_consumed: u64,
    pub finished_at_ms: Option<u64>,
}
impl Report {
    pub fn pending(engine: Engine) -> Self {
        Self {
            attempt_id: Uuid::new_v4(),
            engine,
            verdict: Verdict::Pending,
            reason: Reason::AwaitingScanner,
            coverage: Coverage::Unknown,
            bytes_consumed: 0,
            finished_at_ms: None,
        }
    }
    pub fn finish(&mut self, result: io::Result<()>, consumed: u64, length: u64) -> bool {
        self.bytes_consumed = consumed;
        self.finished_at_ms = Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        );
        let failure = match result {
            Ok(()) if consumed == length => {
                self.verdict = Verdict::NoFinding;
                self.reason = Reason::EngineReportedNoFinding;
                self.coverage = Coverage::StreamConsumed;
                return true;
            }
            Ok(()) => Failure {
                verdict: Verdict::Incomplete,
                reason: Reason::SourceNotConsumed,
            },
            Err(error) => Failure::from_io(&error),
        };
        self.verdict = failure.verdict;
        self.reason = failure.reason;
        self.coverage = if matches!(
            failure.reason,
            Reason::EngineLimit | Reason::EncryptedOrUnsupported
        ) {
            Coverage::EngineLimited
        } else if consumed < length {
            Coverage::Incomplete
        } else {
            Coverage::Unknown
        };
        false
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Failure {
    pub verdict: Verdict,
    pub reason: Reason,
}
impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("scan did not establish release eligibility")
    }
}
impl std::error::Error for Failure {}
impl Failure {
    pub fn error(verdict: Verdict, reason: Reason) -> io::Error {
        io::Error::other(Self { verdict, reason })
    }
    pub fn from_io(error: &io::Error) -> Self {
        if let Some(failure) = error
            .get_ref()
            .and_then(|inner| inner.downcast_ref::<Self>())
        {
            return *failure;
        }
        match error.kind() {
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => Self {
                verdict: Verdict::TimedOut,
                reason: Reason::ScannerTimedOut,
            },
            io::ErrorKind::NotFound
            | io::ErrorKind::ConnectionRefused
            | io::ErrorKind::NotConnected => Self {
                verdict: Verdict::Unavailable,
                reason: Reason::ScannerUnavailable,
            },
            _ => Self {
                verdict: Verdict::Rejected,
                reason: Reason::UnclassifiedRejection,
            },
        }
    }
}
/// Recognize only protocol shape and documented heuristic classes, never persist signature/path text.
#[cfg(unix)]
pub(crate) fn clamd_reply(response: &[u8]) -> io::Result<()> {
    if response == b"stream: OK\0" {
        return Ok(());
    }
    let text = std::str::from_utf8(response).unwrap_or("");
    if text.starts_with("stream: ") && text.ends_with(" FOUND\0") {
        if text.contains("Heuristics.Limits.Exceeded") {
            Err(Failure::error(Verdict::Incomplete, Reason::EngineLimit))
        } else if text.contains("Heuristics.Encrypted") {
            Err(Failure::error(
                Verdict::Incomplete,
                Reason::EncryptedOrUnsupported,
            ))
        } else {
            Err(Failure::error(Verdict::Detected, Reason::BlockingFinding))
        }
    } else if text == "INSTREAM size limit exceeded. ERROR\0"
        || text == "stream: Size limit exceeded. ERROR\0"
    {
        Err(Failure::error(Verdict::Incomplete, Reason::EngineLimit))
    } else {
        Err(Failure::error(
            Verdict::Rejected,
            Reason::UnclassifiedRejection,
        ))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn protocol_limits_are_incomplete_and_unknown_rejections_never_become_detections() {
        for (input, verdict, reason) in [
            (
                &b"stream: Eicar-Signature FOUND\0"[..],
                Verdict::Detected,
                Reason::BlockingFinding,
            ),
            (
                &b"stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND\0"[..],
                Verdict::Incomplete,
                Reason::EngineLimit,
            ),
            (
                &b"stream: Heuristics.Encrypted.Zip FOUND\0"[..],
                Verdict::Incomplete,
                Reason::EncryptedOrUnsupported,
            ),
            (
                &b"INSTREAM size limit exceeded. ERROR\0"[..],
                Verdict::Incomplete,
                Reason::EngineLimit,
            ),
            (
                &b"stream: unknown private failure ERROR\0"[..],
                Verdict::Rejected,
                Reason::UnclassifiedRejection,
            ),
            (
                &b"stream: OK\0untrusted trailing data"[..],
                Verdict::Rejected,
                Reason::UnclassifiedRejection,
            ),
        ] {
            let failure = Failure::from_io(&clamd_reply(input).unwrap_err());
            assert_eq!(failure.verdict, verdict);
            assert_eq!(failure.reason, reason);
            let mut report = Report::pending(Engine::Clamav);
            assert!(!report.finish(clamd_reply(input), 10, 10));
            let encoded = serde_json::to_string(&report).unwrap();
            assert!(!encoded.contains("Eicar") && !encoded.contains("private failure"));
        }
        assert!(clamd_reply(b"stream: OK\0").is_ok());
    }
}
