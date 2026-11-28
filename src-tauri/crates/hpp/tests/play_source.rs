//! Offline checks for the built-in play-source integration:
//! extension-method passthrough, edge envelope unwrapping and the healthy-data
//! judge. A local axum stub stands in for the upstream; no real network egress.

use axum::{body::Body, extract::State, http::{Method, Response, Uri}, routing::any, Router};
use hghub_hpp::PluginManager;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

type Requests = Arc<Mutex<Vec<(String, Value)>>>;

async fn stub(State(seen): State<Requests>, _method: Method, uri: Uri, body: axum::body::Bytes) -> Response<Body> {
    let envelope: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    seen.lock().unwrap().push((uri.path().to_string(), envelope.clone()));
    let response = match uri.path() {
        "/api/edge/request" => {
            // Echo the envelope's declared status; the stub ignores the
            // base64 payload (decoding is exercised by the sandbox codec).
            let status = envelope.get("status").and_then(|v| v.as_i64()).unwrap_or(1);
            if status == 0 {
                json!({"status": 0, "msg": "denied"})
            } else {
                json!({"status": 1, "data": {
                    "items": [{"id": 7, "title": "测试影片"}],
                    "pagination": {"page": 1, "size": 1, "pages": 1, "total": 1}
                }})
            }
        }
        _ => json!({"status": 1, "data": null}),
    };
    Response::builder()
        .header("content-type", "application/json")
        .body(Body::from(response.to_string()))
        .unwrap()
}

async fn server() -> (String, Requests, tokio::task::JoinHandle<()>) {
    let seen: Requests = Default::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().route("/*path", any(stub)).with_state(seen.clone());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (base, seen, task)
}

fn fixture_source(base: &str) -> String {
    format!(
        r#"
      export const meta = {{
        id: "fixture.ps", name: "Play Source Fixture", version: "1.0.0", protocol: 1,
        allowInsecureHttp: true,
        extensions: ["x.ping", "x.probe", "x.healthy", "x.probeStatus"]
      }};
      function healthy(data) {{
        if (!data || !Array.isArray(data.items) || !data.pagination) return false;
        const p = data.pagination;
        if (!(Number(p.page) > 0) || !(Number(p.size) > 0)) return false;
        if (!Number.isFinite(Number(p.pages)) || !Number.isFinite(Number(p.total))) return false;
        return data.items.every(it => Number(it && it.id) > 0 && typeof (it && it.title) === "string" && it.title.trim());
      }}
      export default hg => ({{
        endpoints: {{ async list() {{ return [{{id:"main", url:"{base}"}}]; }} }},
        media: {{ async getDetail() {{ return {{id:"x",title:"fixture",playlists:[{{id:"main",episodes:[]}}]}}; }}, async resolvePlayback() {{ return {{streams:[]}}; }} }},
        x: {{
          ping() {{ return {{ viewModel: {{ rows: [1, 2, 3] }}, raw: true }}; }},
          async probe() {{
            const resp = await hg.http.fetch({{
              method: "POST", url: "{base}/api/edge/request",
              headers: {{"Content-Type":"application/json"}},
              body: {{ json: {{ method: "GET", path: "/api/videos?page=1&size=1", body: "", content_type: "" }} }},
              responseType: "json"
            }});
            const env = resp.data;
            if (env.status !== 1) throw new hg.PluginError("UPSTREAM_ERROR", env.msg || "失败");
            return {{ unwrapped: env.data, healthy: healthy(env.data) }};
          }},
          healthy({{data}}) {{ return {{ healthy: healthy(data) }}; }},
          async probeStatus({{status}}) {{
            const resp = await hg.http.fetch({{
              method: "POST", url: "{base}/api/edge/request",
              headers: {{"Content-Type":"application/json"}},
              body: {{ json: {{ method: "GET", path: "/api/videos", body: "", content_type: "", status }} }},
              responseType: "json"
            }});
            const env = resp.data;
            if (env.status !== 1) throw new hg.PluginError("UPSTREAM_ERROR", env.msg || "失败");
            return env.data;
          }}
        }}
      }});
    "#
    )
}

