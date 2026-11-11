//! Durable Gimme request intents. No confirmation/cancellation endpoint exists here.
//! Dry-run never contacts a provider. Integration tests use loopback fixtures only.
use crate::{emit, member, now, ApiError, ApiResult, AppState, Principal};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Extension, Json, Router,
};
use housecall_activities::gimme::{Gimme, Job, Mode, Poll, Request, Submission};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;
const MAX_ACTIVE: i64 = 64;
const MAX_USER_ACTIVE: i64 = 8;
const MAX_POLLS: i64 = 300;
#[derive(Clone)]
struct Config {
    origin: String,
    key: String,
    mode: Mode,
}
pub struct Worker {
    config: Config,
    gate: tokio::sync::Mutex<()>,
}
impl Worker {
    pub fn dry_run() -> Arc<Self> {
        Arc::new(Self {
            config: Config {
                origin: "https://api.littleobelisk.com/".into(),
                key: String::new(),
                mode: Mode::DryRun,
            },
            gate: tokio::sync::Mutex::new(()),
        })
    }
    /// Only explicit runtime configuration enables provider calls. Tests supply literal loopback origins.
    pub fn configured(origin: &str, key: String) -> Result<Arc<Self>, String> {
        let parsed = url::Url::parse(origin).map_err(|_| "invalid Gimme origin")?;
        let loopback = parsed
            .host_str()
            .and_then(|h| h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
        if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
            return Err("Gimme requires HTTPS except literal loopback fixtures".into());
        }
        if key.is_empty() {
            return Err("GIMME_AGENT_API_KEY is required outside dry-run".into());
        }
        Gimme::new(origin, key.clone(), Mode::Live).map_err(|_| "invalid Gimme origin")?;
        Ok(Arc::new(Self {
            config: Config {
                origin: parsed.to_string(),
                key,
                mode: Mode::Live,
            },
            gate: tokio::sync::Mutex::new(()),
        }))
    }
    pub fn is_dry_run(&self) -> bool {
        self.config.mode == Mode::DryRun
    }
    /// One due job per tick, serialized across callers. Never resubmits an accepted job.
    pub async fn tick(&self, db: &Arc<Mutex<Connection>>) -> Result<(), ApiError> {
        let Ok(_gate) = self.gate.try_lock() else {
            return Ok(());
        };
        if self.is_dry_run() {
            return Ok(());
        }
        let record = {
            let db = db.lock().unwrap();
            let id:Option<String>=db.query_row("SELECT id FROM gimme_requests WHERE state IN ('queued','pending') AND next_poll_at<=?1 ORDER BY next_poll_at,created_at,id LIMIT 1",[now()],|r|r.get(0)).optional()?;
            id.map(|id| load(&db, &id)).transpose()?
        };
        let Some(mut record) = record else {
            return Ok(());
        };
        if record.provider_origin != self.config.origin {
            return fail(
                db,
                &record,
                "provider_configuration_changed",
                record.job.is_some(),
            );
        }
        if !authorized_record(&db.lock().unwrap(), &record)? {
            return fail(
                db,
                &record,
                "authorization_revoked",
                record.job.is_some() || record.submission_started,
            );
        }
        if record.state == "queued" && record.submission_started {
            return fail(db, &record, "submission_outcome_unknown", true);
        }
        if record.poll_count >= MAX_POLLS {
            return fail(db, &record, "poll_limit_reached", true);
        }
        let mut provider = Gimme::new(&self.config.origin, self.config.key.clone(), Mode::Live)
            .map_err(|_| unavailable())?;
        // A fresh provider session always discovers both authenticated v2 documents before operation.
        if provider.discover().await.is_err() {
            return fail(db, &record, "discovery_failed", record.job.is_some());
        }
        if !authorized_record(&db.lock().unwrap(), &record)? {
            return fail(db, &record, "authorization_revoked", record.job.is_some());
        }
        record.provider_verified = true;
        if record.state == "queued" {
            // Durable write-ahead intent. A crash after this commit is uncertain, never an automatic resubmit.
            let claimed = {
                let db = db.lock().unwrap();
                db.execute("UPDATE gimme_requests SET submission_started=1,provider_verified=1,updated_at=?1 WHERE id=?2 AND state='queued' AND submission_started=0",params![now(),record.id])?
            };
            if claimed == 0 {
                return Ok(());
            }
            record.submission_started = true;
            let submitted = provider
                .submit(record.request.clone(), &record.idempotency_key)
                .await;
            match submitted {
                Ok(Submission::Accepted { job }) => {
                    record.state = "pending".into();
                    record.next_poll_at = now() + job.retry_after_ms.max(1000) as i64;
                    record.job = Some(job);
                    record.error_code = None;
                    store(db, &record)?;
                }
                _ => return fail(db, &record, "submission_failed_or_unknown", true),
            }
        } else {
            let Some(job) = record.job.clone() else {
                return fail(db, &record, "invalid_saved_job", true);
            };
            record.poll_count += 1;
            match provider.poll(&job).await {
                Ok(Poll::Pending { job }) => {
                    record.next_poll_at = now() + job.retry_after_ms.max(1000) as i64;
                    record.job = Some(job);
                    store(db, &record)?;
                }
                Ok(Poll::Complete {
                    result_status,
                    result,
                }) => {
                    record.state = "complete".into();
                    record.result_status =
                        Some(clean(&result_status, 80).replace(&self.config.key, "[redacted]"));
                    record.confirmation_required = result["status"] == "confirmation_required";
                    let mut result = public_result(&result);
                    redact(&mut result, &self.config.key);
                    record.result = Some(result);
                    record.outcome_unknown = false;
                    record.error_code = None;
                    store(db, &record)?;
                }
                Ok(Poll::Failed {
                    code, retryable, ..
                }) => {
                    record.state = "failed".into();
                    record.error_code =
                        Some(clean(&code, 100).replace(&self.config.key, "[redacted]"));
                    record.retryable = retryable;
                    record.outcome_unknown = false;
                    store(db, &record)?;
                }
                Err(_) => return fail(db, &record, "poll_failed_outcome_unknown", true),
            }
        }
        Ok(())
    }
}
pub fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS gimme_requests(
 id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),session_id TEXT NOT NULL,
 idempotency_key TEXT UNIQUE NOT NULL,request_json TEXT NOT NULL,provider_origin TEXT NOT NULL,dry_run INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','pending','complete','failed')),submission_started INTEGER NOT NULL DEFAULT 0,
 job_json TEXT,operation_json TEXT NOT NULL,result_json TEXT,result_status TEXT,error_code TEXT,retryable INTEGER NOT NULL DEFAULT 0,confirmation_required INTEGER NOT NULL DEFAULT 0,
 provider_verified INTEGER NOT NULL DEFAULT 0,outcome_unknown INTEGER NOT NULL DEFAULT 0,poll_count INTEGER NOT NULL DEFAULT 0,next_poll_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS gimme_due ON gimme_requests(state,next_poll_at,created_at);
 CREATE INDEX IF NOT EXISTS gimme_channel_history ON gimme_requests(channel_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS gimme_user_active ON gimme_requests(user_id,state);")
}
pub fn configure(s: &mut AppState) -> Result<(), String> {
    let dry = std::env::var("GIMME_DRY_RUN").unwrap_or_else(|_| "true".into());
    s.gimme = match dry.as_str() {
        "true" | "1" => Worker::dry_run(),
        "false" | "0" => Worker::configured(
            &std::env::var("GIMME_BASE_URL")
                .unwrap_or_else(|_| "https://api.littleobelisk.com/".into()),
            std::env::var("GIMME_AGENT_API_KEY").unwrap_or_default(),
        )?,
        _ => return Err("GIMME_DRY_RUN must be true or false".into()),
    };
    recover(&s.db).map_err(|_| "Gimme recovery failed")?;
    Ok(())
}
/// Interrupted submissions are visible as uncertain failures; accepted/pending jobs retain their IDs.
pub fn recover(db: &Arc<Mutex<Connection>>) -> Result<(), ApiError> {
    let ids = {
        let db = db.lock().unwrap();
        let mut stmt = db.prepare(
            "SELECT id FROM gimme_requests WHERE state='queued' AND submission_started=1",
        )?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids
    };
    for id in ids {
        let record = load(&db.lock().unwrap(), &id)?;
        fail(db, &record, "submission_outcome_unknown", true)?;
    }
    Ok(())
}
pub fn spawn_worker(s: &AppState) {
    let weak = Arc::downgrade(&s.gimme);
    let db = s.db.clone();
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(1));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let Some(worker) = weak.upgrade() else {
                break;
            };
            if worker.tick(&db).await.is_err() {
                tracing::warn!("Gimme durable worker storage operation failed");
            }
        }
    });
}
pub fn routes() -> Router<AppState> {
    Router::new().route("/channels/{id}/gimme/requests", get(list).post(submit))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    request: Request,
    idempotency_key: String,
}
#[derive(Clone, Serialize)]
pub struct Status {
    pub id: String,
    pub channel_id: String,
    pub user_id: String,
    pub request: Request,
    pub state: String,
    pub dry_run: bool,
    pub provider_verified: bool,
    pub result_status: Option<String>,
    pub result: Option<Value>,
    pub confirmation_required: bool,
    pub error_code: Option<String>,
    pub retryable: bool,
    pub provider_outcome_unknown: bool,
    pub provider_job_id: Option<String>,
    pub polling_paused: bool,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Clone)]
