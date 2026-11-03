//! Which volumes exist, and whether two scans are really of the same one.
//!
//! A drive letter says nothing about identity: a letter can move to another
//! disk, and a disk can get another letter. History is kept per volume GUID. A
//! quick format keeps the GUID but writes a new serial number, so the serial
//! decides whether old scans of that GUID still describe this file system.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
    GetVolumeNameForVolumeMountPointW, QueryDosDeviceW, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows_sys::Win32::System::Ioctl::VOLUME_DISK_EXTENTS;
use windows_sys::Win32::System::IO::DeviceIoControl;

const DRIVE_FIXED: u32 = 3;
/// From `winioctl.h`; not exported by windows-sys.
const IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS: u32 = 0x0056_0000;

/// What identifies a volume across scans.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VolumeIdentity {
    /// The volume GUID in lower case, without braces.
    pub guid: Option<String>,
    pub serial: Option<u32>,
    pub file_system: Option<String>,
}

/// Whether two scans describe the same file system.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sameness {
    Same,
    /// Same volume GUID, new serial number: it was formatted in between.
    Reformatted,
    Different,
    /// Not enough is known. Unknown is never proof of identity.
    Unknown,
}

impl VolumeIdentity {
    /// The folder a volume's history lives in, safe as a file name. `None`
    /// when nothing identifies the volume: it can then not have a history.
    pub fn key(&self) -> Option<String> {
        if let Some(guid) = &self.guid {
            return Some(format!("v-{guid}"));
        }
        let serial = self.serial?;
        let fs = self.file_system.as_deref().unwrap_or("unknown");
        let fs: String = fs.chars().filter(char::is_ascii_alphanumeric).collect();
        Some(format!("s-{serial:08x}-{fs}"))
    }

    pub fn compare(&self, other: &VolumeIdentity) -> Sameness {
        let same_serial = match (self.serial, other.serial) {
            (Some(a), Some(b)) => Some(a == b),
            _ => None,
        };
        match (&self.guid, &other.guid) {
            (Some(a), Some(b)) if a != b => Sameness::Different,
            (Some(_), Some(_)) => match same_serial {
                Some(true) => Sameness::Same,
                Some(false) => Sameness::Reformatted,
                None => Sameness::Unknown,
            },
            _ => match same_serial {
                Some(true) if self.file_system == other.file_system => Sameness::Same,
                Some(false) => Sameness::Different,
                _ => Sameness::Unknown,
            },
        }
    }
}

/// A fixed volume on this machine, as it is now.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Volume {
    pub letter: char,
    pub root: PathBuf,
    pub label: String,
    pub identity: VolumeIdentity,
    pub total_bytes: u64,
    pub free_bytes: u64,
    /// The physical disk it is on, when that can be told.
    pub physical_disk: Option<u32>,
    /// Why it cannot be scanned (for instance a locked BitLocker volume).
    pub problem: Option<String>,
}