#[tokio::test]
async fn extension_methods_passthrough_and_envelope_unwrap() {
    let (base, seen, task) = server().await;
    let dir = tempfile::tempdir().unwrap();
    let m = PluginManager::with_mode(dir.path().into(), Some(false)).unwrap();
    m.import_code(fixture_source(&base), None, false).await.unwrap();

    let info = m.list().await.into_iter().next().unwrap();
    assert!(info.methods.contains(&"x.ping".to_string()));
    assert!(info.methods.contains(&"x.probe".to_string()));

    // Declared extension view models pass through without protocol validation.
    let ping = m.call("fixture.ps", "x.ping", json!({}), "ping".into()).await.unwrap();
    assert_eq!(ping["viewModel"]["rows"][1], json!(2));

    // Edge envelope: status 1 unwraps `data`; the healthy judge accepts it.
    let probe = m.call("fixture.ps", "x.probe", json!({}), "probe".into()).await.unwrap();
    assert_eq!(probe["unwrapped"]["items"][0]["title"], json!("测试影片"));
    assert_eq!(probe["healthy"], json!(true));

    // Healthy judge rejects HTML/empty/malformed payloads.
    for data in [
        json!(null),
        json!("<html>200 OK</html>"),
        json!({}),
        json!({"status": 0, "msg": "denied"}),
        json!({"items": []}),
        json!({"items": [{}], "pagination": {"page": 1, "size": 1, "pages": 1, "total": 1}}),
    ] {
        let verdict = m.call("fixture.ps", "x.healthy", json!({"data": data}), "h".into()).await.unwrap();
        assert_eq!(verdict["healthy"], json!(false), "rejected: {data}");
    }

    // The envelope POST carries method/path/body/content_type to the controlled network.
    let requests = seen.lock().unwrap().clone();
    let edge = requests.iter().find(|(p, _)| p == "/api/edge/request").unwrap();
    assert_eq!(edge.1["method"], json!("GET"));
    assert_eq!(edge.1["path"], json!("/api/videos?page=1&size=1"));
    assert_eq!(edge.1["content_type"], json!(""));

    // Error envelope (status 0) surfaces as UPSTREAM_ERROR with the upstream msg.
    let denied = m.call("fixture.ps", "x.probeStatus", json!({"status": 0}), "denied".into()).await;
    let err = denied.unwrap_err();
    assert_eq!(err.code, "UPSTREAM_ERROR");
    assert_eq!(err.message, "denied");
    task.abort();
}

#[tokio::test]
async fn builtin_play_source_is_seeded_and_cannot_be_removed() {
    let dir = tempfile::tempdir().unwrap();
    let m = PluginManager::open_seeded(dir.path().into()).unwrap();
    let list = m.list().await;
    let builtin = list.iter().find(|p| p.meta.id == "play-source").expect("builtin seeded");
    assert!(builtin.built_in);
    assert!(builtin.methods.iter().any(|x| x == "media.resolvePlayback"));
    assert!(builtin.methods.iter().any(|x| x == "lines.state"));
    assert!(builtin.methods.iter().any(|x| x == "skyhome.feed"));
    for method in [
        "lines.addFixed", "lines.updateFixed", "lines.removeFixed",
        "lines.addMirror", "lines.removeMirror",
        "lines.addPublishPage", "lines.removePublishPage", "lines.reset",
    ] {
        assert!(builtin.methods.iter().any(|x| x == method), "missing {method}");
    }
    assert_eq!(builtin.settings["homeMode"], json!("default"));
    assert_eq!(builtin.settings["categoryMode"], json!("default"));

    // Seeded state exposes the persisted fixed-line list; the shipped default
    // origin is present until the user resets or edits it.
    let state = m.call("play-source", "lines.state", json!({}), "state".into()).await.unwrap();
    let fixed = state["fixed"].as_array().expect("fixed is an array");
    assert!(fixed.iter().any(|f| f["url"] == json!("https://huangguoai.com")));
    assert!(state["mirrors"].is_array());
    assert!(state["custom"].is_array());

    let removal = m.remove("play-source").await;
    assert!(removal.is_err());
    assert_eq!(removal.unwrap_err().code, "INVALID_ARGUMENT");

    // Reopening keeps the seeded entry (user state preserved across restarts).
    drop(m);
    let reopened = PluginManager::open_seeded(dir.path().into()).unwrap();
    assert!(reopened.list().await.iter().any(|p| p.meta.id == "play-source"));
}

