//! Where Save writes. With a folder chosen (decision D-07), the page asks for it
//! through the system picker and then writes plain files named by the moment
//! into it. The folder's path stays here: the page only ever gets the folder's
//! name, and it can only write `.txt`, `.md` or `.docx` files named
//! "YYYY-MM-DD HH-MM-SS" into the folder the user picked. The page sends text
//! only: the app makes a Word document itself (docx.rs), so no file is ever
//! written from bytes the page made. Without a folder, Save shows the system
//! save panel through `save_download` (D-49), starting in the Downloads folder
//! with the name the page proposes, and writes the file where the panel put
//! it, so the page learns whether the file was really written (DM-202).
//!
//! The macOS App Sandbox (D-37) lets an app into a folder only after the user
//! picks it in the system panel. So the folder is remembered as a
//! security-scoped bookmark (bookmark.rs), which lets the app back in after a
//! quit.

use std::borrow::Cow;

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{Manager, Runtime, State, WebviewWindow};

use crate::bookmark::{Access, Bookmarks, Opened, System};
use crate::docx::docx;

/// The file in the app's data folder that holds the bookmark.
const BOOKMARK: &str = "folder.bookmark";

/// The file in which the app kept the folder's plain path before the sandbox.
const PLAIN_PATH: &str = "folder.txt";

/// The remembered folder, in memory and, as a bookmark, in a small file in the
/// app's data directory, so that it survives a quit.
pub struct Folder {
    /// Where the bookmark is kept on disk; None if the data directory is unknown.
    file: Option<PathBuf>,
    /// The system's bookmarks; a stand-in in the tests.
    bookmarks: Box<dyn Bookmarks>,
    /// The folder. Writes hold the lock, so two saves run one after the other.
    current: Mutex<Option<Remembered>>,
}

/// A remembered folder.
enum Remembered {
    /// Save writes into `path`. The sandbox's access to the folder is held
    /// until the folder is forgotten or replaced, which drops it.
    Open { path: PathBuf, _access: Access },
    /// The bookmark did not open at launch: a folder on a drive that is not
    /// plugged in, say. It stays remembered and shown under its name, the
    /// next write tries the bookmark again, and until it opens a write fails
    /// and the page says so.
    Closed { bookmark: Vec<u8>, name: String },
}

impl Remembered {
    fn shown(&self) -> Shown {
        match self {
            Remembered::Open { path, .. } => Shown::of(path),
            Remembered::Closed { name, .. } => Shown { name: name.clone() },
        }
    }
}

impl Folder {
    /// Reads the choice once, at start, through the system's bookmarks.
    pub fn load(data_dir: Option<PathBuf>) -> Self {
        Folder::with(data_dir, Box::new(System))
    }

