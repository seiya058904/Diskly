//! The parallel directory walk behind every scan, duplicate search and delete.
//!
//! Each directory is listed by one task on a thread pool owned by this walk
//! (so concurrent walks never starve each other), and every subdirectory found
//! becomes a new task. A file's size comes from the directory listing itself:
//! on Windows the `FindNextFile` data already carries size and attributes, so
//! no file is ever opened — that per-file open used to be most of a scan's
//! cost. The listing of one directory is handed to the caller as a [`Batch`]
//! while the walk goes on, so building a tree overlaps with the I/O.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Mutex};

use crate::{build_globset, is_excluded, on_disk_size, FileEntry, Options, Progress};

/// What one directory contains.
pub(crate) struct Batch {
    pub(crate) dir: PathBuf,
    pub(crate) files: Vec<FileEntry>,
    /// Last-modified time of each of `files` (nanoseconds since the Unix
    /// epoch, 0 if unknown) — from the same listing, so it costs nothing.
    pub(crate) modified: Vec<u64>,
    /// Subdirectories (also those not descended into because of `max_depth`).
    pub(crate) subdirs: Vec<PathBuf>,
    /// Entries neither counted nor followed: symlinks and junctions when links
    /// are not followed, sockets, devices. A delete still has to remove them.
    pub(crate) others: Vec<PathBuf>,
    /// Entries (or this directory itself) that could not be read.
    pub(crate) skipped: u64,
    /// This directory could not be listed at all, and it does still exist.
    pub(crate) unlistable: bool,
}

/// Threads for a walk with `Options::threads == None`: directory listing is
/// latency-bound, so twice the cores keeps fast SSDs busy.
pub(crate) fn default_threads() -> usize {
    let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
    (cores * 2).clamp(4, 64)
}

struct Ctx<'a> {
    root: &'a Path,
    glob: globset::GlobSet,
    max_depth: Option<usize>,
    follow: bool,
    progress: &'a Progress,
    tx: mpsc::Sender<Batch>,
    /// Canonical directories already entered — only kept when following
    /// links, where a link back up the tree would otherwise loop forever.
    seen: Option<Mutex<HashSet<PathBuf>>>,
}

impl Ctx<'_> {
    fn first_visit(&self, dir: &Path) -> bool {
        let Some(seen) = &self.seen else { return true };
        let key = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        seen.lock().map(|mut s| s.insert(key)).unwrap_or(true)
    }
}

/// Walk `root`, calling `sink` on the caller's thread with each directory's
/// [`Batch`] as soon as it is listed (in no particular order). Honours
/// exclusions, max depth, link following and cancellation.
pub(crate) fn walk(
    root: &Path,
    opts: &Options,
    progress: &Progress,
    mut sink: impl FnMut(Batch),
) -> (Engine, Option<String>) {
    walk_dyn(root, opts, progress, &mut sink)
}

/// [`walk`] with a type-erased sink, so the MFT engine can hand folders it
/// cannot read itself back to the directory walk.
pub(crate) fn walk_dyn(
    root: &Path,
    opts: &Options,
    progress: &Progress,
    sink: &mut dyn FnMut(Batch),
) -> (Engine, Option<String>) {
    // Why the MFT was asked for but not used.
    let mut fallback = None;
    if opts.mft {
        #[cfg(windows)]
        if opts.follow_symlinks {
            fallback = Some("links are followed only by the directory walk".to_string());
        } else {
            match crate::mft::walk(root, opts, progress, sink) {
                Ok(()) => return (Engine::Mft, None),
                Err(e) => fallback = Some(e.to_string()),
            }
        }
        #[cfg(not(windows))]
        {
            fallback = Some("the MFT engine exists on Windows only".to_string());
        }
    }
    let threads = opts.threads.unwrap_or_else(default_threads).max(1);
    let (tx, rx) = mpsc::channel();
    let ctx = Ctx {
        root,
        glob: build_globset(&opts.exclude),
        max_depth: opts.max_depth,
        follow: opts.follow_symlinks,
        progress,
        tx,
        seen: opts.follow_symlinks.then(|| Mutex::new(HashSet::new())),
    };
    if ctx.follow {
        ctx.first_visit(root);
    }
    std::thread::scope(|ts| {
        ts.spawn(move || {
            let start = root.to_path_buf();
            match rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .thread_name(|i| format!("diskghost-walk-{i}"))
                .build()
            {
                Ok(pool) => pool.scope(|s| begin(s, &ctx, start)),
                Err(_) => rayon::scope(|s| begin(s, &ctx, start)),
            }
            // `ctx` (and with it the sender) drops here, ending the receiver loop.
        });
        for batch in rx {
            sink(batch);
        }
    });
    (Engine::Walk, fallback)
}

