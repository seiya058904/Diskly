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

/// Browsers turn CRLF into LF before hashing a script, and a Windows checkout has
/// CRLF. Hashing the text as it is would get the page's own code blocked.
fn lf(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// The complete page for `data`.
pub fn render<T: Serialize>(data: &T) -> Result<String, serde_json::Error> {
    let style = lf(&format!("{TOKENS}\n{STYLE}"));
    let script = lf(&format!("{LIB}\n{SCRIPT}"));
    let csp = format!(
        "default-src 'none'; script-src {}; style-src {}; img-src data:; base-uri 'none'; form-action 'none'",
        csp_hash(&script),
        csp_hash(&style)
    );
    let json = inert_json(data)?;
    // The data goes in last, so nothing inside it can be taken for a placeholder.
    Ok(lf(TEMPLATE)
        .replacen("__CSP__", &csp, 1)
        .replacen("__STYLE__", &style, 1)
        .replacen("__SCRIPT__", &script, 1)
        .replacen("__DATA__", &json, 1))
}

/// Recover only the inert data of a saved report. Its old markup and script are
/// never reused: reopening through the app renders this data with today's code.
pub fn saved_data(html: &str) -> Option<serde_json::Value> {
    let start = "<script type=\"application/json\" id=\"diskly-data\">";
    let json = html.split_once(start)?.1.split_once("</script>")?.0;
    let mut data: serde_json::Value = serde_json::from_str(json).ok()?;
    if data["format"] != 1 && data["format"] != 2 {
        return None;
    }
    // Format 1 has the same snapshots/table but predates insights and records.
    // Decode each disk separately: one damaged disk must not destroy the others.
    let volumes: Vec<_> = data["volumes"]
        .as_array()?
        .iter()
        .filter_map(|v| {
            let mut volume: crate::session::VolumeReport =
                serde_json::from_value(v.clone()).ok()?;
            if !valid_table(&volume) {
                for scan in &volume.snapshots {
                    if !volume.records.iter().any(|r| r.id == scan.id) {
                        volume.records.push(crate::store::ScanRecord {
                            id: scan.id.clone(),
                            at: scan.taken_at,
                            letter: scan.letter,
                            engine: scan.engine.clone(),
                            total: scan.total_bytes,
                            free: scan.free_bytes,
                            files: scan.files,
                            dirs: scan.dirs,
                            top: Vec::new(),
                            serial: scan.serial,
                            unread_top: None,
                        });
                    }
                }
                volume.snapshots.clear();
                volume.table = crate::compare::NodeTable::default();
                volume.file_changes.clear();
                volume.insights.clear();
                volume
                    .issues
                    .push("已跳过报告中损坏的目录详情，保留可读取的扫描摘要。".into());
            }
            volume
                .records
                .sort_by(|a, b| (a.at, &a.id).cmp(&(b.at, &b.id)));
            Some(volume)
        })
        .collect();
    data["volumes"] = serde_json::to_value(volumes).ok()?;
    let mut data: crate::session::ReportData = serde_json::from_value(data).ok()?;
    data.format = 2;
    serde_json::to_value(data).ok()
}

fn valid_table(volume: &crate::session::VolumeReport) -> bool {
    let table = &volume.table;
    let n = table.names.len();
    let scans = volume.snapshots.len();
    if n == 0 {
        return scans == 0
            && table.parents.is_empty()
            && table.sizes.is_empty()
            && table.unread.is_empty();
    }
    table.parents.len() == n
        && table.parents[0] == -1
        && table
            .parents
            .iter()
            .enumerate()
            .skip(1)
            .all(|(i, p)| *p >= 0 && (*p as usize) < i)
        && table.sizes.len() == scans
        && table.sizes.iter().all(|row| row.len() == n)
        && table.unread.len() == scans
        && table.unread.iter().flatten().all(|i| (*i as usize) < n)
        && volume
            .snapshots
            .windows(2)
            .all(|s| (s[0].taken_at, &s[0].id) < (s[1].taken_at, &s[1].id))
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
        let script = lf(&format!("{LIB}\n{SCRIPT}"));
        assert!(page.contains(&format!("<script>{script}</script>")));
        assert!(page.contains(&csp_hash(&script)));
    }

    #[test]
    fn page_code_cannot_end_its_own_element() {
        assert!(!format!("{LIB}\n{SCRIPT}").contains("</script"));
        assert!(!format!("{TOKENS}\n{STYLE}").contains("</style"));
    }

    #[test]
    fn line_ends_cannot_break_the_hash_on_a_windows_checkout() {
        assert_eq!(lf("a\r\nb\nc\r\n"), "a\nb\nc\n");
        assert!(!render(&1).unwrap().contains('\r'));
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