    fn with(data_dir: Option<PathBuf>, bookmarks: Box<dyn Bookmarks>) -> Self {
        if let Some(dir) = &data_dir {
            // The build before the sandbox kept the folder's plain path in
            // folder.txt. Inside the sandbox a path opens nothing: the app may
            // only enter a folder the user picked in the panel, or one that a
            // bookmark lets it back into. So that file counts as no folder and
            // is removed, and the page asks for the folder again.
            let _ = fs::remove_file(dir.join(PLAIN_PATH));
        }
        let file = data_dir.map(|dir| dir.join(BOOKMARK));
        let current = file
            .as_deref()
            .and_then(|file| reopen(file, bookmarks.as_ref()));
        Folder {
            file,
            bookmarks,
            current: Mutex::new(current),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Option<Remembered>>, String> {
        self.current
            .lock()
            .map_err(|_| "The folder is not available".to_owned())
    }

    /// Remembers a newly chosen folder: its bookmark is made and opened, kept
    /// on disk, and then held in memory. All of that comes before the folder
    /// it replaces is let go, so a failure leaves that folder in use.
    fn remember(&self, path: PathBuf) -> Result<Shown, String> {
        let file = self
            .file
            .as_deref()
            .ok_or("The app's data folder is not available")?;
        let mut current = self.lock()?;
        let failed = |e: String| format!("Could not remember the folder: {e}");
        // The panel may hand back a symbolic link to a folder, and the system
        // makes no bookmark of a link (QA-F-14, bookmark.rs), so the link is
        // followed first: the folder kept is the one it points to.
        let path = path.canonicalize().map_err(|e| failed(e.to_string()))?;
        let bookmark = self.bookmarks.create(&path).map_err(failed)?;
        let opened = self.bookmarks.open(&bookmark).map_err(failed)?;
        store(file, opened.renewed.as_deref().unwrap_or(&bookmark))
            .map_err(|e| failed(e.to_string()))?;
        let folder = Remembered::Open {
            path: opened.path,
            _access: opened.access,
        };
        let shown = folder.shown();
        // The folder this replaces is dropped here, which stops the app's
        // access to it.
        *current = Some(folder);
        Ok(shown)
    }

    fn shown(&self) -> Result<Option<Shown>, String> {
        Ok(self.lock()?.as_ref().map(Remembered::shown))
    }

    /// Forgets the folder, on disk first and then in memory, so a failure
    /// leaves it remembered in both and the page, which keeps showing it,
    /// still agrees with the app (DM-220). Dropping it from memory stops the
    /// app's access to it.
    fn forget(&self) -> Result<(), String> {
        let mut current = self.lock()?;
        if let Some(Err(e)) = self.file.as_deref().map(fs::remove_file) {
            if e.kind() != ErrorKind::NotFound {
                return Err(format!("Could not forget the folder: {e}"));
            }
        }
        *current = None;
        Ok(())
    }

    /// Writes the text into the folder as `<base><ext>`, numbered if that name
    /// is taken, and returns the file name used: `.txt` and `.md` hold the
    /// text as it is, `.docx` a Word document made from it. The lock is held
    /// while writing, so two saves in the same second are written one after
    /// the other.
    fn write(&self, base: &str, ext: &str, text: &str) -> Result<String, String> {
        if !is_moment(base) {
            return Err("The file name must be a moment, YYYY-MM-DD HH-MM-SS".to_owned());
        }
        if !PLAIN_EXTENSIONS.contains(&ext) {
            return Err("Save writes only .txt, .md and .docx files into the folder".to_owned());
        }
        let name = format!("{base}{ext}");
        let failed = |e: String| format!("Could not write the file: {e}");
        let bytes = file_bytes(&name, text).map_err(failed)?;
        let mut current = self.lock()?;
        let folder = current.as_mut().ok_or("No folder is chosen")?;
        let dir = match folder {
            Remembered::Open { path, .. } => path.clone(),
            Remembered::Closed { bookmark, .. } => {
                let file = self
                    .file
                    .as_deref()
                    .ok_or("The app's data folder is not available")?;
                let opened = self.bookmarks.open(bookmark).map_err(failed)?;
                let path = opened.path.clone();
                *folder = kept(file, opened);
                path
            }
        };
        write_new(&dir, &name, &bytes).map_err(|e| failed(e.to_string()))
    }
}

/// The folder whose bookmark is kept in `file`, or None if there is none. A
/// bookmark that does not open is kept as a closed folder; data that is not a
/// bookmark counts as no folder and is removed, like folder.txt.
fn reopen(file: &Path, bookmarks: &dyn Bookmarks) -> Option<Remembered> {
    let bookmark = fs::read(file).ok()?;
    if let Ok(opened) = bookmarks.open(&bookmark) {
        return Some(kept(file, opened));
    }
    match bookmarks.name(&bookmark) {
        Some(name) => Some(Remembered::Closed { bookmark, name }),
        None => {
            let _ = fs::remove_file(file);
            None
        }
    }
}

/// An opened folder as the app keeps it. A stale bookmark is replaced on disk
/// by its renewal; if that write fails, the old bookmark stays, which still
/// opens and is renewed at the next launch.
fn kept(file: &Path, opened: Opened) -> Remembered {
    if let Some(fresh) = &opened.renewed {
        let _ = store(file, fresh);
    }
    Remembered::Open {
        path: opened.path,
        _access: opened.access,
    }
}

/// What the page may know about a folder: its name, never its path.
#[derive(Serialize)]
pub struct Shown {
    name: String,
}

impl Shown {
    fn of(path: &Path) -> Self {
        let name = path.file_name().unwrap_or(path.as_os_str());
        Shown {
            name: name.to_string_lossy().into_owned(),
        }
    }
}

// The folder commands the page may call (build.rs, capabilities/main.json).
// Each one only hands over to the Folder above, where the rules are and are
// tested; save_download, below, writes where the save panel says.

/// Shows the system folder picker. On a choice the folder is remembered and
/// its name returned; Cancel returns None and changes nothing.
#[tauri::command]
pub async fn pick_folder<R: Runtime>(
    window: WebviewWindow<R>,
    folder: State<'_, Folder>,
) -> Result<Option<Shown>, String> {
    match choose(window).await? {
        Some(path) => folder.remember(path).map(Some),
        None => Ok(None),
    }
}

/// The folder remembered from an earlier run, or None.
#[tauri::command(async)]
pub fn saved_folder(folder: State<'_, Folder>) -> Result<Option<Shown>, String> {
    folder.shown()
}

#[tauri::command(async)]
pub fn forget_folder(folder: State<'_, Folder>) -> Result<(), String> {
    folder.forget()
}

#[tauri::command(async)]
pub fn write_text_file(
    base: String,
    ext: String,
    text: String,
    folder: State<'_, Folder>,
) -> Result<String, String> {
    folder.write(&base, &ext, &text)
}

/// Save without a folder: the system save panel, started in the Downloads
/// folder with the name the page proposes (D-49). The file is written where
/// the panel put it, under the name chosen there, replacing a file that is
/// already there, since the panel itself confirmed that with the user; every
/// other write the app makes stays create-new. Cancel answers None and the
/// page shows nothing; a failed write reaches the page, which says so.
#[tauri::command]
pub async fn save_download<R: Runtime>(
    window: WebviewWindow<R>,
    name: String,
    text: String,
) -> Result<Option<String>, String> {
    save_through(&name, &text, |proposed| save_as(window, proposed)).await
}

/// Save without a folder, with the panel handed in, so that the command's
/// own path is unit-tested (QA-G-26): the proposed name is checked before
/// anything else, so a name that is not one Save makes, or that holds a
/// path, never reaches a panel; then the file's bytes are made, the panel
/// asked, and the file written where it said, under the name chosen there.
/// The panel keeps the proposed format's extension, and so must its answer:
/// one with another extension is refused before anything is staged or
/// written, so the bytes of one format are never written under the name of
/// another (DM-238).
async fn save_through<F, Fut>(name: &str, text: &str, panel: F) -> Result<Option<String>, String>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<Option<PathBuf>, String>>,
{
    if !is_download_name(name) {
        return Err("The file name is not one Save makes".to_owned());
    }
    let (ext, _) = proposed_format(name).ok_or("The file name is not one Save makes")?;
    let bytes = file_bytes(name, text).map_err(|e| format!("Could not save the file: {e}"))?;
    let Some(path) = panel(name.to_owned()).await? else {
        return Ok(None);
    };
    // The panel keeps the proposed extension (its one allowed file type), and
    // the test build's stand-in must too: checked here, before anything is
    // staged or written (DM-238).
    if !has_extension(&path, ext) {
        return Err(format!("the name must end in .{ext}"));
    }
    let chosen = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_owned());
    write_replacing(&path, &bytes).map_err(|e| format!("Could not save the file: {e}"))?;
    Ok(Some(chosen))
}

/// The system save panel: a sheet on the document window, starting in the
/// Downloads folder with the proposed name and the proposed format's
/// extension as its one allowed file type, with a New Folder button. None
/// when cancelled. In the sandbox the panel itself lets the app write the file
/// the user chose (the user-selected entitlement), so Downloads needs none.
async fn save_as<R: Runtime>(
    window: WebviewWindow<R>,
    name: String,
) -> Result<Option<PathBuf>, String> {
    // Test builds only: the end-to-end tests run while the screen is locked,
    // where no panel can be used, so they name the panel's answer in the
    // environment: a file, or a folder that takes the proposed name.
    #[cfg(feature = "e2e")]
    if let Some(stand_in) = std::env::var_os("PLAIN_SIGHT_E2E_SAVE_AS") {
        let path = PathBuf::from(stand_in);
        if !path.is_absolute() {
            return Err("PLAIN_SIGHT_E2E_SAVE_AS must be an absolute path".to_owned());
        }
        return Ok(Some(if path.is_dir() {
            path.join(&name)
        } else {
            path
        }));
    }
    let start = downloads_dir(&window).ok();
    let parent = window.clone();
    let filter = proposed_format(&name);
    let proposed = name;
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    // AppKit panels belong to the main thread: rfd builds the panel and starts
    // the sheet there and hands back a future that completes when the user
    // saves or cancels.
    window
        .run_on_main_thread(move || {
            let mut dialog = rfd::AsyncFileDialog::new()
                .set_parent(&parent)
                .set_title("Save")
                .set_file_name(proposed)
                .set_can_create_directories(true);
            // The one allowed extension, the proposed format's: on macOS rfd
            // hands the panel every filter's extensions as its allowed file
            // types (rfd 0.17.2, src/backend/macos/file_dialog/panel_ffi.rs,
            // `add_filters`, `setAllowedFileTypes`), so a name typed without
            // an extension gets this one and the panel keeps it (AppKit,
            // NSSavePanel.h, `allowedFileTypes`); `save_through` checks the
            // answer's extension as well, for the test build's stand-in.
            if let Some((ext, label)) = filter {
                dialog = dialog.add_filter(label, &[ext]);
            }
            if let Some(start) = start {
                dialog = dialog.set_directory(start);
            }
            let _ = sender.try_send(dialog.save_file());
        })
        .map_err(|e| e.to_string())?;
    let chosen = receiver.recv().await.ok_or("The save panel did not open")?;
    Ok(chosen.await.map(|handle| handle.path().to_path_buf()))
}

/// Writes `bytes` to the path the save panel returned, replacing what is
/// there: the panel already asked the user about a replacement. The new
/// content is written whole into a file of its own first, and only then takes
/// the chosen file's place in one step, so a write that fails while the new
/// content is being written (a full disk, tested on a disk image) leaves the
/// file as it was (QA-G-21). A replacement Foundation refuses (a folder the
/// person may not change, tested on a disk image) comes back as the error
/// and leaves the file as it was too; Apple says the original may then be
/// at another location, named under NSFileOriginalItemLocationKey in
/// Foundation's error; the app shows only the error's description and does
/// not pass that location on. The step is Foundation's replacement of a
/// file, the same operation NSDocument performs when it saves (Apple,
/// Low-Level File Management Programming Topics, File Management, Moving,
/// Copying, and Deleting Files, a retired document), and the staged file
/// sits in the directory Foundation names for it on the chosen file's own
/// volume (`replacing`).
/// Where nothing is at the path yet, the same step puts the new file there.
///
/// Only a file, or nothing, may be at the path (QA-G-29). A folder there is
/// refused before anything is staged, since the replacement would put the
/// file in the folder's place with everything in it gone. A symbolic link
/// there is refused too: the panel asked about the link's name, and a write
/// through the link would land on the file it points to, which the person
/// did not name (the write before this one went through it; Foundation's
/// replacement refuses it as a missing file). The page then says "Could not
/// save", and the person can choose another name.
fn write_replacing(path: &Path, bytes: &[u8]) -> io::Result<()> {
    // The link itself, not what it points to, is what is at the path.
    if let Ok(found) = fs::symlink_metadata(path) {
        if found.file_type().is_symlink() {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "the chosen name is a link to another file, which the panel did not name",
            ));
        }
        if found.is_dir() {
            return Err(io::Error::new(
                ErrorKind::IsADirectory,
                "a folder is at the chosen path",
            ));
        }
    }
    let staged = Staged::write(path, bytes)?;
    replacing::replace(path, &staged.file)
}

/// The new content of a replacing write, in a file of its own in a staging
/// directory made for it on the chosen file's volume, written whole and
/// synced before it takes the chosen file's place. Dropping the value removes
/// the file, if it is still there, and the directory, so a failed write leaves
/// nothing behind and a finished one only the replaced file.
struct Staged {
    dir: PathBuf,
    file: PathBuf,
}

impl Staged {
    fn write(target: &Path, bytes: &[u8]) -> io::Result<Staged> {
        let dir = replacing::staging_dir(target)?;
        let name = target
            .file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("file"));
        let staged = Staged {
            file: dir.join(name),
            dir,
        };
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged.file)?;
        out.write_all(bytes)?;
        out.sync_all()?;
        Ok(staged)
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.file);
        let _ = fs::remove_dir(&self.dir);
    }
}

/// Foundation's replacement of a file, for `write_replacing`:
/// `replaceItemAtURL:withItemAtURL:backupItemName:options:resultingItemURL:error:`
/// "replaces the contents of the item at the specified URL in a manner that
/// ensures no data loss occurs", and works only with both items on one volume,
/// for which `URLForDirectory:inDomain:appropriateForURL:create:error:` with
/// `NSItemReplacementDirectory` makes a temporary directory on the chosen
/// file's volume (Apple, `FileManager`, the pages of those two methods, and
/// Foundation's `NSFileManager.h`: the new item "should be placed in a
/// temporary directory as provided by the OS"). The directory is a new one
/// for every call, and the caller removes it.
#[cfg(target_os = "macos")]
mod replacing {
    use std::io;
    use std::path::{Path, PathBuf};