/// How a tree was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    /// Directory by directory.
    Walk,
    /// From the NTFS Master File Table (Windows only).
    #[cfg_attr(not(windows), allow(dead_code))]
    Mft,
}

/// Start at the root, the direct way when it applies: paths are only needed for
/// exclusions, and following links needs the ordinary route.
fn begin<'s, 'c: 's>(s: &rayon::Scope<'s>, ctx: &'c Ctx<'c>, root: PathBuf) {
    #[cfg(windows)]
    if !ctx.follow && ctx.glob.is_empty() {
        if let Some(handle) = nt::open_root(&root) {
            visit_nt(s, ctx, std::sync::Arc::new(handle), root, 0);
            return;
        }
    }
    visit(s, ctx, root, 0);
}

fn visit<'s, 'c: 's>(s: &rayon::Scope<'s>, ctx: &'c Ctx<'c>, dir: PathBuf, depth: usize) {
    if ctx.progress.cancelled() {
        return;
    }
    let mut b = Batch {
        dir,
        files: Vec::new(),
        modified: Vec::new(),
        subdirs: Vec::new(),
        others: Vec::new(),
        skipped: 0,
        unlistable: false,
    };
    let entries = match std::fs::read_dir(&b.dir) {
        Ok(rd) => rd,
        Err(e) => {
            b.skipped = 1;
            b.unlistable = e.kind() != std::io::ErrorKind::NotFound;
            let _ = ctx.tx.send(b);
            return;
        }
    };
    // Entries of this directory sit at `depth + 1`; descend only while the
    // next level is still within `max_depth` (the root is depth 0).
    let child_depth = depth + 1;
    let descend = ctx.max_depth.map_or(true, |m| child_depth < m);
    let mut bytes = 0u64;
    for (i, entry) in entries.enumerate() {
        if i % 1024 == 1023 && ctx.progress.cancelled() {
            break;
        }
        let Ok(entry) = entry else {
            b.skipped += 1;
            continue;
        };
        let path = entry.path();
        if !ctx.glob.is_empty() && is_excluded(&ctx.glob, ctx.root, &path) {
            continue;
        }
        let Ok(mut ft) = entry.file_type() else {
            b.skipped += 1;
            continue;
        };
        // Metadata straight from the listing (free on Windows), or of the
        // link target when following a link.
        let mut meta = None;
        if ft.is_symlink() {
            if !ctx.follow {
                b.others.push(path);
                continue;
            }
            match std::fs::metadata(&path) {
                Ok(m) => {
                    ft = m.file_type();
                    meta = Some(m);
                }
                Err(_) => {
                    b.skipped += 1;
                    continue;
                }
            }
        }
        if ft.is_dir() {
            if ctx.follow && !ctx.first_visit(&path) {
                continue;
            }
            if descend {
                let sub = path.clone();
                s.spawn(move |s| visit(s, ctx, sub, child_depth));
            }
            b.subdirs.push(path);
        } else if ft.is_file() {
            let meta = match meta.map_or_else(|| entry.metadata(), Ok) {
                Ok(m) => m,
                Err(_) => {
                    b.skipped += 1;
                    continue;
                }
            };
            let size = on_disk_size(&meta, &path);
            bytes += size;
            b.modified.push(modified_ns(&meta));
            b.files.push(FileEntry {
                path,
                size,
                logical_size: meta.len(),
            });
        } else {
            b.others.push(path);
        }
    }
    ctx.progress
        .files
        .fetch_add(b.files.len() as u64, Ordering::Relaxed);
    ctx.progress.bytes.fetch_add(bytes, Ordering::Relaxed);
    let _ = ctx.tx.send(b);
}

