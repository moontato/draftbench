use super::NetworkError;
use serde_json::{json, Value};

pub(super) const MAX_RESPONSE_BYTES: usize = 2_000_000;
// Token-by-token SSE adds significant framing overhead, especially for reasoning.
// Bound wire traffic separately without retaining it or exposing reasoning as prose.
const MAX_STREAM_BYTES: usize = 32_000_000;

pub(super) struct CompletionStream {
    status: u16,
    line: Vec<u8>,
    data: String,
    has_data: bool,
    error_event: bool,
    wire_bytes: usize,
    content: String,
    finish_reason: Option<String>,
    done: bool,
}
impl CompletionStream {
    pub(super) fn new(status: u16) -> Self {
        Self {
            status,
            line: Vec::new(),
            data: String::new(),
            has_data: false,
            error_event: false,
            wire_bytes: 0,
            content: String::new(),
            finish_reason: None,
            done: false,
        }
    }
    fn malformed(&self, message: &str) -> NetworkError {
        NetworkError::new("malformed", message, Some(self.status))
    }
    fn server_error(&self) -> NetworkError {
        NetworkError::new(
            "server",
            "The inference server returned an error during generation.",
            Some(self.status),
        )
    }
    pub(super) fn feed(&mut self, bytes: &[u8]) -> Result<bool, NetworkError> {
        self.wire_bytes = self.wire_bytes.saturating_add(bytes.len());
        if self.wire_bytes > MAX_STREAM_BYTES {
            return Err(self.malformed("Inference stream exceeds the size limit."));
        }
        for &byte in bytes {
            if self.done {
                break;
            }
            if byte != b'\n' {
                if self.line.len() >= MAX_RESPONSE_BYTES {
                    return Err(self.malformed("Inference stream event exceeds the size limit."));
                }
                self.line.push(byte);
                continue;
            }
            let line = std::str::from_utf8(&self.line)
                .map_err(|_| self.malformed("Inference stream contains invalid UTF-8."))?
                .trim_end_matches('\r');
            if line.is_empty() {
                self.event()?;
            } else if let Some(data) = line.strip_prefix("data:") {
                let data = data.strip_prefix(' ').unwrap_or(data);
                if self.data.len() + data.len() + usize::from(self.has_data) > MAX_RESPONSE_BYTES {
                    return Err(self.malformed("Inference stream event exceeds the size limit."));
                }
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(data);
                self.has_data = true;
            } else if let Some(event) = line.strip_prefix("event:") {
                self.error_event = event.trim() == "error";
            }
            // SSE comments/pings, IDs and event names are not completion content.
            self.line.clear();
        }
        Ok(self.done)
    }
    fn event(&mut self) -> Result<(), NetworkError> {
        let is_error = std::mem::take(&mut self.error_event);
        if !self.has_data {
            return Ok(());
        }
        self.has_data = false;
        let data = std::mem::take(&mut self.data);
        if is_error {
            return Err(self.server_error());
        }
        if data.trim() == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        let value: Value = serde_json::from_str(&data)
            .map_err(|_| self.malformed("Server returned a malformed inference stream event."))?;
        if value.get("error").is_some_and(|e| !e.is_null()) {
            // Never echo server messages containing prompts, reasoning or credentials.
            return Err(self.server_error());
        }
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                self.malformed("Server returned an invalid completion stream envelope.")
            })?;
        for choice in choices {
            if !choice.is_object() {
                return Err(self.malformed("Server returned an invalid completion choice."));
            }
            let index = match choice.get("index") {
                Some(index) => index.as_u64().ok_or_else(|| {
                    self.malformed("Server returned an invalid completion index.")
                })?,
                None if choices.len() == 1 => 0,
                None => {
                    return Err(self.malformed("Server returned a completion without an index."))
                }
            };
            if index != 0 {
                continue;
            }
            if let Some(delta) = choice.get("delta").filter(|d| !d.is_null()) {
                if !delta.is_object() {
                    return Err(self.malformed("Server returned an invalid completion delta."));
                }
                if let Some(content) = delta.get("content").filter(|c| !c.is_null()) {
                    let content = content.as_str().ok_or_else(|| {
                        self.malformed("Server returned invalid completion content.")
                    })?;
                    if !content.is_empty() && self.finish_reason.is_some() {
                        return Err(self
                            .malformed("Server sent completion content after its finish marker."));
                    }
                    if self.content.len() + content.len() > MAX_RESPONSE_BYTES {
                        return Err(self.malformed("Server response exceeds the size limit."));
                    }
                    self.content.push_str(content);
                }
                // Do not concatenate reasoning_content, reasoning or tool calls.
            }
            if let Some(reason) = choice.get("finish_reason").filter(|r| !r.is_null()) {
                let reason = reason
                    .as_str()
                    .filter(|r| !r.trim().is_empty() && r.len() <= 128)
                    .ok_or_else(|| {
                        self.malformed("Server returned an invalid completion finish marker.")
                    })?;
                if self
                    .finish_reason
                    .as_deref()
                    .is_some_and(|old| old != reason)
                {
                    return Err(
                        self.malformed("Server returned conflicting completion finish markers.")
                    );
                }
                self.finish_reason = Some(reason.into());
            }
        }
        Ok(())
    }
    pub(super) fn finish(self) -> Result<Value, NetworkError> {
        let reason = self.finish_reason.as_ref().ok_or_else(|| {
            self.malformed("Inference stream ended before a completion finish marker.")
        })?;
        // Only the complete envelope crosses IPC. The provider still validates the
        // final JSON and rejects finish_reason=length; partial findings are never shown.
        Ok(
            json!({"choices": [{"index": 0, "message": {"content": self.content}, "finish_reason": reason}]}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(delta: Value, reason: Value) -> String {
        format!(
            "data: {}\n\n",
            json!({"choices": [{"index": 0, "delta": delta, "finish_reason": reason}]})
        )
    }
    #[test]
    fn fragmented_unicode_crlf_reasoning_and_usage_reconstruct_only_final_content() {
        let input = format!(
            ": ping\n\n{}{}{}{}data: {{\"choices\":[],\"usage\":{{}}}}\n\ndata: [DONE]\n\n",
            event(json!({"role": "assistant", "content": null}), Value::Null),
            event(
                json!({"reasoning_content": "private reasoning", "reasoning": "not JSON"}),
                Value::Null
            ),
            event(
                json!({"content": "{\"issues\":[],\"quote\":\"café 🍃\"}"}),
                Value::Null
            ),
            event(json!({}), json!("stop"))
        )
        .replace('\n', "\r\n");
        let mut stream = CompletionStream::new(200);
        for byte in input.as_bytes() {
            stream.feed(&[*byte]).unwrap();
        }
        let value = stream.finish().unwrap();
        assert_eq!(
            value["choices"][0]["message"]["content"],
            "{\"issues\":[],\"quote\":\"café 🍃\"}"
        );
        assert_eq!(value["choices"][0]["finish_reason"], "stop");
        assert!(!value.to_string().contains("private reasoning"));
    }
    #[test]
    fn multiline_data_and_length_finish_are_preserved() {
        let mut stream = CompletionStream::new(200);
        stream.feed(b"event: message\ndata: {\"choices\": [\ndata: {\"index\":0,\"delta\":{\"content\":\"{}\"},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n").unwrap();
        assert_eq!(
            stream.finish().unwrap()["choices"][0]["finish_reason"],
            "length"
        );
    }
    #[test]
    fn partial_json_or_done_without_a_finish_marker_is_rejected() {
        for suffix in ["", "data: [DONE]\n\n"] {
            let mut stream = CompletionStream::new(200);
            stream
                .feed(
                    format!(
                        "{}{suffix}",
                        event(json!({"content":"{\"issues\":[]}"}), Value::Null)
                    )
                    .as_bytes(),
                )
                .unwrap();
            assert_eq!(stream.finish().unwrap_err().kind, "malformed");
        }
        let mut stream = CompletionStream::new(200);
        stream
            .feed(event(json!({"content":"{}"}), json!("stop")).as_bytes())
            .unwrap();
        assert!(stream.finish().is_ok()); // Explicit finish + EOF is sufficient.
    }
    #[test]
    fn malformed_frames_and_server_errors_are_private() {
        for input in [
            "data: not JSON\n\n",
            "data: {}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":7}}]}\n\n",
        ] {
            assert_eq!(
                CompletionStream::new(200)
                    .feed(input.as_bytes())
                    .unwrap_err()
                    .kind,
                "malformed"
            );
        }
        let error = CompletionStream::new(200)
            .feed(b"data: {\"error\":{\"message\":\"private-key private-prose\"}}\n\n")
            .unwrap_err();
        assert_eq!(error.kind, "server");
        assert!(!error.message.contains("private-"));
        let error = CompletionStream::new(200)
            .feed(b"event: error\ndata: {\"message\":\"private-key private-prose\"}\n\n")
            .unwrap_err();
        assert_eq!(error.kind, "server");
        assert!(!error.message.contains("private-"));
    }
    #[test]
    fn response_event_and_wire_limits_are_bounded_separately() {
        let mut stream = CompletionStream::new(200);
        let chunk = event(json!({"content": "x".repeat(1_000_001)}), Value::Null);
        stream.feed(chunk.as_bytes()).unwrap();
        assert!(stream.feed(chunk.as_bytes()).is_err());
        assert!(CompletionStream::new(200)
            .feed(&vec![b'x'; MAX_RESPONSE_BYTES + 1])
            .is_err());
        let mut stream = CompletionStream::new(200);
        stream.wire_bytes = MAX_STREAM_BYTES;
        assert!(stream.feed(b": ping\n\n").is_err());
        let mut stream = CompletionStream::new(200);
        let reasoning = event(json!({"reasoning_content": "x".repeat(2048)}), Value::Null);
        for _ in 0..1100 {
            stream.feed(reasoning.as_bytes()).unwrap();
        }
        assert!(stream.wire_bytes > MAX_RESPONSE_BYTES);
        stream
            .feed(event(json!({"content":"{}"}), json!("stop")).as_bytes())
            .unwrap();
        assert_eq!(
            stream.finish().unwrap()["choices"][0]["message"]["content"],
            "{}"
        );
    }
    #[test]
    fn other_choices_cannot_finish_the_first_and_post_finish_content_is_rejected() {
        let mut stream = CompletionStream::new(200);
        stream.feed(b"data: {\"choices\":[{\"index\":1,\"delta\":{\"content\":\"{}\"},\"finish_reason\":\"stop\"}]}\n\n").unwrap();
        assert!(stream.finish().is_err());
        let mut stream = CompletionStream::new(200);
        stream
            .feed(event(json!({"content":"{}"}), json!("stop")).as_bytes())
            .unwrap();
        assert!(stream
            .feed(event(json!({"content":"extra"}), Value::Null).as_bytes())
            .is_err());
    }
}