    use objc2::rc::Retained;
    use objc2_foundation::{
        NSError, NSFileManager, NSFileManagerItemReplacementOptions, NSSearchPathDirectory,
        NSSearchPathDomainMask, NSString, NSURL,
    };

    fn url(path: &Path) -> io::Result<Retained<NSURL>> {
        let text = path
            .to_str()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the path is not UTF-8"))?;
        // `fileURLWithPath:` answers nil for an empty path and for one that
        // holds a NUL byte, and objc2 stops the app on a nil it does not
        // expect; neither names a file, so both are refused here (QA-G-29).
        if text.is_empty() || text.contains('\0') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the path is empty or holds a NUL byte",
            ));
        }
        Ok(NSURL::fileURLWithPath(&NSString::from_str(text)))
    }

    fn failed(error: &NSError) -> io::Error {
        io::Error::other(error.localizedDescription().to_string())
    }

    /// A new, empty directory for the file that will replace `target`, on
    /// the same volume.
    pub fn staging_dir(target: &Path) -> io::Result<PathBuf> {
        let target = url(target)?;
        let dir = NSFileManager::defaultManager()
            .URLForDirectory_inDomain_appropriateForURL_create_error(
                NSSearchPathDirectory::ItemReplacementDirectory,
                NSSearchPathDomainMask::UserDomainMask,
                Some(&*target),
                true,
            )
            .map_err(|e| failed(&e))?;
        let path = dir
            .path()
            .ok_or_else(|| io::Error::other("the staging directory has no path"))?;
        Ok(PathBuf::from(path.to_string()))
    }

    /// Puts `staged` in `target`'s place in one step, whether or not a file
    /// is at `target` yet; on a failure the file at `target` is as it was.
    pub fn replace(target: &Path, staged: &Path) -> io::Result<()> {
        let target = url(target)?;
        let staged = url(staged)?;
        NSFileManager::defaultManager()
            .replaceItemAtURL_withItemAtURL_backupItemName_options_resultingItemURL_error(
                &target,
                &staged,
                None,
                NSFileManagerItemReplacementOptions::empty(),
                None,
            )
            .map_err(|e| failed(&e))
    }
}

/// Elsewhere (Windows comes later) there is no sandbox: the staged file goes
/// into a directory of its own next to the chosen file and is renamed over it.
#[cfg(not(target_os = "macos"))]
mod replacing {
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    pub fn staging_dir(target: &Path) -> io::Result<PathBuf> {
        static COUNT: AtomicU64 = AtomicU64::new(0);
        let parent = target
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the path has no folder"))?;
        let dir = parent.join(format!(
            ".plain-sight-save-{}-{}",
            std::process::id(),
            COUNT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir)?;
        Ok(dir)
    }

    pub fn replace(target: &Path, staged: &Path) -> io::Result<()> {
        std::fs::rename(staged, target)
    }
}

/// The folder the save panel starts in: the user's Downloads folder.
fn downloads_dir<R: Runtime>(window: &WebviewWindow<R>) -> Result<PathBuf, String> {
    // Test builds only: the end-to-end tests name a folder of their own, so a
    // run never touches the real Downloads folder (Mac_PS_010).
    #[cfg(feature = "e2e")]
    if let Some(dir) = std::env::var_os("PLAIN_SIGHT_E2E_DOWNLOADS") {
        return Ok(PathBuf::from(dir));
    }
    window
        .path()
        .download_dir()
        .map_err(|_| "The Downloads folder is not available".to_owned())
}

/// The plain files Save writes, by extension (index.html, PLAIN_FORMATS).
const PLAIN_EXTENSIONS: [&str; 3] = [".txt", ".md", ".docx"];

/// The formats Save proposes to the save panel, by extension, each with the
/// name its filter gets (rfd shows the name on Windows and Linux only; on
/// macOS the extensions become the panel's allowed file types).
const PANEL_FORMATS: [(&str, &str); 4] = [
    ("txt", "Plain text"),
    ("md", "Markdown"),
    ("docx", "Word document"),
    ("sight", "Plain Sight file"),
];

/// The proposed name's format: its extension without the dot and the
/// filter's name. None for a name that ends in none of the four.
fn proposed_format(name: &str) -> Option<(&'static str, &'static str)> {
    PANEL_FORMATS
        .into_iter()
        .find(|(ext, _)| name.rsplit_once('.').is_some_and(|(_, e)| e == *ext))
}

/// Whether the path's extension is `ext`, in any case: the panel keeps the
/// proposed extension, and the test build's stand-in must too (DM-238).
fn has_extension(path: &Path, ext: &str) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

/// What goes into a file Save writes: for a `.docx`, a Word document made
/// from the text (docx.rs); for every other name, the text as it is.
fn file_bytes<'a>(name: &str, text: &'a str) -> Result<Cow<'a, [u8]>, String> {
    if name.ends_with(".docx") {
        docx(text).map(Cow::Owned)
    } else {
        Ok(Cow::Borrowed(text.as_bytes()))
    }
}

/// A name Save gives a download, and nothing else: "YYYY-MM-DD HH-MM-SS"
/// followed by ".txt", ".md" or ".docx", or a cover's title in lower case with
/// hyphens followed by "-YYYYMMDD-HHMM.sight" (index.html, onSave).
fn is_download_name(name: &str) -> bool {
    // "-YYYYMMDD-HHMM" is the last 14 characters of a .sight name; the title
    // comes before it.
    const STAMP: &[u8] = b"-00000000-0000";
    if let Some(stem) = PLAIN_EXTENSIONS
        .iter()
        .find_map(|ext| name.strip_suffix(ext))
    {
        return is_moment(stem);
    }
    let Some(stem) = name.strip_suffix(".sight") else {
        return false;
    };
    if !stem.is_ascii() || stem.len() <= STAMP.len() {
        return false;
    }
    let (title, stamp) = stem.split_at(stem.len() - STAMP.len());
    let stamp_ok = stamp.bytes().zip(STAMP).all(|(b, &s)| {
        if s == b'0' {
            b.is_ascii_digit()
        } else {
            b == s
        }
    });
    let title_ok = title.len() <= 60
        && !title.starts_with('-')
        && !title.ends_with('-')
        && !title.contains("--")
        && title
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    stamp_ok && title_ok
}

/// The system folder picker: folders only, a sheet on the document window,
/// starting in Documents, with a New Folder button. None when cancelled.
///
/// In the sandbox the panel itself lets the app into the chosen folder until
/// the app quits (Apple: the system starts access on URLs from open panels).
/// rfd hands back only the path, so that access cannot be stopped early; the
/// access that remember() starts through the folder's bookmark is the one
/// stopped when the folder is forgotten or replaced.
async fn choose<R: Runtime>(window: WebviewWindow<R>) -> Result<Option<PathBuf>, String> {
    // Test builds only: the end-to-end tests run while the screen is locked,
    // where no panel can be used, so they name the folder in the environment.
    #[cfg(feature = "e2e")]
    if let Some(path) = std::env::var_os("PLAIN_SIGHT_E2E_PICK").map(PathBuf::from) {
        return match path.is_absolute() {
            true => Ok(Some(path)),
            false => Err("PLAIN_SIGHT_E2E_PICK must be an absolute path".to_owned()),
        };
    }
    let start = window.path().document_dir().ok();
    let parent = window.clone();
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    // AppKit panels belong to the main thread: rfd builds the panel and starts
    // the sheet there (as tauri-plugin-dialog does) and hands back a future
    // that completes when the user chooses or cancels.
    window
        .run_on_main_thread(move || {
            let mut dialog = rfd::AsyncFileDialog::new()
                .set_parent(&parent)
                .set_title("Choose the folder Save writes into")
                .set_can_create_directories(true);
            if let Some(start) = start {
                dialog = dialog.set_directory(start);
            }
            let _ = sender.try_send(dialog.pick_folder());
        })
        .map_err(|e| e.to_string())?;
    let chosen = receiver
        .recv()
        .await
        .ok_or("The folder picker did not open")?;
    Ok(chosen.await.map(|handle| handle.path().to_path_buf()))
}

/// Keeps the bookmark in `file` atomically: a temporary file in the same
/// directory, flushed to disk, then renamed over the old one, so a crash never
/// leaves half a bookmark behind.
fn store(file: &Path, bookmark: &[u8]) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let temp = file.with_extension("tmp");
    let mut out = fs::File::create(&temp)?;
    out.write_all(bookmark)?;
    out.sync_all()?;
    fs::rename(&temp, file)
}

