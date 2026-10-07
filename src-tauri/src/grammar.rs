//! Offline Harper adapter. Harper spans count Unicode scalar values; the editor
//! counts UTF-16 code units. Convert explicitly, never replay absolute editor ranges.
use harper_core::{
    linting::{LintGroup, LintKind, Linter, Suggestion},
    spell::FstDictionary,
    Dialect, Document,
};
use serde::Serialize;
use std::cell::RefCell;

thread_local! {
    static LINTER: RefCell<LintGroup> = RefCell::new(
        LintGroup::new_curated(FstDictionary::curated(), Dialect::American)
    );
}
#[derive(Debug, Serialize)]
pub struct Finding {
    pub offset: usize,
    pub quote: String,
    pub category: String,
    pub severity: &'static str,
    pub message: String,
    pub explanation: String,
    pub replacement: Option<String>,
    pub replacements: Vec<String>,
    pub confidence: f64,
}
pub fn review(text: &str) -> Result<Vec<Finding>, String> {
    if text.len() > 5_000_000 {
        return Err("Paragraph exceeds the desktop editing size limit.".into());
    }
    let chars: Vec<char> = text.chars().collect();
    let document = Document::new_plain_english_curated(text);
    let mut lints = LINTER.with(|linter| linter.borrow_mut().lint(&document));
    // Spelling is intentionally left to native spellcheck. Avoid duplicate-word
    // reports already supplied by Draftbench's small, established local rule.
    lints.retain(|lint| !matches!(lint.lint_kind, LintKind::Spelling | LintKind::Repetition));
    harper_core::remove_overlaps(&mut lints);
    lints.sort_by_key(|lint| lint.span.start);
    Ok(lints
        .into_iter()
        .filter_map(|lint| {
            if lint.span.start >= lint.span.end || lint.span.end > chars.len() {
                return None;
            }
            let original_quote: String = chars[lint.span.start..lint.span.end].iter().collect();
            let mut start = lint.span.start;
            let mut end = lint.span.end;
            // Include adjacent source for whitespace-only lints so the shared quote
            // contract remains meaningful. Preserve that context in every suggestion.
            if original_quote.trim().is_empty() {
                if start > 0 {
                    start -= 1;
                } else if end < chars.len() {
                    end += 1;
                }
            }
            let quote: String = chars[start..end].iter().collect();
            if quote.trim().is_empty() {
                return None;
            }
            let prefix: String = chars[start..lint.span.start].iter().collect();
            let suffix: String = chars[lint.span.end..end].iter().collect();
            let offset = chars[..start].iter().map(|c| c.len_utf16()).sum();
            let mut replacements = Vec::new();
            for suggestion in lint.suggestions.into_iter().take(8) {
                let replacement: String = match suggestion {
                    Suggestion::ReplaceWith(with) => with.iter().collect(),
                    Suggestion::Remove => String::new(),
                    Suggestion::InsertAfter(with) => {
                        format!("{original_quote}{}", with.iter().collect::<String>())
                    }
                };
                let replacement = format!("{prefix}{replacement}{suffix}");
                if replacement != quote && !replacements.contains(&replacement) {
                    replacements.push(replacement);
                }
            }
            Some(Finding {
                offset,
                quote,
                category: format!("harper-{}", lint.lint_kind.to_string_key().to_lowercase()),
                severity: if matches!(
                    lint.lint_kind,
                    LintKind::Grammar | LintKind::Agreement | LintKind::Typo
                ) {
                    "warning"
                } else {
                    "suggestion"
                },
                message: lint.message.clone(),
                explanation: lint.message,
                replacement: replacements.first().cloned(),
                replacements,
                confidence: 1.0,
            })
        })
        .take(501)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grammar_and_unicode_offsets_are_deterministic() {
        let text = "😀 She could of finished the report.";
        let findings = review(text).unwrap();
        assert!(!findings.is_empty(), "{findings:?}");
        let expected = text.encode_utf16().collect::<Vec<_>>();
        for finding in &findings {
            let quote = finding.quote.encode_utf16().collect::<Vec<_>>();
            assert_eq!(
                &expected[finding.offset..finding.offset + quote.len()],
                quote.as_slice()
            );
        }
        assert!(findings
            .iter()
            .any(|f| f.replacements.iter().any(|s| s.contains("have"))));
        assert_eq!(
            serde_json::to_value(&findings).unwrap(),
            serde_json::to_value(review(text).unwrap()).unwrap()
        );
    }
    #[test]
    fn clean_prose_can_produce_no_findings() {
        assert!(review("The team finished the report on Friday.")
            .unwrap()
            .is_empty());
    }
}
