//! Gimme v2: discover first, idempotent submissions, same-origin job polling.
//! Dry-run is the default. Fixtures verify the protocol without contacting Gimme.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use url::Url;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    DryRun,
    Live,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "media", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Movie { query: String },
    Tv { query: String },
}
impl Request {
    pub fn parts(&self) -> Result<(&'static str, serde_json::Value)> {
        let (path, query) = match self {
            Self::Movie { query } => ("/agent/movies/request", query),
            Self::Tv { query } => ("/agent/tv/request", query),
        };
        if query.trim().is_empty() || query.len() > 512 || query.chars().any(char::is_control) {
            return Err(Error::Invalid("Gimme query"));
        }
        Ok((path, serde_json::json!({"query":query})))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Job {
    pub job_id: String,
    pub poll: String,
    pub retry_after_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Submission {
    DryRun {
        method: String,
        path: String,
        body: serde_json::Value,
        idempotency_key: String,
    },
    Accepted {
        job: Job,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Poll {
    Pending {
        job: Job,
    },
    Complete {
        result_status: String,
        result: serde_json::Value,
    },
    Failed {
        code: String,
        retryable: bool,
        message: String,
    },
}
pub struct Gimme {
    origin: Url,
    key: String,
    client: reqwest::Client,
    mode: Mode,
    discovered: bool,
    /// Server must persist this intent ledger before network submission for restart safety.
    intents: BTreeMap<String, (String, serde_json::Value)>,
}
impl Gimme {
    pub fn new(origin: &str, key: String, mode: Mode) -> Result<Self> {
        Ok(Self {
            origin: crate::origin(origin)?,
            key,
            client: crate::http()?,
            mode,
            discovered: false,
            intents: BTreeMap::new(),
        })
    }
    fn endpoint(&self, path: &str) -> Result<Url> {
        if !path.starts_with("/agent/")
            || path.contains(['\\', '?', '#', '%'])
            || path.contains("..")
        {
            return Err(Error::Invalid("Gimme path"));
        }
        let url = self
            .origin
            .join(path)
            .map_err(|_| Error::Invalid("Gimme path"))?;
        if url.origin() != self.origin.origin() {
            return Err(Error::Invalid("Gimme cross-origin URL"));
        }
        Ok(url)
    }
    fn get(&self, path: &str) -> Result<reqwest::RequestBuilder> {
        Ok(self
            .client
            .get(self.endpoint(path)?)
            .header("x-api-key", &self.key)
            .header("User-Agent", "Housecall-Gimme/0.1"))
    }
    /// In dry-run mode discovery uses explicit v2 fixture documents supplied by the caller.
    pub fn discover_fixture(
        &mut self,
        capabilities: &serde_json::Value,
        contract: &serde_json::Value,
    ) -> Result<()> {
        if self.mode != Mode::DryRun {
            return Err(Error::Invalid("fixtures require dry-run"));
        }
        self.validate_discovery(capabilities, contract)
    }
    fn validate_discovery(
        &mut self,
        capabilities: &serde_json::Value,
        contract: &serde_json::Value,
    ) -> Result<()> {
        self.discovered = capabilities["api_version"].as_u64() == Some(2)
            && contract["api_version"].as_u64() == Some(2);
        if self.discovered {
            Ok(())
        } else {
            Err(Error::Invalid("Gimme requires API v2"))
        }
    }
    pub async fn discover(&mut self) -> Result<()> {
        if self.mode != Mode::Live {
            return Err(Error::Invalid("dry-run discovery must use a fixture"));
        }
        self.discovered = false;
        let capabilities: serde_json::Value = crate::read_json(
            self.get("/agent/capabilities")?
                .send()
                .await
                .map_err(|_| Error::Provider)?
                .error_for_status()
                .map_err(|_| Error::Provider)?,
            2 * 1024 * 1024,
        )
        .await?;
        let contract: serde_json::Value = crate::read_json(
            self.get("/agent/contract")?
                .send()
                .await
                .map_err(|_| Error::Provider)?
                .error_for_status()
                .map_err(|_| Error::Provider)?,
            2 * 1024 * 1024,
        )
        .await?;
        self.validate_discovery(&capabilities, &contract)
    }
    pub async fn submit(&mut self, request: Request, idempotency_key: &str) -> Result<Submission> {
        if !self.discovered {
            return Err(Error::Invalid("discover Gimme v2 first"));
        }
        if idempotency_key.is_empty()
            || idempotency_key.len() > 200
            || !idempotency_key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(Error::Invalid("idempotency key"));
        }
        let (path, body) = request.parts()?;
        let intent = (path.to_owned(), body.clone());
        if self
            .intents
            .get(idempotency_key)
            .is_some_and(|old| old != &intent)
        {
            return Err(Error::Conflict);
        }
        self.intents.insert(idempotency_key.to_owned(), intent);
        if self.mode == Mode::DryRun {
            return Ok(Submission::DryRun {
                method: "POST".to_owned(),
                path: path.to_owned(),
                body,
                idempotency_key: idempotency_key.to_owned(),
            });
        }
        let response = self
            .client
            .post(self.endpoint(path)?)
            .header("x-api-key", &self.key)
            .header("Idempotency-Key", idempotency_key)
            .header("User-Agent", "Housecall-Gimme/0.1")
            .json(&body)
            .send()
            .await
            .map_err(|_| Error::Provider)?;
        if response.status() != reqwest::StatusCode::ACCEPTED {
            return Err(Error::Provider);
        }
        let retry_header = response
            .headers()
            .get("Retry-After")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.parse::<u64>().ok())
            .map(|s| s.saturating_mul(1000));
        let value: serde_json::Value = crate::read_json(response, 2 * 1024 * 1024).await?;
        if value["status"] != "accepted" {
            return Err(Error::Provider);
        }
        Ok(Submission::Accepted {
            job: self.parse_job(&value, retry_header)?,
        })
    }
    pub fn parse_job(
        &self,
        value: &serde_json::Value,
        retry_header_ms: Option<u64>,
    ) -> Result<Job> {
        let job_id = value["job_id"]
            .as_str()
            .filter(|s| valid_job_id(s))
            .ok_or(Error::Provider)?
            .to_owned();
        let poll = value["poll"].as_str().ok_or(Error::Provider)?.to_owned();
        if poll != format!("/agent/jobs/{job_id}") {
            return Err(Error::Invalid("Gimme job poll path"));
        }
        self.endpoint(&poll)?;
        Ok(Job {
            job_id,
            poll,
            retry_after_ms: retry_header_ms
                .or_else(|| value["retry_after_ms"].as_u64())
                .unwrap_or(2000)
                .clamp(100, 300_000),
        })
    }
    pub async fn poll(&self, job: &Job) -> Result<Poll> {
        if !self.discovered || self.mode != Mode::Live {
            return Err(Error::Invalid("live discovery required"));
        }
        if !valid_job_id(&job.job_id) || job.poll != format!("/agent/jobs/{}", job.job_id) {
            return Err(Error::Invalid("Gimme job"));
        }
        let response = self
            .get(&job.poll)?
            .send()
            .await
            .map_err(|_| Error::Provider)?
            .error_for_status()
            .map_err(|_| Error::Provider)?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(Error::Provider);
        }
        let retry_header = response
            .headers()
            .get("Retry-After")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.parse::<u64>().ok())
            .map(|s| s.saturating_mul(1000));
        let value: serde_json::Value = crate::read_json(response, 2 * 1024 * 1024).await?;
        Self::interpret_poll(job, &value, retry_header)
    }
    pub fn interpret_poll(
        job: &Job,
        value: &serde_json::Value,
        retry_header_ms: Option<u64>,
    ) -> Result<Poll> {
        match value["status"].as_str().ok_or(Error::Provider)? {
            "complete" => Ok(Poll::Complete {
                result_status: value["result_status"]
                    .as_str()
                    .ok_or(Error::Provider)?
                    .to_owned(),
                result: value.get("result").cloned().ok_or(Error::Provider)?,
            }),
            "failed" => Ok(Poll::Failed {
                code: value["code"].as_str().unwrap_or("job_failed").to_owned(),
                retryable: value["retryable"].as_bool().unwrap_or(false),
                message: value["error"]
                    .as_str()
                    .or_else(|| value["message"].as_str())
                    .unwrap_or("Gimme job failed")
                    .to_owned(),
            }),
            "pending" | "queued" | "running" | "accepted" => {
                let mut job = job.clone();
                job.retry_after_ms = retry_header_ms
                    .or_else(|| value["retry_after_ms"].as_u64())
                    .unwrap_or(job.retry_after_ms)
                    .clamp(100, 300_000);
                Ok(Poll::Pending { job })
            }
            _ => Err(Error::Provider),
        }
    }
}
fn valid_job_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