impl Volume {
    pub fn used_bytes(&self) -> u64 {
        self.total_bytes.saturating_sub(self.free_bytes)
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

/// `\\?\Volume{0638…}\` to `0638…`.
pub(crate) fn guid_of_volume_name(name: &str) -> Option<String> {
    let start = name.find('{')? + 1;
    let end = name[start..].find('}')? + start;
    let guid = name[start..end].to_ascii_lowercase();
    (!guid.is_empty()).then_some(guid)
}

fn volume_guid(root: &str) -> Option<String> {
    let mut buffer = [0u16; 64];
    let path = wide(root);
    // SAFETY: `path` is NUL-terminated and `buffer` holds the length passed.
    let ok = unsafe {
        GetVolumeNameForVolumeMountPointW(path.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32)
    };
    if ok == 0 {
        return None;
    }
    guid_of_volume_name(&from_wide(&buffer))
}

/// (label, serial, file system), or `None` if the volume cannot be read.
fn volume_information(root: &str) -> Option<(String, u32, String)> {
    let mut label = [0u16; 261];
    let mut file_system = [0u16; 64];
    let mut serial = 0u32;
    let path = wide(root);
    // SAFETY: the buffers hold the lengths passed; the optional outputs may be null.
    let ok = unsafe {
        GetVolumeInformationW(
            path.as_ptr(),
            label.as_mut_ptr(),
            label.len() as u32,
            &mut serial,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            file_system.as_mut_ptr(),
            file_system.len() as u32,
        )
    };
    (ok != 0).then(|| (from_wide(&label), serial, from_wide(&file_system)))
}

/// True for a letter made with `subst`, which is another view of a folder.
fn is_substituted(letter: char) -> bool {
    let mut target = [0u16; 512];
    let device = wide(&format!("{letter}:"));
    // SAFETY: `device` is NUL-terminated and `target` holds the length passed.
    let n = unsafe { QueryDosDeviceW(device.as_ptr(), target.as_mut_ptr(), target.len() as u32) };
    n != 0 && from_wide(&target).starts_with(r"\??\")
}

/// The physical disk of a volume. Opening with no access rights needs no
/// administrator rights and works for this query.
fn physical_disk(letter: char) -> Option<u32> {
    let path = wide(&format!(r"\\.\{letter}:"));
    // SAFETY: `path` is NUL-terminated; the handle is checked and closed below.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }
    // SAFETY: an all-zero VOLUME_DISK_EXTENTS is a valid value of this plain struct.
    let mut extents: VOLUME_DISK_EXTENTS = unsafe { std::mem::zeroed() };
    let mut returned = 0u32;
    // SAFETY: the output buffer is `extents` with its true size; `handle` is valid.
    let ok = unsafe {
        DeviceIoControl(
            handle,
            IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS,
            std::ptr::null(),
            0,
            (&raw mut extents).cast(),
            std::mem::size_of::<VOLUME_DISK_EXTENTS>() as u32,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    // SAFETY: `handle` came from CreateFileW and is closed once.
    unsafe { CloseHandle(handle) };
    // A volume spanning disks fails here with "more data": no single disk to name.
    (ok != 0 && extents.NumberOfDiskExtents >= 1).then_some(extents.Extents[0].DiskNumber)
}

/// Every fixed volume with a drive letter, in letter order. One volume mounted
/// on two letters is listed once.
pub fn fixed_volumes() -> Vec<Volume> {
    // SAFETY: no preconditions.
    let mask = unsafe { GetLogicalDrives() };
    let mut seen_guids = Vec::new();
    let mut out = Vec::new();
    for i in 0..26u8 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i) as char;
        let root = format!(r"{letter}:\");
        let wide_root = wide(&root);
        // SAFETY: `wide_root` is NUL-terminated.
        if unsafe { GetDriveTypeW(wide_root.as_ptr()) } != DRIVE_FIXED || is_substituted(letter) {
            continue;
        }
        let guid = volume_guid(&root);
        if let Some(g) = &guid {
            if seen_guids.contains(g) {
                continue;
            }
            seen_guids.push(g.clone());
        }
        let info = volume_information(&root);
        let (total_bytes, free_bytes) = diskghost_core::disk_space(std::path::Path::new(&root));
        let problem = info
            .is_none()
            .then(|| "无法读取这个卷，它可能已被 BitLocker 锁定".to_string());
        let (label, serial, file_system) = match info {
            Some((label, serial, fs)) => (label, Some(serial), Some(fs)),
            None => (String::new(), None, None),
        };
        out.push(Volume {
            letter,
            root: PathBuf::from(&root),
            label,
            identity: VolumeIdentity {
                guid,
                serial,
                file_system,
            },
            total_bytes,
            free_bytes,
            physical_disk: physical_disk(letter),
            problem,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(guid: Option<&str>, serial: Option<u32>) -> VolumeIdentity {
        VolumeIdentity {
            guid: guid.map(str::to_string),
            serial,
            file_system: Some("NTFS".into()),
        }
    }

    #[test]
    fn the_same_guid_and_serial_is_the_same_volume() {
        assert_eq!(
            id(Some("a"), Some(1)).compare(&id(Some("a"), Some(1))),
            Sameness::Same
        );
    }

    #[test]
    fn a_new_serial_on_the_same_guid_means_it_was_formatted() {
        assert_eq!(
            id(Some("a"), Some(1)).compare(&id(Some("a"), Some(2))),
            Sameness::Reformatted
        );
    }

    #[test]
    fn a_reused_drive_letter_does_not_make_it_the_same_volume() {
        assert_eq!(
            id(Some("a"), Some(1)).compare(&id(Some("b"), Some(1))),
            Sameness::Different
        );
    }

    #[test]
    fn unknown_is_never_proof_of_identity() {
        assert_eq!(id(None, None).compare(&id(None, None)), Sameness::Unknown);
        assert_eq!(
            id(Some("a"), None).compare(&id(Some("a"), None)),
            Sameness::Unknown
        );
    }

    #[test]
    fn a_volume_with_no_identity_has_no_history_key() {
        assert_eq!(id(None, None).key(), None);
        assert_eq!(id(Some("abc"), Some(1)).key().unwrap(), "v-abc");
        assert_eq!(id(None, Some(255)).key().unwrap(), "s-000000ff-NTFS");
    }

    #[test]
    fn volume_names_give_the_bare_guid() {
        assert_eq!(
            guid_of_volume_name(r"\\?\Volume{0638AFD-516e}\").unwrap(),
            "0638afd-516e"
        );
        assert_eq!(guid_of_volume_name("nothing here"), None);
    }

    #[test]
    fn this_machine_has_a_system_volume_with_an_identity() {
        let volumes = fixed_volumes();
        let system = volumes.iter().find(|v| v.letter == 'C');
        // Every Windows machine this runs on has a fixed volume; C: on nearly all.
        if let Some(c) = system {
            assert!(c.identity.key().is_some());
            assert!(c.total_bytes > 0);
            assert!(c.problem.is_none());
        }
    }
}