/// The page's rule for file names (index.html, folderWrite): the name itself,
/// then " (2)", " (3)" and so on before the extension, with no last number, so
/// the names never run out. The page counts on past " (99)" since 1.4.0
/// (QA-F-10), and so does the app. Folder files take the first of these that
/// is free; a file saved through the save panel is named there (D-49).
pub fn numbered(name: &str) -> impl Iterator<Item = String> + '_ {
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    std::iter::once(name.to_owned())
        .chain((2_u64..).map(move |n| format!("{stem} ({n}){extension}")))
}

/// A base name the page may write: exactly the moment "YYYY-MM-DD HH-MM-SS".
/// Nothing else gets through: no path, no extension, no other name.
fn is_moment(base: &str) -> bool {
    const SHAPE: &[u8] = b"0000-00-00 00-00-00";
    base.len() == SHAPE.len()
        && base.bytes().zip(SHAPE).all(|(b, &s)| {
            if s == b'0' {
                b.is_ascii_digit()
            } else {
                b == s
            }
        })
}

/// Writes `bytes` into a new file in `dir` under the first free name and
/// returns that name. create_new makes the system itself refuse a name that
/// exists, even one another save created a moment ago, so no file is ever
/// overwritten; and since the names never run out, a save is never refused
/// because every name is taken (QA-F-10).
fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<String> {
    for candidate in numbered(name) {
        let path = dir.join(&candidate);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        // One write, then wait for the disk, so a reported save is really on it.
        if let Err(e) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            let _ = fs::remove_file(&path); // a failed save leaves no partial file
            return Err(e);
        }
        return Ok(candidate);
    }
    // numbered() has no last name, so the loop above only ends by a return.
    Err(io::Error::new(
        ErrorKind::AlreadyExists,
        "no free name was found",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const BASE: &str = "2026-10-20 14-55-03";

    /// A fresh, empty directory for one test, by its canonical path, which is
    /// what the app keeps of a chosen folder.
    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("plain-sight-unit-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    /// A stand-in for the system's bookmarks, which logs each folder opened
    /// and each access stopped, with the folder whose bookmark was on disk at
    /// that moment. Its bookmark of a folder is "bookmark:" and the path, or
    /// "stale:" and the path for one that needs renewing. Like the system's,
    /// it is made only of a folder that exists and opens while it exists.
    #[derive(Clone)]
    struct Fake {
        log: Arc<Mutex<Vec<String>>>,
        file: PathBuf,
    }

    impl Fake {
        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }

        fn note(&self, line: String) {
            self.log.lock().unwrap().push(line);
        }

        /// The name of the folder whose bookmark is on disk, or "nothing".
        fn on_disk(&self) -> String {
            fs::read(&self.file)
                .ok()
                .and_then(|bookmark| self.name(&bookmark))
                .unwrap_or_else(|| "nothing".to_owned())
        }
    }

    fn path_of(bookmark: &[u8]) -> Option<PathBuf> {
        let text = std::str::from_utf8(bookmark).ok()?;
        let path = text
            .strip_prefix("bookmark:")
            .or_else(|| text.strip_prefix("stale:"))?;
        Some(PathBuf::from(path))
    }

    impl Bookmarks for Fake {
        fn create(&self, folder: &Path) -> Result<Vec<u8>, String> {
            match folder.is_dir() {
                true => Ok(format!("bookmark:{}", folder.display()).into_bytes()),
                false => Err("there is no such folder".to_owned()),
            }
        }

        fn open(&self, bookmark: &[u8]) -> Result<Opened, String> {
            let path = path_of(bookmark).ok_or("not a bookmark")?;
            if !path.is_dir() {
                return Err("the folder is not there".to_owned());
            }
            let name = self.name(bookmark).unwrap();
            self.note(format!("open {name}"));
            let renewed = bookmark
                .starts_with(b"stale:")
                .then(|| format!("bookmark:{}", path.display()).into_bytes());
            let fake = self.clone();
            let access = Access::new(move || {
                let on_disk = fake.on_disk();
                fake.note(format!("stop {name}, on disk: {on_disk}"));
            });
            Ok(Opened {
                path,
                renewed,
                access,
            })
        }

        fn name(&self, bookmark: &[u8]) -> Option<String> {
            let path = path_of(bookmark)?;
            Some(path.file_name()?.to_string_lossy().into_owned())
        }
    }

    /// The app's Folder over the data folder `data`, with the stand-in.
    fn load(data: &Path) -> (Folder, Fake) {
        let fake = Fake {
            log: Arc::default(),
            file: data.join(BOOKMARK),
        };
        let folder = Folder::with(Some(data.to_path_buf()), Box::new(fake.clone()));
        (folder, fake)
    }

    fn shown_name(folder: &Folder) -> Option<String> {
        folder.shown().unwrap().map(|shown| shown.name)
    }

    #[test]
    fn only_the_names_save_makes_are_accepted_as_downloads() {
        for good in [
            "2026-10-20 14-55-03.txt",
            "2026-10-20 14-55-03.md",
            "2026-10-20 14-55-03.docx",
            "untitled-draft-20261020-1455.sight",
            "q3-planning-notes-20261020-1455.sight",
            "manuscript-draft-20261020-1455.sight",
            "draft-20261020-1455.sight",
        ] {
            assert!(is_download_name(good), "{good} is a name Save makes");
        }
        for bad in [
            "",
            ".sight",
            "-20261020-1455.sight",
            "untitled-draft-20261020-1455.txt",
            "untitled-draft-2026102-14550.sight",
            "Untitled-draft-20261020-1455.sight",
            "untitled--draft-20261020-1455.sight",
            "untitled-draft--20261020-1455.sight",
            "../untitled-draft-20261020-1455.sight",
            "a/b-20261020-1455.sight",
            "untitled draft-20261020-1455.sight",
            "untitled-draft-20261020-1455.sight.exe",
            "untitled-draft-20261020-1455 (2).sight",
            "2026-10-20 14-55-03 (2).txt",
            "2026-10-20 14-55-03.TXT",
            "2026-10-20 14-55-03.MD",
            "2026-10-20 14-55-03.doc",
            "2026-10-20 14-55-03.docm",
            "2026-10-20 14-55-03.docx.exe",
            "2026-10-20 14-55-03 (2).docx",
            "untitled-draft-20261020-1455.md",
            "notes.md",
            "notes.sh",
            "\u{e9}t\u{e9}-20261020-1455.sight",
        ] {
            assert!(!is_download_name(bad), "{bad:?} is refused");
        }
        let long = format!("{}-20261020-1455.sight", "a".repeat(61));
        assert!(
            !is_download_name(&long),
            "a title longer than 60 characters is refused"
        );
    }

    /// The command's own path (QA-G-26, F6): a proposed name that is not one
    /// Save makes, or that holds a path, is refused before any panel opens;
    /// a good name reaches the panel, and the file is written where the panel
    /// said, under the name chosen there; Cancel writes nothing.
    #[test]
    fn save_download_refuses_a_name_that_is_not_one_save_makes_before_any_panel() {
        let dir = scratch("save-through");
        let opened: Arc<Mutex<Vec<String>>> = Arc::default();
        let panel = |answer: Option<PathBuf>| {
            let opened = opened.clone();
            move |proposed: String| {
                opened.lock().unwrap().push(proposed);
                async move { Ok(answer) }
            }
        };
        for bad in [
            "notes.sh",
            "2026-10-20 14-55-03.docm",
            "2026-10-20 14-55-03.TXT",
            "../2026-10-20 14-55-03.txt",
            "2026-10-20 14-55-03.txt/../x",
            "untitled-draft-20261020-1455.sight/../../x",
            "a/b-20261020-1455.sight",
            "",
        ] {
            let result = tauri::async_runtime::block_on(save_through(
                bad,
                "text",
                panel(Some(dir.join("never.txt"))),
            ));
            assert_eq!(
                result,
                Err("The file name is not one Save makes".to_owned()),
                "{bad:?}"
            );
        }
        assert!(
            opened.lock().unwrap().is_empty(),
            "no panel opened for a refused name"
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "nothing written");
        let chosen = dir.join("chosen in the panel.txt");
        let result = tauri::async_runtime::block_on(save_through(
            "2026-10-20 14-55-03.txt",
            "the text",
            panel(Some(chosen.clone())),
        ));
        assert_eq!(
            result,
            Ok(Some("chosen in the panel.txt".to_owned())),
            "the name the panel chose comes back"
        );
        assert_eq!(
            opened.lock().unwrap().as_slice(),
            ["2026-10-20 14-55-03.txt"],
            "the panel got the proposed name"
        );
        assert_eq!(fs::read_to_string(&chosen).unwrap(), "the text");
        let result = tauri::async_runtime::block_on(save_through(
            "untitled-draft-20261020-1455.sight",
            "{}",
            panel(None),
        ));
        assert_eq!(result, Ok(None), "a cancelled panel answers None");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "and writes nothing");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The save panel keeps the proposed format's extension (DM-238): the
    /// panel is given that one extension as its allowed file type, and since
    /// the test build's stand-in can answer any path, an answer whose
    /// extension is not the proposed one is refused before anything is
    /// staged or written. The three renamed cases are the Delivery Manager's
    /// AT-R1, AT-R2 and AT-R8 (dm-appstore-2783e5d/adv, folder.rs module
    /// dm_adv), adopted with the result the fix sets: before it, notes.docx
    /// held the plain text, notes.txt the zip archive and notes.sight the
    /// plain text.
    #[test]
    fn a_panel_answer_must_keep_the_proposed_extension() {
        let dir = scratch("panel-extension");
        let answer = |path: PathBuf| move |_proposed: String| async move { Ok(Some(path)) };
        let save = |proposed: &str, text: &str, chosen: &str| {
            tauri::async_runtime::block_on(save_through(proposed, text, answer(dir.join(chosen))))
        };
        // AT-R1: a plain .txt Save renamed to notes.docx in the panel.
        assert_eq!(
            save("2026-10-26 14-00-00.txt", "plain words", "notes.docx"),
            Err("the name must end in .txt".to_owned())
        );
        // AT-R2: a .docx Save renamed to notes.txt.
        assert_eq!(
            save("2026-10-26 14-00-00.docx", "plain words", "notes.txt"),
            Err("the name must end in .docx".to_owned())
        );
        // AT-R8: a plain .txt Save renamed to notes.sight.
        assert_eq!(
            save("2026-10-26 14-00-00.txt", "meet at nine", "notes.sight"),
            Err("the name must end in .txt".to_owned())
        );
        // The other two formats the same way, and a name with no extension.
        assert_eq!(
            save("2026-10-26 14-00-00.md", "# notes", "notes.txt"),
            Err("the name must end in .md".to_owned())
        );
        assert_eq!(
            save("untitled-draft-20261026-1400.sight", "{}", "notes.txt"),
            Err("the name must end in .sight".to_owned())
        );
        assert_eq!(
            save("2026-10-26 14-00-00.txt", "plain words", "notes"),
            Err("the name must end in .txt".to_owned())
        );
        // Names whose extension only ends in, or starts with, the proposed one
        // are other extensions: the Delivery Manager's AT-R10
        // (dm-appstore-534f3cc/adv/dm_adv_folder.rs), against a check that
        // took any extension ending in the proposed one (DM-246, RM24b).
        for (proposed, chosen, ext) in [
            ("2026-10-26 14-00-00.txt", "notes.xtxt", "txt"),
            ("2026-10-26 14-00-00.txt", "notes.txtx", "txt"),
            ("2026-10-26 14-00-00.docx", "notes.docx.txt", "docx"),
            ("untitled-draft-20261026-1400.sight", "notes", "sight"),
            ("untitled-draft-20261026-1400.sight", "notes.", "sight"),
            ("2026-10-26 14-00-00.md", "notes.md ", "md"),
        ] {
            assert_eq!(
                save(proposed, "near miss", chosen),
                Err(format!("the name must end in .{ext}")),
                "{proposed} answered {chosen:?}"
            );
        }
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            0,
            "nothing was written for a refused name"
        );
        // The proposed extension, in any case and under any stem, passes.
        assert_eq!(
            save("2026-10-26 14-00-00.txt", "plain words", "notes.txt"),
            Ok(Some("notes.txt".to_owned()))
        );
        assert_eq!(fs::read(dir.join("notes.txt")).unwrap(), b"plain words");
        assert_eq!(
            save("2026-10-26 14-00-00.txt", "upper case", "NOTES.TXT"),
            Ok(Some("NOTES.TXT".to_owned()))
        );
        assert_eq!(fs::read(dir.join("NOTES.TXT")).unwrap(), b"upper case");
        assert_eq!(
            save("2026-10-26 14-00-00.docx", "a document", "report.docx"),
            Ok(Some("report.docx".to_owned()))
        );
        assert_eq!(
            &fs::read(dir.join("report.docx")).unwrap()[..4],
            b"PK\x03\x04",
            "the Word document under a .docx name"
        );
        assert_eq!(
            save("2026-10-26 14-00-00.md", "# notes", "notes.md"),
            Ok(Some("notes.md".to_owned()))
        );
        assert_eq!(
            save("untitled-draft-20261026-1400.sight", "{}", "kept.sight"),
            Ok(Some("kept.sight".to_owned()))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The panel's filter and the check follow the proposed name: the one
    /// extension of each of the four formats, by name; any other name has
    /// none. The extension check reads the last extension, in any case.
    #[test]
    fn the_proposed_format_names_the_one_allowed_extension() {
        assert_eq!(
            proposed_format("2026-10-26 14-00-00.txt"),
            Some(("txt", "Plain text"))
        );
        assert_eq!(
            proposed_format("2026-10-26 14-00-00.md"),
            Some(("md", "Markdown"))
        );
        assert_eq!(
            proposed_format("2026-10-26 14-00-00.docx"),
            Some(("docx", "Word document"))
        );
        assert_eq!(
            proposed_format("untitled-draft-20261026-1400.sight"),
            Some(("sight", "Plain Sight file"))
        );
        assert_eq!(proposed_format("notes.sh"), None);
        assert_eq!(proposed_format("notes"), None);
        assert!(has_extension(Path::new("/x/notes.TXT"), "txt"), "any case");
        assert!(
            !has_extension(Path::new("/x/notes.txt.sight"), "txt"),
            "the last extension counts"
        );
        assert!(!has_extension(Path::new("/x/notes"), "txt"));
        assert!(
            !has_extension(Path::new("/x/.txt"), "txt"),
            "a name that is only an extension has none"
        );
    }

    #[test]
    fn the_first_free_name_is_the_name_itself() {
        let dir = scratch("first");
        assert_eq!(
            write_new(&dir, "2026-10-20 14-55-03.txt", b"one").unwrap(),
            "2026-10-20 14-55-03.txt"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_counter_follows_the_names_already_taken() {
        let dir = scratch("counter");
        for name in [
            "2026-10-20 14-55-03.txt",
            "2026-10-20 14-55-03 (2).txt",
            "2026-10-20 14-55-03 (3).txt",
        ] {
            fs::write(dir.join(name), "older").unwrap();
        }
        assert_eq!(
            write_new(&dir, "2026-10-20 14-55-03.txt", b"new").unwrap(),
            "2026-10-20 14-55-03 (4).txt"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The name itself and " (2)" to " (last)", spelled out here rather than
    /// taken from numbered(), so the counter's tests do not lean on it.
    fn taken_names(stem: &str, ext: &str, last: u64) -> Vec<String> {
        std::iter::once(format!("{stem}{ext}"))
            .chain((2..=last).map(|n| format!("{stem} ({n}){ext}")))
            .collect()
    }

    /// Every name up to " (99)" taken: the write goes on to " (100)", as the
    /// page's folder Save does since 1.4.0 (QA-F-10), and no file is written
    /// over.
    #[test]
    fn when_every_name_up_to_99_is_taken_the_write_goes_to_100() {
        let dir = scratch("past99");
        let taken = taken_names("2026-10-20 14-55-03", ".txt", 99);
        assert_eq!(taken.len(), 99);
        for name in &taken {
            fs::write(dir.join(name), "older").unwrap();
        }
        assert_eq!(
            write_new(&dir, "2026-10-20 14-55-03.txt", b"new").unwrap(),
            "2026-10-20 14-55-03 (100).txt"
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 100, "one file added");
        assert_eq!(
            fs::read(dir.join("2026-10-20 14-55-03 (100).txt")).unwrap(),
            b"new"
        );
        for name in &taken {
            assert_eq!(
                fs::read_to_string(dir.join(name)).unwrap(),
                "older",
                "{name} is not written over"
            );
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Further on: the name and " (2)" to " (150)" taken gives " (151)".
    #[test]
    fn when_every_name_up_to_150_is_taken_the_write_goes_to_151() {
        let dir = scratch("past150");
        let taken = taken_names("2026-10-20 14-55-03", ".md", 150);
        assert_eq!(taken.len(), 150);
        for name in &taken {
            fs::write(dir.join(name), "older").unwrap();
        }
        assert_eq!(
            write_new(&dir, "2026-10-20 14-55-03.md", b"new").unwrap(),
            "2026-10-20 14-55-03 (151).md"
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 151, "one file added");
        assert_eq!(
            fs::read(dir.join("2026-10-20 14-55-03 (151).md")).unwrap(),
            b"new"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_new_never_overwrites_and_writes_the_text_exactly() {
        let dir = scratch("twice");
        let first = write_new(&dir, "2026-10-20 14-55-03.txt", b"first text").unwrap();
        let second = write_new(
            &dir,
            "2026-10-20 14-55-03.txt",
            "second, caf\u{e9}\n".as_bytes(),
        )
        .unwrap();
        assert_eq!(first, "2026-10-20 14-55-03.txt");
        assert_eq!(second, "2026-10-20 14-55-03 (2).txt");
        assert_eq!(fs::read(dir.join(&first)).unwrap(), b"first text");
        assert_eq!(
            fs::read(dir.join(&second)).unwrap(),
            "second, caf\u{e9}\n".as_bytes(),
            "UTF-8, no BOM"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The page's rule (index.html, folderWrite, since 1.4.0): the name, then
    /// " (2)", " (3)" and so on with no last number (QA-F-10).
    #[test]
    fn names_follow_the_page_rule_past_99() {
        let names: Vec<String> = numbered("2026-10-20 14-55-03.txt").take(1000).collect();
        assert_eq!(names.len(), 1000, "the names go on past (99)");
        assert_eq!(names[0], "2026-10-20 14-55-03.txt");
        assert_eq!(names[1], "2026-10-20 14-55-03 (2).txt");
        assert_eq!(names[98], "2026-10-20 14-55-03 (99).txt");
        assert_eq!(names[99], "2026-10-20 14-55-03 (100).txt");
        assert_eq!(names[150], "2026-10-20 14-55-03 (151).txt");
        assert_eq!(names[999], "2026-10-20 14-55-03 (1000).txt");
        assert_eq!(numbered("notes").nth(1).unwrap(), "notes (2)");
        assert_eq!(numbered("a.b.txt").nth(1).unwrap(), "a.b (2).txt");
        assert_eq!(numbered(".sight").nth(1).unwrap(), ".sight (2)");
    }

    #[test]
    fn only_a_moment_is_accepted_as_a_base_name() {
        assert!(is_moment(BASE));
        let refused = [
            "",
            "/",
            "2026-10-20/14-55-03",
            "..",
            "2026-10-20 ../55-03",
            "2026-10-20 14-55-0\0",
            "2026-10-20\n14-55-03",
            "2026-10-20 14-55-03.txt",
            "2026-10-20 14-55-033",
            "2026-10-20 14-55-0",
            "2026-1O-20 14-55-03",
            "abcd-ef-gh ij-kl-mn",
        ];
        for base in refused {
            assert!(!is_moment(base), "{base:?} must be refused");
        }
    }

    #[test]
    fn a_chosen_folder_is_kept_as_a_bookmark_and_opened_again_after_a_restart() {
        let dir = scratch("remember");
        let data = dir.join("data");
        let chosen = dir.join("Build_Test_1");
        fs::create_dir(&chosen).unwrap();
        let (folder, fake) = load(&data);
        let shown = folder.remember(chosen.clone()).unwrap();
        assert_eq!(shown.name, "Build_Test_1", "the page gets the name only");
        assert_eq!(
            fs::read(data.join(BOOKMARK)).unwrap(),
            fake.create(&chosen).unwrap(),
            "the bookmark is kept byte for byte"
        );
        assert!(
            !data.join("folder.tmp").exists(),
            "the temporary file was renamed"
        );
        drop(folder); // the app ends
        let (again, fake) = load(&data);
        assert_eq!(fake.log(), ["open Build_Test_1"], "opened at launch");
        assert_eq!(shown_name(&again).as_deref(), Some("Build_Test_1"));
        assert_eq!(
            again.write(BASE, ".txt", "text").unwrap(),
            format!("{BASE}.txt")
        );
        assert_eq!(
            fs::read_to_string(chosen.join(format!("{BASE}.txt"))).unwrap(),
            "text"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The panel may hand back a symbolic link to a folder, and a bookmark of
    /// the link itself does not open (QA-F-14, bookmark.rs), so the link is
    /// followed before the bookmark is made: the folder kept is the target.
    #[test]
    fn a_symbolic_link_to_a_folder_is_followed_before_its_bookmark_is_made() {
        let dir = scratch("symlink");
        let data = dir.join("data");
        let target = dir.join("Target");
        let link = dir.join("Link");
        fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let (folder, fake) = load(&data);
        let shown = folder.remember(link.clone()).unwrap();
        assert_eq!(
            shown.name, "Target",
            "the folder shown is the one the link points to"
        );
        assert_eq!(
            fs::read(data.join(BOOKMARK)).unwrap(),
            fake.create(&target).unwrap(),
            "the bookmark is the target's"
        );
        assert_eq!(fake.log(), ["open Target"]);
        assert_eq!(
            folder.write(BASE, ".txt", "through the link").unwrap(),
            format!("{BASE}.txt")
        );
        assert_eq!(
            fs::read_to_string(target.join(format!("{BASE}.txt"))).unwrap(),
            "through the link"
        );
        let dangling = dir.join("Dangling");
        std::os::unix::fs::symlink(dir.join("not there"), &dangling).unwrap();
        let failed = folder.remember(dangling).map(|s| s.name).unwrap_err();
        assert!(
            failed.starts_with("Could not remember the folder"),
            "a link to nothing is refused: {failed}"
        );
        assert_eq!(
            shown_name(&folder).as_deref(),
            Some("Target"),
            "and nothing changed"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_plain_path_kept_before_the_sandbox_counts_as_no_folder_and_is_removed() {
        let dir = scratch("plain-path");
        let data = dir.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join(PLAIN_PATH), dir.to_str().unwrap()).unwrap();
        let (folder, fake) = load(&data);
        assert_eq!(shown_name(&folder), None, "no folder: the page asks again");
        assert!(!data.join(PLAIN_PATH).exists(), "folder.txt is removed");
        assert!(fake.log().is_empty(), "nothing is opened");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_that_holds_no_bookmark_counts_as_no_folder_and_is_removed() {
        let dir = scratch("no-bookmark");
        let data = dir.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join(BOOKMARK), "not a bookmark").unwrap();
        let (folder, _) = load(&data);
        assert_eq!(shown_name(&folder), None);
        assert!(!data.join(BOOKMARK).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_stale_bookmark_is_renewed_at_launch() {
        let dir = scratch("stale");
        let data = dir.join("data");
        let chosen = dir.join("Notes");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir(&chosen).unwrap();
        fs::write(data.join(BOOKMARK), format!("stale:{}", chosen.display())).unwrap();
        let (folder, fake) = load(&data);
        assert_eq!(shown_name(&folder).as_deref(), Some("Notes"));
        assert_eq!(
            fs::read(data.join(BOOKMARK)).unwrap(),
            fake.create(&chosen).unwrap(),
            "the renewed bookmark replaced the stale one"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_that_does_not_open_at_launch_stays_remembered_and_opens_at_a_later_write() {
        let dir = scratch("unplugged");
        let data = dir.join("data");
        let chosen = dir.join("On a drive");
        let unplugged = dir.join("unplugged");
        fs::create_dir(&chosen).unwrap();
        load(&data).0.remember(chosen.clone()).unwrap();
        fs::rename(&chosen, &unplugged).unwrap(); // the drive is unplugged
        let (folder, fake) = load(&data);
        assert_eq!(
            shown_name(&folder).as_deref(),
            Some("On a drive"),
            "still shown, under its name"
        );
        let failed = folder.write(BASE, ".txt", "text").unwrap_err();
        assert!(failed.starts_with("Could not write the file"), "{failed}");
        assert!(data.join(BOOKMARK).exists(), "still remembered on disk");
        fs::rename(&unplugged, &chosen).unwrap(); // and plugged in again
        assert_eq!(
            folder.write(BASE, ".txt", "text").unwrap(),
            format!("{BASE}.txt")
        );
        assert_eq!(fake.log(), ["open On a drive"], "opened by the write");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn forgetting_removes_the_bookmark_first_and_then_stops_the_access() {
        let dir = scratch("forget");
        let data = dir.join("data");
        let chosen = dir.join("Notes");
        fs::create_dir(&chosen).unwrap();
        let (folder, fake) = load(&data);
        folder.remember(chosen).unwrap();
        folder.forget().unwrap();
        assert_eq!(fake.log(), ["open Notes", "stop Notes, on disk: nothing"]);
        assert_eq!(shown_name(&folder), None);
        assert!(!data.join(BOOKMARK).exists());
        assert_eq!(shown_name(&load(&data).0), None, "nothing after a restart");
        folder.forget().unwrap(); // forgetting twice is fine
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_choice_is_kept_on_disk_before_the_old_folder_is_let_go() {
        let dir = scratch("replace");
        let data = dir.join("data");
        let (first, second) = (dir.join("First"), dir.join("Second"));
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let (folder, fake) = load(&data);
        folder.remember(first).unwrap();
        assert_eq!(folder.remember(second.clone()).unwrap().name, "Second");
        assert_eq!(
            fake.log(),
            ["open First", "open Second", "stop First, on disk: Second"],
            "the first folder's access stops once the second's bookmark is on disk"
        );
        assert_eq!(
            folder.write(BASE, ".txt", "text").unwrap(),
            format!("{BASE}.txt")
        );
        assert!(second.join(format!("{BASE}.txt")).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_choice_that_cannot_be_kept_changes_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("choice-fails");
        let data = dir.join("data");
        let (first, second) = (dir.join("First"), dir.join("Second"));
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let (folder, fake) = load(&data);
        folder.remember(first.clone()).unwrap();
        let failed = folder
            .remember(dir.join("not there"))
            .map(|s| s.name)
            .unwrap_err();
        assert!(
            failed.starts_with("Could not remember the folder"),
            "{failed}"
        );
        // The bookmark cannot be written into a data folder that is read-only.
        fs::set_permissions(&data, fs::Permissions::from_mode(0o555)).unwrap();
        let failed = folder.remember(second).map(|s| s.name);
        fs::set_permissions(&data, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(failed
            .unwrap_err()
            .starts_with("Could not remember the folder"));
        assert_eq!(
            fake.log(),
            ["open First", "open Second", "stop Second, on disk: First"],
            "the second folder's access ends with the failed choice; the first's is kept"
        );
        assert_eq!(shown_name(&folder).as_deref(), Some("First"));
        assert_eq!(
            fs::read(data.join(BOOKMARK)).unwrap(),
            fake.create(&first).unwrap()
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_the_app_cannot_forget_stays_remembered_and_still_takes_saves() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("forget-fails");
        let data = dir.join("data");
        let chosen = dir.join("Notes");
        fs::create_dir(&chosen).unwrap();
        let (folder, fake) = load(&data);
        folder.remember(chosen).unwrap();
        // The bookmark cannot be deleted from a data folder that is read-only.
        fs::set_permissions(&data, fs::Permissions::from_mode(0o555)).unwrap();
        let failed = folder.forget();
        fs::set_permissions(&data, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(failed
            .unwrap_err()
            .starts_with("Could not forget the folder"));
        assert!(shown_name(&folder).is_some(), "still remembered in memory");
        assert!(data.join(BOOKMARK).exists(), "and on disk");
        assert_eq!(fake.log(), ["open Notes"], "and its access is kept");
        assert_eq!(
            folder.write(BASE, ".txt", "text").unwrap(),
            format!("{BASE}.txt"),
            "Save still writes into the folder the page shows"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_write_needs_a_folder_and_a_moment() {
        let dir = scratch("write");
        let chosen = dir.join("Notes");
        fs::create_dir(&chosen).unwrap();
        let (folder, _) = load(&dir.join("data"));
        assert_eq!(
            folder.write(BASE, ".txt", "text").unwrap_err(),
            "No folder is chosen"
        );
        folder.remember(chosen.clone()).unwrap();
        for base in ["notes", "2026-10-20 14-55-03.txt", "../escape"] {
            assert!(
                folder.write(base, ".txt", "text").is_err(),
                "{base:?} must be refused"
            );
        }
        assert_eq!(
            folder.write(BASE, ".txt", "the text").unwrap(),
            "2026-10-20 14-55-03.txt"
        );
        assert_eq!(
            folder.write(BASE, ".txt", "again").unwrap(),
            "2026-10-20 14-55-03 (2).txt"
        );
        assert_eq!(
            fs::read_to_string(chosen.join("2026-10-20 14-55-03.txt")).unwrap(),
            "the text"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn the_folder_takes_only_txt_md_and_docx_files() {
        let dir = scratch("formats");
        let folder = Folder::load(Some(dir.join("data")));
        folder.remember(dir.clone()).unwrap();
        for ext in [
            "",
            "txt",
            ".TXT",
            ".Md",
            ".doc",
            ".docm",
            ".exe",
            ".sight",
            ".md ",
            ".txt\0",
            "/x.txt",
            ".docx/../x",
            "/../../outside.txt",
        ] {
            assert_eq!(
                folder.write(BASE, ext, "text").unwrap_err(),
                "Save writes only .txt, .md and .docx files into the folder",
                "{ext:?} must be refused"
            );
        }
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "nothing written but the data folder"
        );
        assert_eq!(
            folder.write(BASE, ".md", "# the text").unwrap(),
            format!("{BASE}.md")
        );
        assert_eq!(
            fs::read_to_string(dir.join(format!("{BASE}.md"))).unwrap(),
            "# the text",
            "Markdown is the text as it is"
        );
        assert_eq!(
            folder.write(BASE, ".docx", "a\tb").unwrap(),
            format!("{BASE}.docx")
        );
        assert_eq!(
            folder.write(BASE, ".docx", "again").unwrap(),
            format!("{BASE} (2).docx"),
            "the counter goes before .docx"
        );
        assert_eq!(
            fs::read(dir.join(format!("{BASE}.docx"))).unwrap(),
            docx("a\tb").unwrap(),
            "a Word document the app made from the text"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The list is pinned (QA-F-07): a denylist-shaped guard would let an
    /// added extension through every other test.
    #[test]
    fn the_folder_formats_are_exactly_txt_md_and_docx() {
        assert_eq!(PLAIN_EXTENSIONS.as_slice(), [".txt", ".md", ".docx"]);
        let dir = scratch("exact-formats");
        let chosen = dir.join("Notes");
        fs::create_dir(&chosen).unwrap();
        let (folder, _) = load(&dir.join("data"));
        folder.remember(chosen.clone()).unwrap();
        for ext in [".sh", ".TXT", ".docx ", "..docx"] {
            assert_eq!(
                folder.write(BASE, ext, "text").unwrap_err(),
                "Save writes only .txt, .md and .docx files into the folder",
                "{ext:?} must be refused"
            );
        }
        assert_eq!(fs::read_dir(&chosen).unwrap().count(), 0, "nothing written");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The one write that may replace a file: the path the save panel
    /// returned, which the panel confirmed with the user (D-49). A write into
    /// the chosen folder still never replaces anything.
    #[test]
    fn the_panels_path_is_replaced_but_a_folder_write_never_is() {
        let dir = scratch("replacing");
        let path = dir.join("chosen in the panel.txt");
        write_replacing(&path, b"first").unwrap();
        write_replacing(&path, b"second, longer").unwrap();
        assert_eq!(
            fs::read(&path).unwrap(),
            b"second, longer",
            "the panel's path takes the new text"
        );
        assert_eq!(
            write_new(&dir, "chosen in the panel.txt", b"third").unwrap(),
            "chosen in the panel (2).txt",
            "a folder write goes to the next free name"
        );
        assert_eq!(
            fs::read(&path).unwrap(),
            b"second, longer",
            "and leaves the file alone"
        );
        assert!(
            write_replacing(&dir.join("no such folder").join("x.txt"), b"x").is_err(),
            "a path that cannot be written fails, so the page says so"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_docx_is_made_from_the_text_and_every_other_file_is_the_text() {
        let text = "line one\n\tline two";
        assert_eq!(
            file_bytes("2026-10-20 14-55-03.docx", text)
                .unwrap()
                .as_ref(),
            docx(text).unwrap().as_slice()
        );
        for name in [
            "2026-10-20 14-55-03.txt",
            "2026-10-20 14-55-03.md",
            "untitled-draft-20261020-1455.sight",
        ] {
            assert_eq!(
                file_bytes(name, text).unwrap().as_ref(),
                text.as_bytes(),
                "{name}"
            );
        }
    }

    /// A small HFS+ disk image, mounted out of the Finder's sight, as a
    /// volume of the test's own: one a write can fill (QA-G-21 was found on
    /// one), whose folders the test may lock, and whose staging place it can
    /// list. None when hdiutil is not there or cannot make or mount the
    /// image: the test then says so and checks nothing. Dropping it ejects
    /// the volume and removes the image.
    struct ImageVolume {
        dir: PathBuf,
        mount: PathBuf,
    }

    impl ImageVolume {
        fn mount(tag: &str) -> Option<ImageVolume> {
            let dir = scratch(tag);
            let image = dir.join("full.dmg");
            let mount = dir.join("mnt");
            fs::create_dir(&mount).unwrap();
            let hdiutil = |args: &[&str]| {
                std::process::Command::new("hdiutil")
                    .args(args)
                    .status()
                    .is_ok_and(|status| status.success())
            };
            let image = image.to_str().unwrap();
            let point = mount.to_str().unwrap();
            let mounted = hdiutil(&["create", "-size", "4m", "-fs", "HFS+", "-quiet", image])
                && hdiutil(&[
                    "attach",
                    "-nobrowse",
                    "-noverify",
                    "-noautoopen",
                    "-quiet",
                    "-mountpoint",
                    point,
                    image,
                ]);
            if !mounted {
                println!("hdiutil could not make or mount a disk image here: nothing checked");
                let _ = fs::remove_dir_all(&dir);
                return None;
            }
            Some(ImageVolume { dir, mount })
        }

        /// The names on the volume, the hidden ones (.fseventsd, Foundation's
        /// .TemporaryItems) left out.
        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.mount)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| !name.starts_with('.'))
                .collect();
            names.sort();
            names
        }

        /// What Foundation's staging place on the volume still holds, by
        /// path under it: the folder it stages a replacement in (NSIRD_...)
        /// and anything inside one. The place is
        /// `.TemporaryItems/folders.<uid>/TemporaryItems`; `.TemporaryItems`
        /// itself is made unlistable (d-wx--x--t), so a walk from there sees
        /// nothing and a check on it can never fail (QA-G-28). The inner
        /// folder is the test user's own, listable, and stays on the volume
        /// once a replacement has been staged, so this listing must succeed:
        /// a place that cannot be listed fails the test instead.
        fn staging_leftovers(&self) -> Vec<String> {
            use std::os::unix::fs::MetadataExt;
            fn walk(dir: &Path, place: &Path, found: &mut Vec<String>) {
                let entries = fs::read_dir(dir)
                    .unwrap_or_else(|e| panic!("cannot list {}: {e}", dir.display()));
                for entry in entries {
                    let path = entry.unwrap().path();
                    found.push(
                        path.strip_prefix(place)
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                    );
                    if path.is_dir() {
                        walk(&path, place, found);
                    }
                }
            }
            let uid = fs::metadata(&self.dir).unwrap().uid();
            let place = self
                .mount
                .join(".TemporaryItems")
                .join(format!("folders.{uid}"))
                .join("TemporaryItems");
            let mut found = Vec::new();
            walk(&place, &place, &mut found);
            found.sort();
            found
        }
    }

    impl Drop for ImageVolume {
        fn drop(&mut self) {
            let _ = std::process::Command::new("hdiutil")
                .args(["detach", "-quiet"])
                .arg(&self.mount)
                .status();
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// The one write that may replace a file must not lose that file when
    /// the write fails (QA-G-21): on a volume with no room left, as a full
    /// disk, an I/O error or a pulled volume would do halfway through, the
    /// file the person agreed to replace stays as it was, a new file is not
    /// left half written, and nothing of the write is left behind.
    #[test]
    fn a_failed_replacing_write_leaves_the_chosen_file_as_it_was() {
        let Some(volume) = ImageVolume::mount("full-volume") else {
            return;
        };
        let chosen = volume.mount.join("chosen in the panel.txt");
        let old = vec![b'O'; 200_000];
        fs::write(&chosen, &old).unwrap();
        write_replacing(&chosen, b"a replacement that fits").unwrap();
        assert_eq!(
            fs::read(&chosen).unwrap(),
            b"a replacement that fits",
            "a file on another volume than the app's own temporary folder is replaced"
        );
        fs::write(&chosen, &old).unwrap();
        let err = write_replacing(&chosen, &vec![b'N'; 20_000_000]).unwrap_err();
        let now = fs::read(&chosen).unwrap();
        assert!(
            now == old,
            "the file the person agreed to replace is as it was after the failed write: {} bytes now, {} before ({err})",
            now.len(),
            old.len()
        );
        let fresh = volume.mount.join("new in the panel.txt");
        let err = write_replacing(&fresh, &vec![b'N'; 20_000_000]).unwrap_err();
        assert!(
            !fresh.exists(),
            "a new file that could not be written is not left half written ({err})"
        );
        assert_eq!(
            volume.names(),
            ["chosen in the panel.txt"],
            "nothing else is left on the volume"
        );
        assert_eq!(
            volume.staging_leftovers(),
            Vec::<String>::new(),
            "no staging folder or staged file is left behind"
        );
    }

    /// Foundation's replacement itself can be refused (QA-G-28): a file the
    /// person may write in a folder they may not change. The staged write
    /// succeeds and the replacement does not; the write must say so and
    /// leave the file as it was, with nothing of it left in the staging
    /// place. (The old write, through the file itself, worked here; the page
    /// says "Could not save" now, QA-G-29.)
    #[test]
    fn a_refused_replacement_is_reported_and_leaves_the_file_as_it_was() {
        use std::os::unix::fs::PermissionsExt;
        let Some(volume) = ImageVolume::mount("read-only-folder") else {
            return;
        };
        let locked = volume.mount.join("a folder the person may not change");
        fs::create_dir(&locked).unwrap();
        let chosen = locked.join("chosen in the panel.txt");
        fs::write(&chosen, b"as it was").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        let result = write_replacing(&chosen, b"a replacement");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            result.is_err(),
            "a replacement the system refuses is reported, so the page says Could not save"
        );
        assert_eq!(
            fs::read(&chosen).unwrap(),
            b"as it was",
            "and the file is as it was"
        );
        assert_eq!(
            volume.staging_leftovers(),
            Vec::<String>::new(),
            "nothing of the write is left in the staging place"
        );
    }

    /// A folder at the chosen path is refused before anything is staged
    /// (QA-G-29): Foundation's replacement would put the file in the folder's
    /// place, with everything in it gone. The folder and what it holds stay
    /// as they were.
    #[test]
    fn a_folder_at_the_chosen_path_is_refused_and_kept_with_what_it_holds() {
        let dir = scratch("folder-at-path");
        let folder = dir.join("chosen in the panel");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("inside.txt"), "kept").unwrap();
        let err = write_replacing(&folder, b"a file").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::IsADirectory, "{err}");
        assert!(folder.is_dir(), "the folder is still a folder");
        assert_eq!(
            fs::read_to_string(folder.join("inside.txt")).unwrap(),
            "kept",
            "with what it held"
        );
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "nothing else was written"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// A symbolic link at the chosen path is refused (QA-G-29): the panel
    /// asked about the link's name, and a write through the link would land
    /// on the file it points to, which the person did not name. The link,
    /// what it points to, a link to nothing and a link to a folder all stay
    /// as they were, and the reason names the link.
    #[test]
    fn a_link_at_the_chosen_path_is_refused_and_what_it_points_to_is_kept() {
        let dir = scratch("link-at-path");
        let target = dir.join("elsewhere.txt");
        fs::write(&target, "kept").unwrap();
        let link = dir.join("chosen in the panel.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let err = write_replacing(&link, b"through the link").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput, "{err}");
        assert!(
            err.to_string().contains("link"),
            "the reason names the link: {err}"
        );
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the link is still a link"
        );
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "kept",
            "and what it points to is as it was"
        );
        let dangling = dir.join("to nothing.txt");
        std::os::unix::fs::symlink(dir.join("not there.txt"), &dangling).unwrap();
        let err = write_replacing(&dangling, b"x").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput, "{err}");
        assert!(
            !dir.join("not there.txt").exists(),
            "a link to nothing creates nothing"
        );
        let to_folder = dir.join("to a folder");
        std::os::unix::fs::symlink(&dir, &to_folder).unwrap();
        let err = write_replacing(&to_folder, b"x").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput, "{err}");
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            4,
            "nothing else was written"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// `NSURL fileURLWithPath:` answers nil for an empty path and for one
    /// that holds a NUL byte, which would stop the app inside objc2
    /// (QA-G-29); neither can come from the panel, and both are refused as
    /// an error instead, at the one place paths become URLs.
    #[test]
    fn an_empty_path_or_one_holding_a_nul_byte_is_refused_without_a_panic() {
        for odd in [PathBuf::new(), PathBuf::from("/tmp/plain-sight\0unit.txt")] {
            let err = write_replacing(&odd, b"x").unwrap_err();
            assert_eq!(err.kind(), ErrorKind::InvalidInput, "{odd:?}: {err}");
            let err = replacing::staging_dir(&odd).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::InvalidInput, "{odd:?}: {err}");
            let err = replacing::replace(&odd, &odd).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::InvalidInput, "{odd:?}: {err}");
        }
    }
}