/// [`visit`] through the kernel's own directory call. Each directory is opened
/// relative to its parent's handle and listed into a 64 KB buffer, so no full path
/// is parsed again and a large directory takes one call per 64 KB. Listing a volume
/// takes about half the time on a data disk (see docs/benchmarks).
#[cfg(windows)]
fn visit_nt<'s, 'c: 's>(
    s: &rayon::Scope<'s>,
    ctx: &'c Ctx<'c>,
    handle: std::sync::Arc<nt::Dir>,
    dir: PathBuf,
    depth: usize,
) {
    if ctx.progress.cancelled() {
        return;
    }
    let mut b = Batch {
        dir,
        files: Vec::new(),
        modified: Vec::new(),
        subdirs: Vec::new(),
        others: Vec::new(),
        skipped: 0,
        unlistable: false,
    };
    let child_depth = depth + 1;
    let descend = ctx.max_depth.map_or(true, |m| child_depth < m);
    let mut bytes = 0u64;
    let listed = nt::list(&handle, ctx.progress, |entry| {
        let path = b.dir.join(entry.name());
        if entry.is_link() {
            b.others.push(path);
        } else if entry.is_dir() {
            if descend {
                let (parent, name, sub) = (handle.clone(), entry.wide_name(), path.clone());
                s.spawn(move |s| match nt::open_child(&parent, &name) {
                    Ok(child) => {
                        drop(parent);
                        visit_nt(s, ctx, std::sync::Arc::new(child), sub, child_depth);
                    }
                    Err(status) => {
                        let _ = ctx.tx.send(Batch {
                            dir: sub,
                            files: Vec::new(),
                            modified: Vec::new(),
                            subdirs: Vec::new(),
                            others: Vec::new(),
                            skipped: 1,
                            unlistable: !nt::is_gone(status),
                        });
                    }
                });
            }
            b.subdirs.push(path);
        } else {
            let size = if entry.attributes() & crate::WEIRD_ATTRIBUTES != 0 {
                crate::compressed_size(&path).unwrap_or(entry.length())
            } else {
                entry.length()
            };
            bytes += size;
            b.modified.push(entry.modified_ns());
            b.files.push(FileEntry {
                path,
                size,
                logical_size: entry.length(),
            });
        }
    });
    if let Err(status) = listed {
        b.skipped += 1;
        b.unlistable = b.files.is_empty() && b.subdirs.is_empty() && !nt::is_gone(status);
    }
    ctx.progress
        .files
        .fetch_add(b.files.len() as u64, Ordering::Relaxed);
    ctx.progress.bytes.fetch_add(bytes, Ordering::Relaxed);
    let _ = ctx.tx.send(b);
}

/// The kernel's directory calls, which `FindFirstFile` is itself built on.
#[cfg(windows)]
mod nt {
    use std::cell::RefCell;
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::Path;

    use crate::Progress;

