//! Opening a file with whatever Windows has chosen for it.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// Open a report in the default browser, or a folder in Explorer. Callers only
/// ever pass paths inside Diskly's own data folder.
pub fn open_file(path: &Path) -> Result<(), String> {
    let wide = |s: &OsStr| -> Vec<u16> { s.encode_wide().chain(std::iter::once(0)).collect() };
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

/// Windows 11 starts at build 22000, and Mica with it.
pub fn supports_mica() -> bool {
    // SAFETY: an all-zero OSVERSIONINFOW is valid once its size is set.
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    // SAFETY: `info` is a valid, sized structure.
    let status = unsafe { RtlGetVersion(&mut info) };
    status == 0 && info.dwBuildNumber >= 22000
}
