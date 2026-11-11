//! PMS requests keep the Plex token in an HTTP header on the server.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use url::Url;

pub struct Plex {
    origin: Url,
    token: String,
    client: reqwest::Client,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Library {
    pub id: String,
    pub title: String,
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub duration_ms: u64,
    pub subtitles: Vec<Subtitle>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subtitle {
    pub id: String,
    pub language: String,
    pub codec: String,
    pub embedded: bool,
}
impl Plex {
    pub fn new(origin: &str, token: String) -> Result<Self> {
        if token.is_empty() {
            return Err(Error::Invalid("Plex token"));
        }
        Ok(Self {
            origin: crate::origin(origin)?,
            token,
            client: crate::http()?,
        })
    }
    fn get(&self, path: &str) -> Result<reqwest::RequestBuilder> {
        let url = self
            .origin
            .join(path)
            .map_err(|_| Error::Invalid("Plex path"))?;
        if url.origin() != self.origin.origin() {
            return Err(Error::Invalid("Plex origin"));
        }
        Ok(self
            .client
            .get(url)
            .header("X-Plex-Token", &self.token)
            .header("X-Plex-Client-Identifier", "housecall-server")
            .header("X-Plex-Product", "Housecall")
            .header("Accept", "application/json"))
    }
    pub async fn libraries(&self) -> Result<Vec<Library>> {
        let json: serde_json::Value = crate::read_json(
            self.get("/library/sections")?
                .send()
                .await
                .map_err(|_| Error::Provider)?
                .error_for_status()
                .map_err(|_| Error::Provider)?,
            2 * 1024 * 1024,
        )
        .await?;
        json["MediaContainer"]["Directory"]
            .as_array()
            .ok_or(Error::Provider)?
            .iter()
            .map(|v| {
                let id = v["key"].as_str().ok_or(Error::Provider)?;
                numeric(id)?;
                Ok(Library {
                    id: id.to_owned(),
                    title: v["title"].as_str().unwrap_or("").to_owned(),
                    kind: v["type"].as_str().unwrap_or("").to_owned(),
                })
            })
            .collect()
    }
    pub async fn browse(&self, library_id: &str, start: u64) -> Result<Vec<Item>> {
        numeric(library_id)?;
        let json: serde_json::Value = crate::read_json(
            self.get(&format!("/library/sections/{library_id}/all"))?
                .query(&[
                    ("X-Plex-Container-Start", start.to_string()),
                    ("X-Plex-Container-Size", "100".to_owned()),
                ])
                .send()
                .await
                .map_err(|_| Error::Provider)?
                .error_for_status()
                .map_err(|_| Error::Provider)?,
            2 * 1024 * 1024,
        )
        .await?;
        json["MediaContainer"]["Metadata"]
            .as_array()
            .ok_or(Error::Provider)?
            .iter()
            .map(parse_item)
            .collect()
    }
    pub async fn metadata(&self, id: &str) -> Result<Item> {
        numeric(id)?;
        let json: serde_json::Value = crate::read_json(
            self.get(&format!("/library/metadata/{id}"))?
                .send()
                .await
                .map_err(|_| Error::Provider)?
                .error_for_status()
                .map_err(|_| Error::Provider)?,
            2 * 1024 * 1024,
        )
        .await?;
        parse_item(&json["MediaContainer"]["Metadata"][0])
    }
    /// Return upstream to an authorized media proxy. Never redirect clients to PMS.
    /// HLS manifests need same-origin URI rewriting and per-segment authorization by the caller.
    pub async fn transcode(
        &self,
        media_id: &str,
        session_id: &str,
        offset_ms: u64,
        subtitle_id: Option<&str>,
    ) -> Result<reqwest::Response> {
        numeric(media_id)?;
        if session_id.is_empty()
            || session_id.len() > 128
            || !session_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(Error::Invalid("Plex session"));
        }
        if let Some(id) = subtitle_id {
            numeric(id)?;
        }
        let mut query = vec![
            ("path", format!("/library/metadata/{media_id}")),
            ("session", session_id.to_owned()),
            ("protocol", "hls".to_owned()),
            ("directPlay", "0".to_owned()),
            ("directStream", "0".to_owned()),
            ("offset", (offset_ms / 1000).to_string()),
            ("mediaIndex", "0".to_owned()),
            ("partIndex", "0".to_owned()),
            ("videoCodec", "h264".to_owned()),
            ("audioCodec", "aac".to_owned()),
            ("maxVideoBitrate", "20000".to_owned()),
            ("videoResolution", "1920x1080".to_owned()),
            ("subtitleSize", "100".to_owned()),
        ];
        if let Some(id) = subtitle_id {
            query.push(("subtitleStreamID", id.to_owned()));
            query.push(("subtitles", "burn".to_owned()));
        }
        self.get("/video/:/transcode/universal/start.m3u8")?
            .query(&query)
            .send()
            .await
            .map_err(|_| Error::Provider)?
            .error_for_status()
            .map_err(|_| Error::Provider)
    }
    pub async fn subtitle(&self, id: &str) -> Result<reqwest::Response> {
        numeric(id)?;
        self.get(&format!("/library/streams/{id}"))?
            .query(&[("format", "srt")])
            .send()
            .await
            .map_err(|_| Error::Provider)?
            .error_for_status()
            .map_err(|_| Error::Provider)
    }
}
fn numeric(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_digit()) {
        Err(Error::Invalid("Plex numeric id"))
    } else {
        Ok(())
    }
}
fn parse_item(v: &serde_json::Value) -> Result<Item> {
    let id = v["ratingKey"].as_str().ok_or(Error::Provider)?;
    numeric(id)?;
    let mut subtitles = Vec::new();
    if let Some(media) = v["Media"].as_array() {
        for m in media {
            if let Some(parts) = m["Part"].as_array() {
                for part in parts {
                    if let Some(streams) = part["Stream"].as_array() {
                        for s in streams
                            .iter()
                            .filter(|s| s["streamType"].as_u64() == Some(3))
                        {
                            let sid = s["id"]
                                .as_u64()
                                .map(|id| id.to_string())
                                .or_else(|| s["id"].as_str().map(str::to_owned))
                                .ok_or(Error::Provider)?;
                            numeric(&sid)?;
                            subtitles.push(Subtitle {
                                id: sid,
                                language: s["language"].as_str().unwrap_or("Unknown").to_owned(),
                                codec: s["codec"].as_str().unwrap_or("").to_owned(),
                                embedded: s.get("key").is_none(),
                            });
                        }
                    }
                }
            }
        }
    }
    Ok(Item {
        id: id.to_owned(),
        title: v["title"].as_str().unwrap_or("").to_owned(),
        kind: v["type"].as_str().unwrap_or("").to_owned(),
        duration_ms: v["duration"].as_u64().unwrap_or(0),
        subtitles,
    })
}