    const LIST_DIRECTORY_AND_SYNCHRONIZE: u32 = 0x0010_0001;
    const SHARE_ALL: u32 = 7;
    /// `FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT`.
    const OPEN_OPTIONS: u32 = 0x0000_4021;
    const CASE_INSENSITIVE: u32 = 0x40;
    const FILE_FULL_DIRECTORY_INFORMATION: u32 = 2;
    const NO_MORE_FILES: i32 = 0x8000_0006_u32 as i32;
    const NO_SUCH_FILE: i32 = 0xC000_000F_u32 as i32;
    const NAME_NOT_FOUND: i32 = 0xC000_0034_u32 as i32;
    const PATH_NOT_FOUND: i32 = 0xC000_003A_u32 as i32;
    const ATTRIBUTE_DIRECTORY: u32 = 0x10;
    const ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    const REPARSE_NAME_SURROGATE: u32 = 0x2000_0000;
    const WINDOWS_TO_UNIX_EPOCH: u64 = 116_444_736_000_000_000;
    const BUFFER_BYTES: usize = 64 * 1024;

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }

    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root_directory: *mut c_void,
        object_name: *const UnicodeString,
        attributes: u32,
        security_descriptor: *mut c_void,
        security_quality_of_service: *mut c_void,
    }

    #[repr(C)]
    struct IoStatusBlock {
        status: usize,
        information: usize,
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtOpenFile(
            handle: *mut *mut c_void,
            access: u32,
            attributes: *const ObjectAttributes,
            io: *mut IoStatusBlock,
            share: u32,
            options: u32,
        ) -> i32;
        #[allow(clippy::too_many_arguments)]
        fn NtQueryDirectoryFile(
            handle: *mut c_void,
            event: *mut c_void,
            apc: *mut c_void,
            apc_context: *mut c_void,
            io: *mut IoStatusBlock,
            buffer: *mut c_void,
            length: u32,
            class: u32,
            single: u8,
            name: *const UnicodeString,
            restart: u8,
        ) -> i32;
        fn NtClose(handle: *mut c_void) -> i32;
    }

    /// An open directory.
    pub(super) struct Dir(*mut c_void);

    // SAFETY: a kernel handle may be used from any thread, and it is only read.
    unsafe impl Send for Dir {}
    // SAFETY: as above.
    unsafe impl Sync for Dir {}

    impl Drop for Dir {
        fn drop(&mut self) {
            // SAFETY: the handle came from NtOpenFile and is closed once.
            unsafe { NtClose(self.0) };
        }
    }

    fn open(parent: *mut c_void, name: &[u16]) -> Result<Dir, i32> {
        let bytes = u16::try_from(name.len() * 2).map_err(|_| PATH_NOT_FOUND)?;
        let object = UnicodeString {
            length: bytes,
            maximum_length: bytes,
            buffer: name.as_ptr(),
        };
        let attributes = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root_directory: parent,
            object_name: &object,
            attributes: CASE_INSENSITIVE,
            security_descriptor: std::ptr::null_mut(),
            security_quality_of_service: std::ptr::null_mut(),
        };
        let mut handle = std::ptr::null_mut();
        let mut io = IoStatusBlock {
            status: 0,
            information: 0,
        };
        // SAFETY: every pointer is to a live local, and `name` outlives the call.
        let status = unsafe {
            NtOpenFile(
                &mut handle,
                LIST_DIRECTORY_AND_SYNCHRONIZE,
                &attributes,
                &mut io,
                SHARE_ALL,
                OPEN_OPTIONS,
            )
        };
        if status < 0 {
            Err(status)
        } else {
            Ok(Dir(handle))
        }
    }

    /// The root by its full path. `None` for anything else than a plain local or
    /// network path: the ordinary route handles those.
    pub(super) fn open_root(root: &Path) -> Option<Dir> {
        let full = std::path::absolute(root).ok()?;
        let text = full.as_os_str().to_str()?;
        let trimmed = if text.len() > 3 {
            text.trim_end_matches('\\')
        } else {
            text
        };
        let device = if let Some(rest) = trimmed.strip_prefix(r"\\?\") {
            format!(r"\??\{rest}")
        } else if let Some(rest) = trimmed.strip_prefix(r"\\") {
            format!(r"\??\UNC\{rest}")
        } else {
            format!(r"\??\{trimmed}")
        };
        let name: Vec<u16> = std::ffi::OsStr::new(&device).encode_wide().collect();
        open(std::ptr::null_mut(), &name).ok()
    }

    pub(super) fn open_child(parent: &Dir, name: &[u16]) -> Result<Dir, i32> {
        open(parent.0, name)
    }

    /// The folder went away during the scan: it is gone, not unreadable.
    pub(super) fn is_gone(status: i32) -> bool {
        status == NAME_NOT_FOUND || status == PATH_NOT_FOUND || status == NO_SUCH_FILE
    }

    /// One `FILE_FULL_DIR_INFORMATION` record in the listing buffer.
    pub(super) struct Entry<'a>(&'a [u8]);

    impl Entry<'_> {
        fn u32_at(&self, at: usize) -> u32 {
            u32::from_le_bytes([self.0[at], self.0[at + 1], self.0[at + 2], self.0[at + 3]])
        }

        fn u64_at(&self, at: usize) -> u64 {
            u64::from(self.u32_at(at)) | (u64::from(self.u32_at(at + 4)) << 32)
        }

        pub(super) fn attributes(&self) -> u32 {
            self.u32_at(56)
        }

        pub(super) fn length(&self) -> u64 {
            self.u64_at(40)
        }

        /// As the standard library sees it: a link is a reparse point whose tag
        /// stands for another name. A cloud folder is a folder.
        pub(super) fn is_link(&self) -> bool {
            self.attributes() & ATTRIBUTE_REPARSE_POINT != 0
                && self.u32_at(64) & REPARSE_NAME_SURROGATE != 0
        }

        pub(super) fn is_dir(&self) -> bool {
            self.attributes() & ATTRIBUTE_DIRECTORY != 0
        }

        pub(super) fn modified_ns(&self) -> u64 {
            self.u64_at(24)
                .saturating_sub(WINDOWS_TO_UNIX_EPOCH)
                .saturating_mul(100)
        }

        pub(super) fn wide_name(&self) -> Vec<u16> {
            let bytes = self.u32_at(60) as usize;
            self.0[68..68 + bytes]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect()
        }

        pub(super) fn name(&self) -> OsString {
            OsString::from_wide(&self.wide_name())
        }
    }

    thread_local! {
        /// One buffer per walking thread, as 8-byte words for the alignment the
        /// kernel asks for.
        static BUFFER: RefCell<Vec<u64>> = RefCell::new(vec![0; BUFFER_BYTES / 8]);
    }

    /// Call `each` on everything in `dir` but `.` and `..`.
    pub(super) fn list(
        dir: &Dir,
        progress: &Progress,
        mut each: impl FnMut(&Entry),
    ) -> Result<(), i32> {
        BUFFER.with(|buffer| {
            let mut buffer = buffer.borrow_mut();
            let mut restart = 1;
            loop {
                if progress.cancelled() {
                    return Ok(());
                }
                let mut io = IoStatusBlock {
                    status: 0,
                    information: 0,
                };
                // SAFETY: the buffer is writable for the length passed, the handle is
                // open and synchronous, and the other pointers may be null.
                let status = unsafe {
                    NtQueryDirectoryFile(
                        dir.0,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        &mut io,
                        buffer.as_mut_ptr().cast(),
                        BUFFER_BYTES as u32,
                        FILE_FULL_DIRECTORY_INFORMATION,
                        0,
                        std::ptr::null(),
                        restart,
                    )
                };
                restart = 0;
                if status == NO_MORE_FILES {
                    return Ok(());
                }
                if status < 0 {
                    return Err(status);
                }
                // SAFETY: `u64` to `u8` loosens alignment, and the length is the
                // buffer's own. The kernel filled `information` of these bytes.
                let bytes: &[u8] = unsafe {
                    std::slice::from_raw_parts(
                        buffer.as_ptr().cast(),
                        io.information.min(BUFFER_BYTES),
                    )
                };
                let mut at = 0;
                while at + 68 <= bytes.len() {
                    let record = Entry(&bytes[at..]);
                    let next = record.u32_at(0) as usize;
                    let name_bytes = record.u32_at(60) as usize;
                    if at + 68 + name_bytes > bytes.len() {
                        break;
                    }
                    let name = &record.0[68..68 + name_bytes];
                    let dots = name == [46, 0] || name == [46, 0, 46, 0];
                    if !dots {
                        each(&record);
                    }
                    if next == 0 {
                        break;
                    }
                    at += next;
                }
            }
        })
    }
}

/// Modification time in nanoseconds since the Unix epoch (0 if unknown).
pub(crate) fn modified_ns(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
}
