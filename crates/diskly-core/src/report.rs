//! Turns report data into one self-contained HTML file.
//!
//! The file may hold any text a file system can hold, so nothing from a scan
//! reaches the page as markup: the data sits in an inert JSON block with
//! everything that could end it escaped, the page script only ever assigns it
//! as text, and a content security policy allows only this page's own script
//! and style, by hash, and no network at all.

use serde::Serialize;
use sha2::{Digest, Sha256};

const TEMPLATE: &str = include_str!("../../../report/report.html");
const TOKENS: &str = include_str!("../../../app/ui/tokens.css");
const STYLE: &str = include_str!("../../../report/report.css");
const LIB: &str = include_str!("../../../report/lib.js");
const SCRIPT: &str = include_str!("../../../report/report.js");

/// JSON that is safe inside a `<script>` element: it cannot end the element, and
/// it does not change meaning if the block is ever read as JavaScript.
pub fn inert_json<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    let json = serde_json::to_string(value)?;
    let mut out = String::with_capacity(json.len() + 64);
    for c in json.chars() {
        match c {
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            _ => out.push(c),
        }
    }
    Ok(out)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn csp_hash(text: &str) -> String {
    format!("'sha256-{}'", base64(&Sha256::digest(text.as_bytes())))
}

/// The complete page for `data`.
pub fn render<T: Serialize>(data: &T) -> Result<String, serde_json::Error> {
    let style = format!("{TOKENS}\n{STYLE}");
    let script = format!("{LIB}\n{SCRIPT}");
    let csp = format!(
        "default-src 'none'; script-src {}; style-src {}; img-src data:; base-uri 'none'; form-action 'none'",
        csp_hash(&script),
        csp_hash(&style)
    );
    let json = inert_json(data)?;
    // The data goes in last, so nothing inside it can be taken for a placeholder.
    Ok(TEMPLATE
        .replacen("__CSP__", &csp, 1)
        .replacen("__STYLE__", &style, 1)
        .replacen("__SCRIPT__", &script, 1)
        .replacen("__DATA__", &json, 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_cannot_end_its_script_element() {
        let hostile = "</script><img src=x onerror=alert(1)><!-- \u{2028}\u{2029} & __SCRIPT__";
        let json = inert_json(&hostile).unwrap();
        assert!(!json.contains('<') && !json.contains('>') && !json.contains('&'));
        assert!(!json.contains('\u{2028}') && !json.contains('\u{2029}'));
        // It still means the same thing to whoever parses it.
        let back: String = serde_json::from_str(&json).unwrap();
        assert_eq!(back, hostile);
    }

    #[test]
    fn hostile_text_in_the_data_stays_in_the_data() {
        let hostile = "</script><script>alert(1)</script>__STYLE____CSP__";
        let page = render(&hostile).unwrap();
        assert_eq!(page.matches("<script").count(), 2, "only the page's own");
        assert!(!page.contains("alert(1)</script>"));
        assert_eq!(page.matches("Content-Security-Policy").count(), 1);
    }

    #[test]
    fn the_page_allows_no_network_and_nothing_but_its_own_code() {
        let page = render(&1).unwrap();
        for needed in [
            "default-src 'none'",
            "script-src 'sha256-",
            "style-src 'sha256-",
        ] {
            assert!(page.contains(needed), "{needed}");
        }
        assert!(!page.contains("unsafe-inline"));
        assert!(!page.contains("__CSP__") && !page.contains("__SCRIPT__"));
        assert!(!page.contains("__STYLE__") && !page.contains("__DATA__"));
    }

    #[test]
    fn the_csp_hash_is_of_the_exact_script_in_the_page() {
        let page = render(&1).unwrap();
        let script = format!("{LIB}\n{SCRIPT}");
        assert!(page.contains(&format!("<script>{script}</script>")));
        assert!(page.contains(&csp_hash(&script)));
    }

    #[test]
    fn page_code_cannot_end_its_own_element() {
        assert!(!format!("{LIB}\n{SCRIPT}").contains("</script"));
        assert!(!format!("{TOKENS}\n{STYLE}").contains("</style"));
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