struct Record {
    id: String,
    channel: String,
    user: String,
    session: String,
    idempotency_key: String,
    request: Request,
    provider_origin: String,
    dry_run: bool,
    state: String,
    submission_started: bool,
    job: Option<Job>,
    operation: Value,
    result: Option<Value>,
    result_status: Option<String>,
    error_code: Option<String>,
    retryable: bool,
    confirmation_required: bool,
    provider_verified: bool,
    outcome_unknown: bool,
    poll_count: i64,
    next_poll_at: i64,
    created_at: i64,
    updated_at: i64,
}
impl Record {
    fn view(&self, worker: &Worker) -> Status {
        Status {
            id: self.id.clone(),
            channel_id: self.channel.clone(),
            user_id: self.user.clone(),
            request: self.request.clone(),
            state: self.state.clone(),
            dry_run: self.dry_run,
            provider_verified: self.provider_verified,
            result_status: self.result_status.clone(),
            result: self.result.clone(),
            confirmation_required: self.confirmation_required,
            error_code: self.error_code.clone(),
            retryable: self.retryable,
            provider_outcome_unknown: self.outcome_unknown,
            provider_job_id: self.job.as_ref().map(|j| j.job_id.clone()),
            polling_paused: worker.is_dry_run()
                && !self.dry_run
                && matches!(self.state.as_str(), "queued" | "pending"),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}
fn unavailable() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "Gimme provider configuration is unavailable",
    )
}
fn invalid() -> ApiError {
    ApiError(
        StatusCode::BAD_REQUEST,
        "invalid Gimme request or idempotency key",
    )
}
fn authorized_record(db: &Connection, r: &Record) -> Result<bool, ApiError> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM sessions s JOIN members m ON m.user_id=s.user_id WHERE s.id=?1 AND s.user_id=?2 AND s.expires_at>?3 AND m.channel_id=?4)",params![r.session,r.user,now(),r.channel],|r|r.get(0))?)
}
fn load(db: &Connection, id: &str) -> Result<Record, ApiError> {
    let row=db.query_row("SELECT id,channel_id,user_id,session_id,idempotency_key,request_json,provider_origin,dry_run,state,submission_started,job_json,operation_json,result_json,result_status,error_code,retryable,confirmation_required,provider_verified,outcome_unknown,poll_count,next_poll_at,created_at,updated_at FROM gimme_requests WHERE id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,bool>(7)?,r.get::<_,String>(8)?,r.get::<_,bool>(9)?,r.get::<_,Option<String>>(10)?,r.get::<_,String>(11)?,r.get::<_,Option<String>>(12)?,r.get::<_,Option<String>>(13)?,r.get::<_,Option<String>>(14)?,r.get::<_,bool>(15)?,r.get::<_,bool>(16)?,r.get::<_,bool>(17)?,r.get::<_,bool>(18)?,r.get::<_,i64>(19)?,r.get::<_,i64>(20)?,r.get::<_,i64>(21)?,r.get::<_,i64>(22)?)))?;
    let bad = || {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid saved Gimme request",
        )
    };
    Ok(Record {
        id: row.0,
        channel: row.1,
        user: row.2,
        session: row.3,
        idempotency_key: row.4,
        request: serde_json::from_str(&row.5).map_err(|_| bad())?,
        provider_origin: row.6,
        dry_run: row.7,
        state: row.8,
        submission_started: row.9,
        job: row
            .10
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|_| bad())?,
        operation: serde_json::from_str(&row.11).map_err(|_| bad())?,
        result: row
            .12
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|_| bad())?,
        result_status: row.13,
        error_code: row.14,
        retryable: row.15,
        confirmation_required: row.16,
        provider_verified: row.17,
        outcome_unknown: row.18,
        poll_count: row.19,
        next_poll_at: row.20,
        created_at: row.21,
        updated_at: row.22,
    })
}
fn store(db: &Arc<Mutex<Connection>>, record: &Record) -> Result<(), ApiError> {
    let mut db = db.lock().unwrap();
    let tx = db.transaction()?;
    let mut record = record.clone();
    record.updated_at = now();
    let count=tx.execute("UPDATE gimme_requests SET state=?1,submission_started=?2,job_json=?3,result_json=?4,result_status=?5,error_code=?6,retryable=?7,confirmation_required=?8,provider_verified=?9,outcome_unknown=?10,poll_count=?11,next_poll_at=?12,updated_at=?13 WHERE id=?14 AND state IN ('queued','pending')",params![record.state,record.submission_started,record.job.as_ref().map(|v|serde_json::to_string(v).unwrap()),record.result.as_ref().map(Value::to_string),record.result_status,record.error_code,record.retryable,record.confirmation_required,record.provider_verified,record.outcome_unknown,record.poll_count,record.next_poll_at,record.updated_at,record.id])?;
    if count > 0 {
        let view = record.view(&Worker {
            config: Config {
                origin: String::new(),
                key: String::new(),
                mode: Mode::Live,
            },
            gate: tokio::sync::Mutex::new(()),
        });
        emit(&tx, &record.channel, "gimme.request.updated", json!(view))?;
    }
    tx.commit()?;
    Ok(())
}
fn fail(
    db: &Arc<Mutex<Connection>>,
    record: &Record,
    code: &str,
    unknown: bool,
) -> Result<(), ApiError> {
    let mut record = record.clone();
    record.state = "failed".into();
    record.error_code = Some(code.into());
    record.outcome_unknown = unknown;
    record.retryable = false;
    store(db, &record)
}
async fn submit(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
    Json(input): Json<Intent>,
) -> ApiResult<Value> {
    let (path, body) = input.request.parts().map_err(|_| invalid())?;
    if input.idempotency_key.is_empty()
        || input.idempotency_key.len() > 200
        || !input
            .idempotency_key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(invalid());
    }
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    member(&tx, &p.user.id, &channel)?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM gimme_requests WHERE idempotency_key=?1",
            [&input.idempotency_key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        let record = load(&tx, &id)?;
        if record.channel != channel || record.user != p.user.id || record.request != input.request
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "idempotency key conflicts with an existing request",
            ));
        }
        return Ok(Json(envelope(&record, &s.gimme)));
    }
    let active: i64 = tx.query_row(
        "SELECT count(*) FROM gimme_requests WHERE state IN ('queued','pending')",
        [],
        |r| r.get(0),
    )?;
    let user_active: i64 = tx.query_row(
        "SELECT count(*) FROM gimme_requests WHERE user_id=?1 AND state IN ('queued','pending')",
        [&p.user.id],
        |r| r.get(0),
    )?;
    if active >= MAX_ACTIVE || user_active >= MAX_USER_ACTIVE {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Gimme request queue is full",
        ));
    }
    let dry = s.gimme.is_dry_run();
    let at = now();
    let operation = if dry {
        json!(Submission::DryRun {
            method: "POST".into(),
            path: path.into(),
            body,
            idempotency_key: input.idempotency_key.clone()
        })
    } else {
        json!({"state":"queued"})
    };
    let record = Record {
        id: Uuid::new_v4().to_string(),
        channel: channel.clone(),
        user: p.user.id,
        session: p.session_id,
        idempotency_key: input.idempotency_key,
        request: input.request,
        provider_origin: s.gimme.config.origin.clone(),
        dry_run: dry,
        state: if dry { "complete" } else { "queued" }.into(),
        submission_started: false,
        job: None,
        operation,
        result: None,
        result_status: dry.then(|| "dry_run".into()),
        error_code: None,
        retryable: false,
        confirmation_required: false,
        provider_verified: false,
        outcome_unknown: false,
        poll_count: 0,
        next_poll_at: at,
        created_at: at,
        updated_at: at,
    };
    if !authorized_record(&tx, &record)? {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "requesting session was revoked",
        ));
    }
    tx.execute("INSERT INTO gimme_requests(id,channel_id,user_id,session_id,idempotency_key,request_json,provider_origin,dry_run,state,operation_json,result_status,next_poll_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?12)",params![record.id,record.channel,record.user,record.session,record.idempotency_key,serde_json::to_string(&record.request).unwrap(),record.provider_origin,record.dry_run,record.state,record.operation.to_string(),record.result_status,at])?;
    let response = envelope(&record, &s.gimme);
    emit(
        &tx,
        &channel,
        "gimme.request.updated",
        json!(record.view(&s.gimme)),
    )?;
    if dry {
        emit(&tx, &channel, "gimme.dry_run", response.clone())?;
    }
    tx.commit()?;
    Ok(Json(response))
}
fn envelope(r: &Record, w: &Worker) -> Value {
    json!({"dry_run":r.dry_run,"provider_verified":r.provider_verified,"operation":r.operation,"request":r.view(w)})
}
async fn list(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(channel): Path<String>,
) -> ApiResult<Value> {
    let db = s.db.lock().unwrap();
    member(&db, &p.user.id, &channel)?;
    let mut stmt=db.prepare("SELECT id FROM gimme_requests WHERE channel_id=?1 ORDER BY created_at DESC,id DESC LIMIT 100")?;
    let ids = stmt
        .query_map([channel], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let requests = ids
        .into_iter()
        .map(|id| load(&db, &id).map(|r| r.view(&s.gimme)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({"requests":requests})))
}
fn clean(raw: &str, max: usize) -> String {
    raw.chars().filter(|c| !c.is_control()).take(max).collect()
}
fn public_result(result: &Value) -> Value {
    let status = result["status"]
        .as_str()
        .map(|s| clean(s, 100))
        .unwrap_or_else(|| "unknown".into());
    let media = result
        .get("movie")
        .or_else(|| result.get("show"))
        .unwrap_or(result);
    // Project safe status fields, never provider URLs, credentials, magnets, private paths or confirm operations.
    let mut value =
        json!({"status":status,"confirmation_required":status=="confirmation_required"});
    for name in ["title", "name"] {
        if let Some(title) = media[name].as_str() {
            value["title"] = json!(clean(title, 300));
            break;
        }
    }
    if let Some(id) = media["tmdb_id"].as_u64() {
        value["tmdb_id"] = json!(id);
    }
    if let Some(release) = result["release"]["state"].as_str() {
        value["release_state"] = json!(clean(release, 60));
    }
    if let Some(summary) = result.get("search_summary") {
        value["search_uncertain"] = json!(uncertain_summary(summary));
    }
    value
}

fn uncertain_summary(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(uncertain_summary),
        Value::Object(values) => values.iter().any(|(key, value)| {
            let key = key.as_str();
            let marked = match value {
                Value::Null => false,
                Value::Bool(b) => *b,
                Value::Number(n) => n.as_u64() != Some(0),
                Value::String(s) => !s.is_empty() && s != "false" && s != "0",
                Value::Array(a) => !a.is_empty(),
                Value::Object(o) => !o.is_empty(),
            };
            (matches!(
                key,
                "pending" | "timed_out" | "timeouts" | "errors" | "backend_errors" | "incomplete"
            ) && marked)
                || (matches!(key, "complete" | "completed") && value == &json!(false))
                || (matches!(key, "status" | "state")
                    && value.as_str().is_some_and(|s| {
                        matches!(
                            s,
                            "pending"
                                | "running"
                                | "queued"
                                | "timeout"
                                | "timed_out"
                                | "failed"
                                | "error"
                                | "incomplete"
                        )
                    }))
                || uncertain_summary(value)
        }),
        _ => false,
    }
}
fn redact(value: &mut Value, key: &str) {
    if key.is_empty() {
        return;
    }
    match value {
        Value::String(s) => *s = s.replace(key, "[redacted]"),
        Value::Array(a) => a.iter_mut().for_each(|v| redact(v, key)),
        Value::Object(o) => o.values_mut().for_each(|v| redact(v, key)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request as HttpRequest};
    use http_body_util::BodyExt;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    use tower::ServiceExt;
    fn seed(path: &str) -> AppState {
        let s = AppState::new(path, "fixture").unwrap();
        {
            let db = s.db.lock().unwrap();
            db.execute(
                "INSERT OR IGNORE INTO channels(id,name,kind) VALUES('room','Fixture','channel')",
                [],
            )
            .unwrap();
            for (name, token, joins) in [
                ("alice", 'a', true),
                ("bob", 'b', true),
                ("outsider", 'c', false),
            ] {
                db.execute("INSERT OR IGNORE INTO users(id,username,password,is_owner) VALUES(?1,?1,'unused',0)",[name]).unwrap();
                db.execute("INSERT OR IGNORE INTO sessions(id,user_id,token_hash,device_hash,device_name,created_at,expires_at) VALUES(?1,?1,?2,?3,'fixture',?4,?5)",params![name,crate::hash(&token.to_string().repeat(64)),crate::hash(&"e".repeat(64)),now(),now()+600000]).unwrap();
                if joins {
                    db.execute(
                        "INSERT OR IGNORE INTO members(channel_id,user_id) VALUES('room',?1)",
                        [name],
                    )
                    .unwrap();
                }
            }
        }
        s
    }
    async fn call(
        s: &AppState,
        who: Option<char>,
        method: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut request = HttpRequest::builder()
            .method(method)
            .uri("/api/channels/room/gimme/requests")
            .header("content-type", "application/json");
        if let Some(who) = who {
            request = request
                .header(
                    "authorization",
                    format!("Bearer {}", who.to_string().repeat(64)),
                )
                .header("x-device-key", "e".repeat(64));
        }
        let response = crate::app(s.clone(), None)
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap())
    }
    fn intent(key: &str) -> Value {
        json!({"request":{"media":"movie","query":"Fixture Movie 2000"},"idempotency_key":key})
    }
    fn fixture(
        responses: Vec<(u16, Value)>,
    ) -> (String, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}/", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let worker = std::thread::spawn(move || {
            for (status, value) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let n = stream.read(&mut buffer).unwrap();
                    bytes.extend_from_slice(&buffer[..n]);
                    if n == 0 {
                        break;
                    }
                    let text = String::from_utf8_lossy(&bytes);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|n| n.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                log.lock().unwrap().push(String::from_utf8(bytes).unwrap());
                let body = value.to_string();
                write!(stream,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        (origin, seen, worker)
    }
    fn discovery() -> Vec<(u16, Value)> {
        vec![
            (200, json!({"api_version":2})),
            (200, json!({"api_version":2})),
        ]
    }
    fn due(s: &AppState) {
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE gimme_requests SET next_poll_at=0 WHERE state='pending'",
                [],
            )
            .unwrap();
    }
    #[tokio::test]
    async fn durable_dry_run_idempotency_authentication_and_channel_status_feed() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let path = temp.path().to_str().unwrap();
        let s = seed(path);
        for method in ["POST", "GET"] {
            assert_eq!(
                call(&s, None, method, intent("key")).await.0,
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                call(&s, Some('c'), method, intent("key")).await.0,
                StatusCode::FORBIDDEN
            );
        }
        let (status, body) = call(&s, Some('a'), "POST", intent("same-key")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["dry_run"], true);
        assert_eq!(body["provider_verified"], false);
        assert_eq!(body["operation"]["state"], "dry_run");
        assert_eq!(body["request"]["state"], "complete");
        let id = body["request"]["id"].clone();
        assert_eq!(
            call(&s, Some('a'), "POST", intent("same-key")).await.1["request"]["id"],
            id
        );
        assert_eq!(
            call(&s, Some('b'), "POST", intent("same-key")).await.0,
            StatusCode::CONFLICT
        );
        let mut changed = intent("same-key");
        changed["request"]["query"] = json!("Different");
        assert_eq!(
            call(&s, Some('a'), "POST", changed).await.0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(&s, Some('b'), "GET", json!(null)).await.1["requests"][0]["id"],
            id
        );
        assert_eq!(
            s.db.lock()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM events WHERE kind='gimme.request.updated'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        drop(s);
        let restarted = seed(path);
        assert_eq!(
            call(&restarted, Some('a'), "POST", intent("same-key"))
                .await
                .1["request"]["id"],
            id
        );
        restarted
            .db
            .lock()
            .unwrap()
            .execute("DELETE FROM members WHERE user_id='bob'", [])
            .unwrap();
        assert_eq!(
            call(&restarted, Some('b'), "GET", json!(null)).await.0,
            StatusCode::FORBIDDEN
        );
    }
    #[tokio::test]
    async fn accepted_job_survives_restart_without_resubmission_and_never_confirms() {
        let mut responses = discovery();
        responses.push((202,json!({"status":"accepted","job_id":"job-1","poll":"/agent/jobs/job-1","retry_after_ms":100})));
        responses.extend(discovery());
        responses.push((200, json!({"status":"running","retry_after_ms":100})));
        responses.extend(discovery());
        responses.push((200,json!({"status":"complete","result_status":"success","result":{"status":"confirmation_required","movie":{"tmdb_id":42,"title":"Fixture"},"confirm":{"path":"/agent/movies/confirm","body":{"secret":"never-export"}},"url":"http://secret.invalid"}})));
        let (origin, seen, fixture) = fixture(responses);
        let temp = tempfile::NamedTempFile::new().unwrap();
        let path = temp.path().to_str().unwrap();
        let mut s = seed(path);
        s.gimme = Worker::configured(&origin, "fixture-key".into()).unwrap();
        let submitted = call(&s, Some('a'), "POST", intent("persisted-key")).await.1;
        let id = submitted["request"]["id"].as_str().unwrap().to_owned();
        assert_eq!(submitted["request"]["state"], "queued");
        s.gimme.tick(&s.db).await.unwrap();
        assert_eq!(load(&s.db.lock().unwrap(), &id).unwrap().state, "pending");
        drop(s);
        let mut restarted = seed(path);
        restarted.gimme = Worker::configured(&origin, "fixture-key".into()).unwrap();
        recover(&restarted.db).unwrap();
        due(&restarted);
        restarted.gimme.tick(&restarted.db).await.unwrap();
        due(&restarted);
        restarted.gimme.tick(&restarted.db).await.unwrap();
        let body = call(&restarted, Some('b'), "GET", json!(null)).await.1;
        assert_eq!(body["requests"][0]["state"], "complete");
        assert_eq!(body["requests"][0]["confirmation_required"], true);
        assert_eq!(body["requests"][0]["provider_job_id"], "job-1");
        assert!(!body.to_string().contains("never-export"));
        assert!(!body.to_string().contains("secret.invalid"));
        fixture.join().unwrap();
        let requests = seen.lock().unwrap();
        assert_eq!(
            requests.iter().filter(|r| r.starts_with("POST ")).count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|r| r.starts_with("GET /agent/jobs/job-1"))
                .count(),
            2
        );
        assert!(requests.iter().all(|r| !r.contains("/confirm")));
        assert!(requests
            .iter()
            .all(|r| r.to_ascii_lowercase().contains("x-api-key: fixture-key")));
        assert!(requests[2]
            .to_ascii_lowercase()
            .contains("idempotency-key: persisted-key"));
    }
    #[tokio::test]
    async fn poll_failure_preserves_job_and_crash_uncertainty_never_resubmits() {
        let mut responses = discovery();
        responses.push((
            202,
            json!({"status":"accepted","job_id":"saved-job","poll":"/agent/jobs/saved-job"}),
        ));
        responses.extend(discovery());
        responses.push((401, json!({"code":"unauthorized","retryable":false})));
        let (origin, seen, fixture) = fixture(responses);
        let mut s = seed(":memory:");
        s.gimme = Worker::configured(&origin, "fixture-key".into()).unwrap();
        let body = call(&s, Some('a'), "POST", intent("safe-key")).await.1;
        let id = body["request"]["id"].as_str().unwrap();
        s.gimme.tick(&s.db).await.unwrap();
        due(&s);
        s.gimme.tick(&s.db).await.unwrap();
        s.gimme.tick(&s.db).await.unwrap();
        fixture.join().unwrap();
        let r = load(&s.db.lock().unwrap(), id).unwrap();
        assert_eq!(r.state, "failed");
        assert_eq!(r.job.unwrap().job_id, "saved-job");
        assert!(r.outcome_unknown);
        assert!(!r.retryable);
        assert_eq!(
            seen.lock()
                .unwrap()
                .iter()
                .filter(|r| r.starts_with("POST "))
                .count(),
            1
        );
        let body = call(&s, Some('a'), "POST", intent("crashed-key")).await.1;
        let id = body["request"]["id"].as_str().unwrap();
        s.db.lock()
            .unwrap()
            .execute(
                "UPDATE gimme_requests SET submission_started=1 WHERE id=?1",
                [id],
            )
            .unwrap();
        recover(&s.db).unwrap();
        let r = load(&s.db.lock().unwrap(), id).unwrap();
        assert_eq!(r.error_code.as_deref(), Some("submission_outcome_unknown"));
        assert!(r.outcome_unknown);
        s.gimme.tick(&s.db).await.unwrap();
    }
    #[tokio::test]
    async fn queue_is_bounded_and_revocation_prevents_provider_access() {
        let mut s = seed(":memory:");
        s.gimme = Worker::configured("http://127.0.0.1:9", "unused".into()).unwrap();
        for n in 0..MAX_USER_ACTIVE {
            assert_eq!(
                call(&s, Some('a'), "POST", intent(&format!("key-{n}")))
                    .await
                    .0,
                StatusCode::OK
            );
        }
        assert_eq!(
            call(&s, Some('a'), "POST", intent("overflow")).await.0,
            StatusCode::TOO_MANY_REQUESTS
        );
        s.db.lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE id='alice'", [])
            .unwrap();
        s.gimme.tick(&s.db).await.unwrap();
        let db = s.db.lock().unwrap();
        let code: String = db
            .query_row(
                "SELECT error_code FROM gimme_requests WHERE state='failed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(code, "authorization_revoked");
        assert!(Worker::configured("http://api.littleobelisk.com", "key".into()).is_err());
        assert!(Worker::configured("https://api.example.com/path", "key".into()).is_err());
    }
    #[test]
    fn safe_projection_preserves_search_uncertainty_without_private_fields() {
        let raw = json!({"status":"no_torrent_found","search_summary":{"backends":[{"state":"timed_out"}]},"movie":{"title":"fixture-key title","tmdb_id":12},"private_path":"/secret","confirm":{"path":"/agent/movies/confirm"}});
        let mut view = public_result(&raw);
        redact(&mut view, "fixture-key");
        assert_eq!(view["search_uncertain"], true);
        assert!(!view.to_string().contains("fixture-key"));
        assert!(!view.to_string().contains("/secret"));
        assert!(view.get("confirm").is_none());
        assert!(!uncertain_summary(
            &json!({"complete":true,"pending":0,"errors":[]})
        ));
        assert!(uncertain_summary(&json!({"complete":false})));
    }
}
