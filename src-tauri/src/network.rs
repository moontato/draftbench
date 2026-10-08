use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkError {
    pub kind: String,
    pub message: String,
    pub status: Option<u16>,
}
impl NetworkError {
    pub fn new(kind: &str, message: &str, status: Option<u16>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
            status,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub id: String,
    pub server_url: String,
    pub route: String,
    pub body: Option<Value>,
    pub timeout_ms: u64,
    #[serde(default)]
    pub credential_ref: Option<String>,
}
pub fn credential_reference(reference: Option<&str>) -> Result<String, NetworkError> {
    let reference = reference.unwrap_or("openai-compatible");
    let valid_backend = reference.strip_prefix("backend:").is_some_and(|id| {
        !id.is_empty()
            && id.len() <= 64
            && id.as_bytes()[0].is_ascii_lowercase()
            && id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    });
    if reference.is_empty() || reference == "openai-compatible" || valid_backend {
        Ok(reference.into())
    } else {
        Err(NetworkError::new(
            "configuration",
            "Invalid backend credential reference.",
            None,
        ))
    }
}

fn request_timeout(timeout_ms: u64) -> Duration {
    Duration::from_millis(timeout_ms.clamp(1000, 30 * 60 * 1000))
}

pub fn endpoint(server: &str, route: &str) -> Result<reqwest::Url, NetworkError> {
    if !matches!(route, "models" | "chat/completions") {
        return Err(NetworkError::new(
            "unsupported",
            "Unsupported API route",
            None,
        ));
    }
    let mut url = reqwest::Url::parse(server).map_err(|_| {
        NetworkError::new(
            "configuration",
            "Enter a valid HTTP or HTTPS server URL.",
            None,
        )
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(NetworkError::new(
            "configuration",
            "Use HTTP or HTTPS without embedded credentials.",
            None,
        ));
    }
    url.set_query(None);
    url.set_fragment(None);
    let base = url.path().trim_end_matches('/');
    let path = if base.ends_with("/v1") {
        format!("{base}/{route}")
    } else {
        format!("{base}/v1/{route}")
    };
    url.set_path(&path);
    Ok(url)
}

pub async fn execute(
    request: &HttpRequest,
    key: Option<String>,
    cancel: CancellationToken,
) -> Result<Value, NetworkError> {
    if cancel.is_cancelled() {
        return Err(NetworkError::new("cancelled", "Request cancelled.", None));
    }
    let url = endpoint(&request.server_url, &request.route)?;
    // No redirects: private document content and keys must never be forwarded to another host.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(request_timeout(request.timeout_ms))
        .build()
        .map_err(|_| NetworkError::new("network", "Could not initialize native HTTP.", None))?;
    let mut builder = if request.body.is_some() {
        client.post(url)
    } else {
        client.get(url)
    };
    if let Some(key) = key.filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(key);
    }
    if let Some(body) = &request.body {
        builder = builder.json(body);
    }
    let operation = async {
        let mut response = builder.send().await.map_err(classify_transport)?;
        let status = response.status().as_u16();
        let mut bytes = vec![];
        while let Some(chunk) = response.chunk().await.map_err(classify_transport)? {
            if bytes.len() + chunk.len() > 2_000_000 {
                return Err(NetworkError::new(
                    "malformed",
                    "Server response exceeds the size limit.",
                    Some(status),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if !(200..300).contains(&status) {
            let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            // Do not display server echoes (they can include the user's prompt or credentials).
            let detail = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let (kind, message) = if status == 401 || status == 403 {
                (
                    "authentication",
                    "Authentication failed. Check the API key and server access policy.",
                )
            } else if (status == 400 || status == 404)
                && detail.contains("model")
                && (detail.contains("not found")
                    || detail.contains("unavailable")
                    || detail.contains("does not exist"))
            {
                (
                    "model",
                    "The configured model is not available on this server.",
                )
            } else if status == 400
                && (detail.contains("response_format") || detail.contains("json_schema"))
            {
                (
                    "format_unsupported",
                    "This server does not support the requested structured-output format.",
                )
            } else if status == 404 || status == 405 || status == 501 {
                ("unsupported", "API endpoint unsupported, or the server did not identify the missing model. Check the API base URL.")
            } else if status == 429 {
                (
                    "rate_limit",
                    "The server is busy or rate-limited. Try again later.",
                )
            } else {
                ("server", "The inference server returned an error.")
            };
            return Err(NetworkError::new(kind, message, Some(status)));
        }
        serde_json::from_slice(&bytes).map_err(|_| {
            NetworkError::new("malformed", "Server returned malformed JSON.", Some(status))
        })
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(NetworkError::new("cancelled", "Request cancelled.", None)),
        result = operation => result,
    }
}
fn classify_transport(error: reqwest::Error) -> NetworkError {
    if error.is_timeout() {
        NetworkError::new(
            "timeout",
            "Server timed out. Increase the timeout or check server load.",
            None,
        )
    } else if error.is_connect() {
        NetworkError::new(
            "unreachable",
            "Server unreachable. Check address, server binding, firewall, DNS, or TLS certificate.",
            None,
        )
    } else {
        NetworkError::new("network", "Native HTTP request failed.", None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_slots_preserve_legacy_but_isolate_backends() {
        assert_eq!(credential_reference(None).unwrap(), "openai-compatible");
        assert_eq!(
            credential_reference(Some("backend:gpu-1")).unwrap(),
            "backend:gpu-1"
        );
        assert_eq!(credential_reference(Some("")).unwrap(), "");
        for value in [
            "another-account",
            "backend:../secret",
            "backend:",
            "backend:UPPER",
            "backend:bad\n",
        ] {
            assert!(credential_reference(Some(value)).is_err());
        }
    }
    #[test]
    fn timeout_supports_thirty_minutes() {
        assert_eq!(request_timeout(1_800_000), Duration::from_secs(1800));
        assert_eq!(request_timeout(900_000), Duration::from_secs(900));
        assert_eq!(request_timeout(u64::MAX), Duration::from_secs(1800));
        assert_eq!(request_timeout(0), Duration::from_secs(1));
    }
    #[test]
    fn urls() {
        for host in [
            "http://localhost:8080",
            "http://100.80.40.20:8080",
            "http://gpu.tailnet.ts.net:8080",
            "https://example.org",
        ] {
            assert_eq!(
                endpoint(host, "models").unwrap().as_str(),
                format!("{host}/v1/models")
            );
        }
        assert_eq!(
            endpoint("http://localhost:8080/prefix/v1/", "chat/completions")
                .unwrap()
                .path(),
            "/prefix/v1/chat/completions"
        );
        assert!(endpoint("file:///etc/passwd", "models").is_err());
    }
    async fn mock(status: &str, body: &str, delay: bool) -> String {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0; 8192];
            let _ = socket.read(&mut buf);
            if delay {
                std::thread::sleep(Duration::from_secs(2));
            }
            let _ = socket.write_all(response.as_bytes());
        });
        url
    }
    fn request(url: String) -> HttpRequest {
        HttpRequest {
            id: "test".into(),
            server_url: url,
            route: "models".into(),
            body: None,
            timeout_ms: 1000,
            credential_ref: None,
        }
    }
    #[tokio::test]
    async fn cancelled_and_redirected_requests_never_reach_the_next_host() {
        use std::net::TcpListener;
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let url = format!("http://{}", target.local_addr().unwrap());
        let token = CancellationToken::new();
        token.cancel();
        assert_eq!(
            execute(&request(url.clone()), Some("private-key".into()), token)
                .await
                .unwrap_err()
                .kind,
            "cancelled"
        );
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let source = mock(
            &format!("302 Found\r\nLocation: {url}/v1/models"),
            "{}",
            false,
        )
        .await;
        let error = execute(
            &request(source),
            Some("private-key".into()),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, Some(302));
        assert!(!error.message.contains("private-key"));
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
    #[tokio::test]
    async fn oversized_and_echoing_errors_are_bounded_and_private() {
        let url = mock("200 OK", &"x".repeat(2_000_001), false).await;
        assert_eq!(
            execute(&request(url), None, CancellationToken::new())
                .await
                .unwrap_err()
                .kind,
            "malformed"
        );
        let url = mock(
            "401 Unauthorized",
            r#"{"error":{"message":"private-key private-prose"}}"#,
            false,
        )
        .await;
        let error = execute(
            &request(url),
            Some("private-key".into()),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "authentication");
        assert!(!error.message.contains("private-key"));
        assert!(!error.message.contains("private-prose"));
    }
    #[tokio::test]
    async fn failures_and_success() {
        for (status, body, kind) in [
            ("401 Unauthorized", "{}", "authentication"),
            ("404 Not Found", "{}", "unsupported"),
            (
                "404 Not Found",
                r#"{"error":{"message":"model not found"}}"#,
                "model",
            ),
            ("200 OK", "invalid", "malformed"),
            (
                "400 Bad Request",
                r#"{"error":{"message":"response_format unsupported"}}"#,
                "format_unsupported",
            ),
        ] {
            let url = mock(status, body, false).await;
            assert_eq!(
                execute(&request(url), None, CancellationToken::new())
                    .await
                    .unwrap_err()
                    .kind,
                kind
            );
        }
        let url = mock("200 OK", r#"{"data":[]}"#, false).await;
        assert!(execute(&request(url), None, CancellationToken::new())
            .await
            .is_ok());
        let url = mock("200 OK", "{}", true).await;
        assert_eq!(
            execute(&request(url), None, CancellationToken::new())
                .await
                .unwrap_err()
                .kind,
            "timeout"
        );
        let token = CancellationToken::new();
        token.cancel();
        let url = mock("200 OK", "{}", true).await;
        assert_eq!(
            execute(&request(url), None, token).await.unwrap_err().kind,
            "cancelled"
        );
    }
}