/// A manifest resource validated against the configured Plex origin and transcode path.
/// URLs stay server-side; expose only an application-issued opaque resource identifier.
#[derive(Clone, Debug)]
pub struct Resource {
    pub url: Url,
    pub playlist: bool,
}
impl Plex {
    pub fn resource(&self, base: &Url, reference: &str, playlist: bool) -> Result<Resource> {
        if reference.is_empty() || reference.len() > 8192 || reference.chars().any(char::is_control)
        {
            return Err(Error::Invalid("Plex resource URI"));
        }
        let mut url = base
            .join(reference)
            .map_err(|_| Error::Invalid("Plex resource URI"))?;
        if url.origin() != self.origin.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !(url.path() == "/video/:/transcode/universal/start.m3u8"
                || url
                    .path()
                    .starts_with("/video/:/transcode/universal/session/")
                || url
                    .path()
                    .strip_prefix("/library/streams/")
                    .is_some_and(|id| numeric(id).is_ok()))
            || url.path().contains('%')
            || url.path().to_ascii_lowercase().contains("%5c")
            || url.path().to_ascii_lowercase().contains("%2e")
        {
            return Err(Error::Invalid("Plex resource origin or path"));
        }
        let query: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(key, _)| !key.eq_ignore_ascii_case("x-plex-token"))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        url.set_query(None);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let playlist = playlist || url.path().ends_with(".m3u8") || url.path().ends_with(".m3u");
        Ok(Resource { url, playlist })
    }
    pub async fn fetch(
        &self,
        resource: &Resource,
        range: Option<&str>,
    ) -> Result<reqwest::Response> {
        let resource = self.resource(&resource.url, resource.url.as_str(), resource.playlist)?;
        let mut request = self.get(resource.url.as_str())?;
        if let Some(range) = range {
            let interval = range
                .strip_prefix("bytes=")
                .and_then(|v| v.split_once('-'))
                .ok_or(Error::Invalid("Plex byte range"))?;
            let start: u64 = interval
                .0
                .parse()
                .map_err(|_| Error::Invalid("Plex byte range"))?;
            if range.len() > 64 {
                return Err(Error::Invalid("Plex byte range"));
            }
            if !interval.1.is_empty() {
                let end: u64 = interval
                    .1
                    .parse()
                    .map_err(|_| Error::Invalid("Plex byte range"))?;
                if end < start || end - start >= 64 * 1024 * 1024 {
                    return Err(Error::Invalid("Plex byte range"));
                }
            }
            request = request.header(reqwest::header::RANGE, range);
        }
        let response = request.send().await.map_err(|_| Error::Provider)?;
        if !response.status().is_success() {
            return Err(Error::Provider);
        }
        Ok(response)
    }
    pub async fn stop(&self, session_id: &str) -> Result<()> {
        if session_id.is_empty()
            || session_id.len() > 128
            || !session_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(Error::Invalid("Plex session"));
        }
        self.get("/video/:/transcode/universal/stop")?
            .query(&[("session", session_id)])
            .send()
            .await
            .map_err(|_| Error::Provider)?
            .error_for_status()
            .map_err(|_| Error::Provider)?;
        Ok(())
    }
    fn manifest_resource(&self, base: &Url, reference: &str, playlist: bool) -> Result<Resource> {
        let resource = self.resource(base, reference, playlist)?;
        if resource.url.path() == "/video/:/transcode/universal/start.m3u8" {
            return Err(Error::Invalid("HLS cannot invoke Plex control endpoints"));
        }
        Ok(resource)
    }
    /// Rewrite every URI line and URI-valued attribute (including keys, maps, subtitles,
    /// alternate renditions and nested playlists). Reject external origins and malformed grammar.
    /// `register` must return a local path and bound its opaque-resource registry.
    pub fn rewrite_manifest<F>(&self, text: &str, base: &Url, mut register: F) -> Result<String>
    where
        F: FnMut(Resource) -> Result<String>,
    {
        if text.len() > 1024 * 1024 || text.lines().next() != Some("#EXTM3U") || text.contains('\0')
        {
            return Err(Error::Invalid("Plex HLS manifest"));
        }
        let mut out = String::new();
        let mut next_playlist = false;
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let rewritten = if !line.starts_with('#') {
                let local = register(self.manifest_resource(base, line, next_playlist)?)?;
                next_playlist = false;
                local_uri(local)?
            } else if line.contains("URI=") {
                let (tag, attrs) = line
                    .split_once(':')
                    .ok_or(Error::Invalid("Plex HLS attributes"))?;
                let mut encoded = Vec::new();
                for attr in attributes(attrs)? {
                    let (key, value) = attr
                        .split_once('=')
                        .ok_or(Error::Invalid("Plex HLS attribute"))?;
                    if key.is_empty()
                        || !key
                            .bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
                    {
                        return Err(Error::Invalid("Plex HLS attribute"));
                    }
                    if key == "URI" || key.ends_with("-URI") {
                        let value = value
                            .strip_prefix('"')
                            .and_then(|v| v.strip_suffix('"'))
                            .ok_or(Error::Invalid("Plex HLS URI quoting"))?;
                        let playlist = matches!(
                            tag,
                            "#EXT-X-MEDIA"
                                | "#EXT-X-I-FRAME-STREAM-INF"
                                | "#EXT-X-RENDITION-REPORT"
                        );
                        let local =
                            local_uri(register(self.manifest_resource(base, value, playlist)?)?)?;
                        encoded.push(format!("{key}=\"{local}\""));
                    } else {
                        encoded.push(attr.to_owned());
                    }
                }
                format!("{tag}:{}", encoded.join(","))
            } else if line.starts_with("#EXT") {
                if line.starts_with("#EXT-X-STREAM-INF:") {
                    next_playlist = true;
                }
                line.to_owned()
            } else {
                continue;
            }; // Strip provider comments, which can contain private URLs.
               // No origin or token may leak through non-URI metadata attributes/comments.
            if rewritten.contains("://")
                || rewritten.contains(&self.token)
                || rewritten.chars().any(|c| c.is_control())
            {
                return Err(Error::Invalid("Plex HLS private metadata"));
            }
            out.push_str(&rewritten);
            out.push('\n');
        }
        Ok(out)
    }
}
fn local_uri(value: String) -> Result<String> {
    if !value.starts_with("/api/") || value.contains(['"', '\n', '\r', '\\', '?', '#']) {
        return Err(Error::Invalid("HLS proxy URI"));
    }
    Ok(value)
}
fn attributes(value: &str) -> Result<Vec<&str>> {
    let mut quoted = false;
    let mut start = 0;
    let mut result = Vec::new();
    for (index, c) in value.char_indices() {
        match c {
            '"' => quoted = !quoted,
            '\\' | '\r' | '\n' => return Err(Error::Invalid("HLS attribute escaping")),
            ',' if !quoted => {
                result.push(value[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }
    if quoted {
        return Err(Error::Invalid("HLS unclosed quote"));
    }
    result.push(value[start..].trim());
    if result.len() > 64 {
        return Err(Error::Invalid("HLS attribute count"));
    }
    Ok(result)
}