#[tokio::test]
async fn line_origin_validation_follows_classified_rules() {
    let dir = tempfile::tempdir().unwrap();
    let m = PluginManager::open_seeded(dir.path().into()).unwrap();

    let add = |url: &str| m.call("play-source", "lines.addFixed", json!({"url": url}), "v".into());

    // Navigation host is allowed to be added; the probe layer only hints later.
    let ok = add("https://huangguoai.ai").await.unwrap();
    assert!(ok["items"].as_array().unwrap().iter().any(|f| f["url"] == json!("https://huangguoai.ai")));

    // Explicit non-default port and a path prefix are preserved on the base.
    let ok = add("https://example.com:8443/prefix/").await.unwrap();
    assert!(ok["items"].as_array().unwrap().iter().any(|f| f["url"] == json!("https://example.com:8443/prefix")));

    // IDN hostnames are accepted: the stored base is punycode, the display
    // keeps the original Unicode host.
    let ok = add("https://例子.com").await.unwrap();
    let idn = ok["items"].as_array().unwrap().iter()
        .find(|f| f["url"].as_str().unwrap().starts_with("https://xn--"))
        .expect("IDN normalized to punycode");
    assert!(idn["url"].as_str().unwrap().contains("xn--"));
    assert_eq!(idn["host"].as_str().unwrap(), "例子.com");

    // Plain HTTP is rejected.
    let err = add("http://example.com").await.unwrap_err();
    assert_eq!(err.code, "INVALID_ARGUMENT");
    assert_eq!(err.message, "仅支持 HTTPS 线路");

    // IP literals and localhost are rejected.
    for bad in ["https://127.0.0.1", "https://localhost", "https://10.0.0.5"] {
        let err = add(bad).await.unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
        assert_eq!(err.message, "不允许内网、IP 或 localhost 线路", "{bad}");
    }

    // Duplicate fixed line is rejected with a group-specific reason.
    let err = add("https://example.com:8443/prefix").await.unwrap_err();
    assert_eq!(err.code, "INVALID_ARGUMENT");
    assert_eq!(err.message, "该线路已在固定线路中");
}

#[tokio::test]
async fn publish_pages_are_persisted_with_add_remove_and_dedup() {
    let dir = tempfile::tempdir().unwrap();
    let m = PluginManager::open_seeded(dir.path().into()).unwrap();

    let state = m.call("play-source", "lines.state", json!({}), "state".into()).await.unwrap();
    let defaults = state["pages"].as_array().expect("pages array");
    assert!(defaults.len() >= 2, "shipped default publish pages present");

    let add = |url: &str| m.call("play-source", "lines.addPublishPage", json!({"url": url}), "pg".into());
    let added = add("https://example.pages.dev/").await.unwrap();
    let items = added["items"].as_array().unwrap();
    assert!(items.iter().any(|x| x.as_str() == Some("https://example.pages.dev")));

    let dup = add("https://example.pages.dev/").await.unwrap_err();
    assert_eq!(dup.code, "INVALID_ARGUMENT");
    assert_eq!(dup.message, "该发布页已在列表中");

    let removed = m
        .call("play-source", "lines.removePublishPage", json!({"url": "https://example.pages.dev/"}), "pg".into())
        .await
        .unwrap();
    assert!(!removed["items"].as_array().unwrap().iter().any(|x| x.as_str() == Some("https://example.pages.dev")));

    // Reopening keeps the persisted list.
    drop(m);
    let reopened = PluginManager::open_seeded(dir.path().into()).unwrap();
    let state = reopened.call("play-source", "lines.state", json!({}), "state".into()).await.unwrap();
    assert!(!state["pages"].as_array().unwrap().iter().any(|x| x.as_str() == Some("https://example.pages.dev")));
}

