//! Opening things with what Windows has chosen for them.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows_sys::Win32::UI::Shell::{AssocQueryStringW, ShellExecuteW, ASSOCSTR_COMMAND};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(std::iter::once(0)).collect()
}

/// Open a folder in Explorer, or a file with its associated program. Callers only
/// ever pass paths inside Diskly's own data folder.
pub fn open_file(path: &Path) -> Result<(), String> {
    let (verb, file) = (wide(OsStr::new("open")), wide(path.as_os_str()));
    // SAFETY: both strings are NUL-terminated and outlive the call.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // Values above 32 mean success.
    if result as isize > 32 {
        Ok(())
    } else {
        Err(format!("错误 {}", result as isize))
    }
}

/// `path` as a `file:` URL. Everything but plain characters is percent-encoded,
/// so it holds no space or quote, and is one argument whatever the path is.
fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy();
    let mut url = String::from("file:///");
    for byte in text.trim_start_matches(r"\\?\").bytes() {
        match byte {
            b'\\' => url.push('/'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                url.push(byte as char);
            }
            _ => url.push_str(&format!("%{byte:02X}")),
        }
    }
    url
}

/// Split a registered command into its program and the rest of the line.
fn split_command(command: &str) -> Option<(&str, &str)> {
    let command = command.trim();
    if let Some(rest) = command.strip_prefix('"') {
        let end = rest.find('"')?;
        return Some((&rest[..end], rest[end + 1..].trim_start()));
    }
    match command.find(' ') {
        Some(end) => Some((&command[..end], command[end + 1..].trim_start())),
        None => Some((command, "")),
    }
}

/// The arguments to give a browser whose command line is `arguments`.
fn with_url(arguments: &str, url: &str) -> String {
    if arguments.contains("%1") {
        arguments.replace("%1", url)
    } else {
        format!("{arguments} {url}").trim().to_string()
    }
}

/// How Windows would open a web page: the system's actual default browser.
fn default_browser_command() -> Option<String> {
    let (protocol, verb) = (wide(OsStr::new("http")), wide(OsStr::new("open")));
    let mut buffer = [0u16; 2048];
    let mut length = buffer.len() as u32;
    // SAFETY: both strings are NUL-terminated; `buffer` holds `length` characters.
    let status = unsafe {
        AssocQueryStringW(
            0,
            ASSOCSTR_COMMAND,
            protocol.as_ptr(),
            verb.as_ptr(),
            buffer.as_mut_ptr(),
            &mut length,
        )
    };
    if status != 0 {
        return None;
    }
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    let command = String::from_utf16_lossy(&buffer[..end]);
    (!command.trim().is_empty()).then_some(command)
}

/// Open a report in the default browser. It asks for the browser that handles web
/// addresses, and not the program for `.html` files: that can be an editor, or
/// unset, in which case Windows only shows a dialog asking which program to use.
pub fn open_in_browser(path: &Path) -> Result<(), String> {
    let url = file_url(path);
    let started = default_browser_command().is_some_and(|command| {
        let Some((program, arguments)) = split_command(&command) else {
            return false;
        };
        Command::new(program)
            .raw_arg(with_url(arguments, &url))
            .spawn()
            .is_ok()
    });
    if started {
        Ok(())
    } else {
        open_file(path)
    }
}

/// Windows 11 starts at build 22000, and Mica with it.
pub fn supports_mica() -> bool {
    // SAFETY: an all-zero OSVERSIONINFOW is valid once its size is set.
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    // SAFETY: `info` is a valid, sized structure.
    let status = unsafe { RtlGetVersion(&mut info) };
    status == 0 && info.dwBuildNumber >= 22000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_becomes_one_safe_url_argument() {
        assert_eq!(
            file_url(Path::new(r"C:\Users\a b\报告\x&y.html")),
            "file:///C:/Users/a%20b/%E6%8A%A5%E5%91%8A/x%26y.html"
        );
        assert_eq!(
            file_url(Path::new(r#"C:\a"b\%1.html"#)),
            "file:///C:/a%22b/%251.html"
        );
        assert_eq!(file_url(Path::new(r"\\?\C:\a.html")), "file:///C:/a.html");
    }

    #[test]
    fn registered_commands_are_split_as_windows_writes_them() {
        assert_eq!(
            split_command(
                r#""C:\Program Files\Google\Chrome\Application\chrome.exe" --single-argument %1"#
            ),
            Some((
                r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                "--single-argument %1"
            ))
        );
        assert_eq!(
            split_command(r#"C:\browser.exe -osint -url "%1""#),
            Some((r"C:\browser.exe", r#"-osint -url "%1""#))
        );
        assert_eq!(
            split_command(r"C:\browser.exe"),
            Some((r"C:\browser.exe", ""))
        );
        assert_eq!(split_command(r#""C:\no closing quote"#), None);
    }

    #[test]
    fn the_url_goes_where_the_command_wants_it() {
        assert_eq!(
            with_url("--single-argument %1", "file:///a"),
            "--single-argument file:///a"
        );
        assert_eq!(
            with_url(r#"-osint -url "%1""#, "file:///a"),
            r#"-osint -url "file:///a""#
        );
        assert_eq!(with_url("", "file:///a"), "file:///a");
    }

    #[test]
    fn this_machine_can_name_a_browser() {
        // A server image may have none; then the file association is used instead.
        if let Some(command) = default_browser_command() {
            assert!(split_command(&command).is_some(), "{command}");
        }
    }
}
