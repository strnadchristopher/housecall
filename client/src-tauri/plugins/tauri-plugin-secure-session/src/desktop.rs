//! Desktop storage in the OS credential store (Keychain, Credential Manager, Secret Service).
//! The `keyring` crate cannot enumerate entries, so the list of origins is one more entry.
use serde_json::Value;
use std::sync::Mutex;

const SERVICE: &str = "com.mapleavenuelabs.housecall.session";
const INDEX: &str = "__origins__";
const UNAVAILABLE: &str = "secure storage unavailable";
/// Index reads and writes are read-modify-write; serialize them inside this process.
static INDEX_LOCK: Mutex<()> = Mutex::new(());

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|_| UNAVAILABLE.to_string())
}
fn read(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(UNAVAILABLE.into()),
    }
}
fn read_index() -> Result<Vec<String>, String> {
    Ok(read(INDEX)?
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default())
}
fn write_index(origins: &[String]) -> Result<(), String> {
    let raw = serde_json::to_string(origins).map_err(|_| UNAVAILABLE.to_string())?;
    entry(INDEX)?.set_password(&raw).map_err(|_| UNAVAILABLE.into())
}

pub fn stored(origin: &str) -> Result<Option<Value>, String> {
    Ok(read(origin)?.and_then(|raw| serde_json::from_str(&raw).ok()))
}

pub fn store(origin: &str, session: &Value) -> Result<(), String> {
    let _guard = INDEX_LOCK.lock().map_err(|_| UNAVAILABLE.to_string())?;
    entry(origin)?
        .set_password(&session.to_string())
        .map_err(|_| UNAVAILABLE.to_string())?;
    let mut origins = read_index()?;
    origins.retain(|known| known != origin);
    origins.insert(0, origin.to_owned());
    origins.truncate(10);
    write_index(&origins)
}

pub fn forget(origin: &str) -> Result<(), String> {
    let _guard = INDEX_LOCK.lock().map_err(|_| UNAVAILABLE.to_string())?;
    match entry(origin)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err(UNAVAILABLE.into()),
    }
    let mut origins = read_index()?;
    origins.retain(|known| known != origin);
    write_index(&origins)
}

pub fn origins() -> Result<Vec<String>, String> {
    read_index()
}