#[tokio::test]
async fn custom_lines_carry_optional_labels() {
    let dir = tempfile::tempdir().unwrap();
    let m = PluginManager::open_seeded(dir.path().into()).unwrap();

    // A custom line with a user label keeps it; the URL-only dedup still works.
    let added = m.call("play-source", "lines.addCustom", json!({"url": "https://example.com", "label": "我的线路"}), "c".into()).await.unwrap();
    let item = added["items"].as_array().unwrap().iter().find(|c| c["url"] == json!("https://example.com")).unwrap();
    assert_eq!(item["label"], json!("我的线路"));

    // Without a label the host is used as the default label.
    let added = m.call("play-source", "lines.addCustom", json!({"url": "https://mirror.example.net"}), "c".into()).await.unwrap();
    let item = added["items"].as_array().unwrap().iter().find(|c| c["url"] == json!("https://mirror.example.net")).unwrap();
    assert_eq!(item["label"], json!("mirror.example.net"));

    // lines.state exposes custom entries as { url, label } objects.
    let state = m.call("play-source", "lines.state", json!({}), "s".into()).await.unwrap();
    let c = state["custom"].as_array().unwrap().iter().find(|c| c["url"] == json!("https://example.com")).unwrap();
    assert_eq!(c["label"], json!("我的线路"));

    // Editing the label in place (same URL) is allowed.
    let up = m.call("play-source", "lines.updateCustom", json!({"oldUrl": "https://example.com", "newUrl": "https://example.com", "label": "改名"}), "c".into()).await.unwrap();
    let item = up["items"].as_array().unwrap().iter().find(|c| c["url"] == json!("https://example.com")).unwrap();
    assert_eq!(item["label"], json!("改名"));

    // Duplicate custom URL is still rejected with the group-specific reason.
    let dup = m.call("play-source", "lines.addCustom", json!({"url": "https://example.com"}), "c".into()).await.unwrap_err();
    assert_eq!(dup.code, "INVALID_ARGUMENT");
    assert_eq!(dup.message, "该线路已在自定义线路中");

    // Labels persist across restarts.
    drop(m);
    let reopened = PluginManager::open_seeded(dir.path().into()).unwrap();
    let state = reopened.call("play-source", "lines.state", json!({}), "s".into()).await.unwrap();
    let c = state["custom"].as_array().unwrap().iter().find(|c| c["url"] == json!("https://example.com")).unwrap();
    assert_eq!(c["label"], json!("改名"));
}

#[tokio::test]
async fn probe_is_read_only_and_stamps_result_time() {
    let dir = tempfile::tempdir().unwrap();
    let m = PluginManager::open_seeded(dir.path().into()).unwrap();

    let before = m.call("play-source", "lines.state", json!({}), "state".into()).await.unwrap();
    let base_before = before["base"].as_str().unwrap().to_owned();

    // A rejected origin fails validation before any network call; the probe
    // still returns a classified failure with a timestamp.
    let out = m
        .call("play-source", "lines.probe", json!({"urls": ["http://example.com"]}), "probe".into())
        .await
        .unwrap();
    let hit = &out["items"][0];
    assert_eq!(hit["ok"], json!(false));
    assert!(hit["at"].as_i64().unwrap() > 0);
    assert_eq!(hit["error"].as_str().unwrap(), "仅支持 HTTPS 线路");

    // Probing never switches the current line or writes a current/lastGood key.
    let after = m.call("play-source", "lines.state", json!({}), "state".into()).await.unwrap();
    assert_eq!(after["base"].as_str().unwrap(), base_before);
}

