//! Quitting and closing the window work like Esc (decision D-21), with one
//! question first (D-48): when the page holds text that a quit would lose
//! (text on the page and no vault open), a "Quit without saving?" sheet asks,
//! and Cancel keeps everything as it was. Otherwise, or after Quit, every way
//! out runs the page's quit hook, window.__plainSightQuit (adapter.js): it
//! awaits the callback the page registered with onQuit, which is Esc's wipe
//! plus the vault's last write, and then calls quit_ready. The app ends after
//! that, or after a 4-second safety timer, and always through AppKit's normal
//! termination, so that WebKit sees the app end. A page that never answers
//! the question is quit after the 1.5-second answer timer and then the
//! 4-second safety timer, about 5.5 seconds in all.
//!
//! The ways out:
//! - closing the window (the red button, Close Window, Cmd+W): main.rs keeps
//!   the window open and calls begin;
//! - the app menu's Quit item, Cmd+Q (menu.rs): begin;
//! - a terminate request from macOS (the Dock's Quit, logout, restart,
//!   shutdown): applicationShouldTerminate: answers "later" until the page is
//!   done, then "now". Cancel in the sheet answers "cancel", as any document
//!   app with unsaved changes does, which cancels a logout (D-48); with
//!   nothing to lose the request is never cancelled.

use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// How long the page gets before the app ends anyway: the adapter's longest
/// path (1.8 s for the page's callback, 0.4 s for the storage answer, 0.7 s
/// for WebKit's commit) and a full second of margin for a loaded Mac, where
/// WebKit's timers run late while this one is a precise sleep (D-42,
/// `Mac_PS_008`). `tests/adapter.mjs` holds the two files to that sum.
const SAFETY: Duration = Duration::from_secs(4);

/// How long the page gets to answer whether a quit would lose text. A page
/// that does not answer (its web process hung, say) has nothing the quit
/// could keep, so the quit goes on without the sheet.
const ASK: Duration = Duration::from_millis(1500);

/// Runs the page's hook; does nothing if the adapter is missing.
const HOOK: &str = "window.__plainSightQuit && window.__plainSightQuit()";

/// Asks the page whether a quit would lose text (adapter.js); false without
/// the adapter.
const UNSAVED: &str = "Boolean(window.__plainSightUnsaved && window.__plainSightUnsaved())";

static STATE: Mutex<QuitState> = Mutex::new(QuitState::new());
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Where a quit stands. Plain state with no AppKit in it, so it is unit-tested.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// No quit in progress.
    Idle,
    /// The page has been asked whether a quit would lose text.
    Asking,
    /// The "Quit without saving?" sheet is up.
    Confirming,
    /// The page's quit hook runs; the safety timer is running.
    Quitting,
    /// The page is done, or the timer fired: the app may end.
    Approved,
}

#[derive(Debug)]
pub struct QuitState {
    phase: Phase,
    /// macOS asked to terminate and is waiting for an answer.
    terminate_pending: bool,
    /// The number of the question asked last: each `begin` asks the next
    /// one, and an answer names the question it is for, so that the stand-in
    /// timer of a question that was cancelled cannot decide the question
    /// after it (DISH-G-37).
    question: u64,
}

impl Default for QuitState {
    fn default() -> Self {
        QuitState::new()
    }
}

/// How the app ends once the page is done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ending {
    /// Answer the waiting terminate request with yes.
    Reply,
    /// Ask macOS to terminate; the request is then answered with "now".
    Terminate,
}

/// The answer to macOS's applicationShouldTerminate:.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Now,
    /// Later; `begin` is true when this request is what started the quit.
    Later {
        begin: bool,
    },
}

/// What follows the page's answer, or the sheet's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    /// Run the page's quit hook and start the safety timer.
    Quit,
    /// Show the "Quit without saving?" sheet.
    Confirm,
    /// Stand down; with `reply`, answer the waiting terminate request with cancel.
    Cancel { reply: bool },
}

/// The sheet's buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    Quit,
    Cancel,
}

impl QuitState {
    pub const fn new() -> Self {
        QuitState {
            phase: Phase::Idle,
            terminate_pending: false,
            question: 0,
        }
    }

    /// Starts a quit. True only from idle: the caller then asks the page the
    /// next question, numbered by `question`.
    pub fn begin(&mut self) -> bool {
        if self.phase != Phase::Idle {
            return false;
        }
        self.phase = Phase::Asking;
        self.question += 1;
        true
    }

    /// The number of the question open now, or asked last: the page's
    /// answer and the stand-in timer carry it back to `unsaved`.
    pub fn question(&self) -> u64 {
        self.question
    }

    /// macOS asks whether the app may terminate now.
    pub fn should_terminate(&mut self) -> Answer {
        if self.phase == Phase::Approved {
            return Answer::Now;
        }
        self.terminate_pending = true;
        Answer::Later {
            begin: self.begin(),
        }
    }

    /// The page's answer to question `question` whether a quit would lose
    /// text: true shows the sheet, false runs the hook. None unless that
    /// question is the one open, so a late or repeated answer changes
    /// nothing, and neither does the stand-in timer of an earlier question
    /// that was cancelled (DISH-G-37).
    pub fn unsaved(&mut self, question: u64, unsaved: bool) -> Option<Next> {
        if self.phase != Phase::Asking || question != self.question {
            return None;
        }
        if unsaved {
            self.phase = Phase::Confirming;
            Some(Next::Confirm)
        } else {
            self.phase = Phase::Quitting;
            Some(Next::Quit)
        }
    }

    /// The sheet's answer. Quit runs the hook; Cancel stands down, and answers
    /// a waiting terminate request with cancel. None unless the sheet is up.
    pub fn chosen(&mut self, choice: Choice) -> Option<Next> {
        if self.phase != Phase::Confirming {
            return None;
        }
        match choice {
            Choice::Quit => {
                self.phase = Phase::Quitting;
                Some(Next::Quit)
            }
            Choice::Cancel => {
                let reply = self.terminate_pending;
                self.terminate_pending = false;
                self.phase = Phase::Idle;
                Some(Next::Cancel { reply })
            }
        }
    }

    /// The page is done, or the timer fired. How to end the app, once, while
    /// the hook runs; None before that (the page cannot end the app by itself,
    /// nor from under the sheet) and after the first finish.
    pub fn finish(&mut self) -> Option<Ending> {
        if self.phase != Phase::Quitting {
            return None;
        }
        self.phase = Phase::Approved;
        Some(if self.terminate_pending {
            Ending::Reply
        } else {
            Ending::Terminate
        })
    }
}

fn state() -> MutexGuard<'static, QuitState> {
    STATE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Called once at start, on the main thread.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    #[cfg(target_os = "macos")]
    if let Err(reason) = macos::install() {
        eprintln!("{}", not_installed(&reason));
    }
}

/// The line on stderr when `applicationShouldTerminate:` could not be added
/// to the app's delegate (`Mac_PS_007`): it names the consequence, so that a
/// log reader knows what the Dock's Quit would then do.
fn not_installed(reason: &str) -> String {
    format!(
        "plain-sight: applicationShouldTerminate: is not installed ({reason}): a terminate \
         request from macOS (the Dock's Quit, a logout, a shutdown) would end the app at once, \
         before the page's Esc and the vault's last write"
    )
}

/// Starts a quit from the window close or the Quit item.
pub fn begin(app: &AppHandle) {
    let first = state().begin();
    if first {
        ask(app);
    }
}

/// Asks the page whether a quit would lose text (D-48) and acts on the
/// answer. The question carries its number: the page's answer and the
/// stand-in timer both name the question they were started for, so a timer
/// that outlives its question (Cancel in the sheet, then a new quit within
/// `ASK`) cannot decide the next one (DISH-G-37). Without a window there is
/// nothing to lose; a page that stays silent for `ASK` counts the same, and
/// its late answer is then ignored.
fn ask(app: &AppHandle) {
    let question = state().question();
    let asked = app.get_webview_window("main").and_then(|window| {
        window
            .eval_with_callback(UNSAVED, move |answer| answered(question, answer == "true"))
            .ok()
    });
    if asked.is_none() {
        answered(question, false);
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(ASK);
        answered(question, false);
    });
}

/// The page's answer to the numbered question, or the time that stands in
/// for it.
fn answered(question: u64, unsaved: bool) {
    let next = state().unsaved(question, unsaved);
    act(next);
}

/// The sheet's answer.
fn chosen(choice: Choice) {
    let next = state().chosen(choice);
    act(next);
}

fn act(next: Option<Next>) {
    let Some(app) = APP.get() else {
        return;
    };
    match next {
        Some(Next::Quit) => run_hook(app),
        Some(Next::Confirm) => confirm(),
        Some(Next::Cancel { reply: true }) => cancel_terminate(),
        Some(Next::Cancel { reply: false }) | None => {}
    }
}

/// Asks the page to finish and starts the safety timer.
fn run_hook(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(HOOK);
    }
    std::thread::spawn(|| {
        std::thread::sleep(SAFETY);
        finish();
    });
}

/// Ends the app if a quit is waiting for the page; true if this call did.
fn finish() -> bool {
    let ending = state().finish();
    match ending {
        Some(ending) => {
            end(ending);
            true
        }
        None => false,
    }
}

/// The page's hook is done. Refused when no quit is in progress, so the page
/// cannot end the app by itself.
#[tauri::command]
pub fn quit_ready() -> Result<(), String> {
    if finish() {
        Ok(())
    } else {
        Err("No quit is in progress".to_owned())
    }
}

#[cfg(target_os = "macos")]
fn end(ending: Ending) {
    macos::end(ending);
}

#[cfg(target_os = "macos")]
fn confirm() {
    macos::confirm();
}

#[cfg(target_os = "macos")]
fn cancel_terminate() {
    macos::cancel_terminate();
}

#[cfg(not(target_os = "macos"))]
fn end(_ending: Ending) {
    if let Some(app) = APP.get() {
        app.exit(0);
    }
}

/// Elsewhere (Windows comes later) there is no sheet yet: the quit goes on.
#[cfg(not(target_os = "macos"))]
fn confirm() {
    chosen(Choice::Quit);
}

#[cfg(not(target_os = "macos"))]
fn cancel_terminate() {}

#[cfg(target_os = "macos")]
pub(crate) mod macos {
    use std::cell::RefCell;
    use std::ffi::CStr;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{ffi, sel, MainThreadMarker};
    use objc2_app_kit::{
        NSAlert, NSAlertSecondButtonReturn, NSApplication, NSApplicationTerminateReply,
        NSModalResponse, NSWindow,
    };
    use objc2_core_foundation::{kCFRunLoopCommonModes, CFRunLoop};
    use objc2_foundation::NSString;
    use tauri::Manager;

    use super::{state, Answer, Choice, Ending, APP};

    thread_local! {
        /// The sheet while it is up, on the main thread, where AppKit keeps it;
        /// the test build ends it through `end_sheet`.
        static SHEET: RefCell<Option<Retained<NSAlert>>> = const { RefCell::new(None) };
    }

    /// applicationShouldTerminate: as a Rust function: self, the selector and
    /// the sending NSApplication in, an NSApplicationTerminateReply out.
    type ShouldTerminate = extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize;

    /// tao's app delegate (tao 0.37.1, src/platform_impl/macos/app_delegate.rs)
    /// has no applicationShouldTerminate:, so a terminate request would end the
    /// app at once. This adds the method to tao's delegate class. The error
    /// names what stopped it: a tao that renamed the class, or one that gained
    /// the method itself, would otherwise bring the instant end back in
    /// silence (`Mac_PS_007`).
    pub fn install() -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("not called on the main thread")?;
        add_should_terminate(c"TaoAppDelegateParent")?;
        // AppKit may note which methods a delegate has when the delegate is set;
        // setting the same delegate again lets it see the new one.
        let app = NSApplication::sharedApplication(mtm);
        app.setDelegate(app.delegate().as_deref());
        Ok(())
    }

    /// Adds `applicationShouldTerminate:` to the class, and reads the
    /// runtime's answer: it refuses when the class has the method already.
    pub(super) fn add_should_terminate(name: &CStr) -> Result<(), String> {
        let shown = name.to_string_lossy();
        let class = AnyClass::get(name)
            .ok_or_else(|| format!("the delegate class {shown} does not exist"))?;
        let method: ShouldTerminate = should_terminate;
        // SAFETY: `method` has the method's Objective-C signature, encoded
        // "Q@:@": it returns NSApplicationTerminateReply (an NSUInteger) and
        // takes self, the selector and the sending NSApplication.
        let added = unsafe {
            let imp = std::mem::transmute::<ShouldTerminate, Imp>(method);
            let class = std::ptr::from_ref(class).cast_mut();
            ffi::class_addMethod(
                class,
                sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            )
        };
        if !added.as_bool() {
            return Err(format!(
                "the runtime refused to add applicationShouldTerminate: to {shown}, which has the method already"
            ));
        }
        Ok(())
    }

    extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: *mut AnyObject) -> usize {
        // Before the app has started there is no page to wait for.
        let Some(app) = APP.get() else {
            return NSApplicationTerminateReply::TerminateNow.0;
        };
        let answer = state().should_terminate();
        match answer {
            Answer::Now => NSApplicationTerminateReply::TerminateNow.0,
            Answer::Later { begin } => {
                if begin {
                    super::ask(app);
                }
                NSApplicationTerminateReply::TerminateLater.0
            }
        }
    }

    /// Ends the app through AppKit, from the main run loop.
    pub fn end(ending: Ending) {
        on_main_run_loop(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let app = NSApplication::sharedApplication(mtm);
            match ending {
                Ending::Reply => app.replyToApplicationShouldTerminate(true),
                Ending::Terminate => app.terminate(None),
            }
        });
    }

    /// Answers a waiting terminate request with cancel: the person chose
    /// Cancel in the sheet, so a logout or shutdown stops, as it does for any
    /// document app with unsaved changes.
    pub fn cancel_terminate() {
        on_main_run_loop(|| {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(false);
        });
    }

    /// Shows the "Quit without saving?" sheet on the document window: Cancel
    /// is the default button (the first one added, which answers Return) and
    /// Quit the other. The sheet's answer goes to `chosen`. Without a window
    /// to hang it on there is nothing to keep, and the quit goes on.
    pub fn confirm() {
        on_main_run_loop(|| {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let window = APP
                .get()
                .and_then(|app| app.get_webview_window("main"))
                .and_then(|window| window.ns_window().ok());
            let Some(ns_window) = window else {
                super::chosen(Choice::Quit);
                return;
            };
            // SAFETY: Tauri's pointer to the window's NSWindow, on the main thread.
            let ns_window: &NSWindow = unsafe { &*ns_window.cast() };
            let alert = NSAlert::new(mtm);
            alert.setMessageText(&NSString::from_str("Quit without saving?"));
            alert.setInformativeText(&NSString::from_str(
                "Your text has not been saved. If you quit now, it will be lost.",
            ));
            let _cancel = alert.addButtonWithTitle(&NSString::from_str("Cancel"));
            let _quit = alert.addButtonWithTitle(&NSString::from_str("Quit"));
            let done = RcBlock::new(move |response: NSModalResponse| {
                SHEET.with(|sheet| sheet.borrow_mut().take());
                super::chosen(if response == NSAlertSecondButtonReturn {
                    Choice::Quit
                } else {
                    Choice::Cancel
                });
            });
            alert.beginSheetModalForWindow_completionHandler(ns_window, Some(&done));
            SHEET.with(|sheet| *sheet.borrow_mut() = Some(alert));
        });
    }

    /// Test builds only: presses the sheet's button from a probe request, as
    /// the completion handler sees it. False when no sheet is up. Main thread.
    #[cfg(feature = "e2e")]
    pub fn end_sheet(choice: Choice) -> bool {
        use objc2_app_kit::NSAlertFirstButtonReturn;
        let Some(alert) = SHEET.with(|sheet| sheet.borrow().clone()) else {
            return false;
        };
        let window = APP
            .get()
            .and_then(|app| app.get_webview_window("main"))
            .and_then(|window| window.ns_window().ok());
        let Some(ns_window) = window else {
            return false;
        };
        // SAFETY: Tauri's pointer to the window's NSWindow, on the main thread.
        let ns_window: &NSWindow = unsafe { &*ns_window.cast() };
        let code = match choice {
            Choice::Quit => NSAlertSecondButtonReturn,
            Choice::Cancel => NSAlertFirstButtonReturn,
        };
        ns_window.endSheet_returnCode(&alert.window(), code);
        true
    }

    /// Runs `work` on the main thread from the main run loop, in its common
    /// modes. It runs outside tao's event handler: tao's
    /// applicationWillTerminate: calls that handler again, and it is not
    /// re-entrant (tao 0.37.1, src/platform_impl/macos/app_state.rs lines 203
    /// to 218 and 272 to 282). It also runs while AppKit waits for a terminate
    /// answer, in NSModalPanelRunLoopMode, even when the terminate came from a
    /// main-queue block, where the main queue itself would not run.
    pub(crate) fn on_main_run_loop(work: impl Fn() + Send + 'static) {
        let Some(run_loop) = CFRunLoop::main() else {
            return;
        };
        let block = RcBlock::new(work);
        // SAFETY: the mode is the common modes string and the block takes no
        // arguments; the run loop copies the block before this returns.
        unsafe {
            let mode = kCFRunLoopCommonModes.map(|mode| &**mode);
            run_loop.perform_block(mode, Some(&block));
        }
        run_loop.wake_up();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quit_begins_once_and_asks_the_page_first() {
        let mut quit = QuitState::new();
        assert!(quit.begin(), "the first begin asks the page");
        assert!(!quit.begin(), "a second close or Cmd+Q does not ask again");
        assert_eq!(
            quit.unsaved(quit.question(), false),
            Some(Next::Quit),
            "nothing to lose: the hook runs"
        );
        assert!(!quit.begin(), "nor while the hook runs");
        assert_eq!(
            quit.finish(),
            Some(Ending::Terminate),
            "a close or Quit item asks macOS to terminate"
        );
        assert_eq!(
            quit.finish(),
            None,
            "the page and the timer cannot both end the app"
        );
    }

    #[test]
    fn text_to_lose_shows_the_sheet_and_quit_runs_the_hook() {
        let mut quit = QuitState::new();
        quit.begin();
        assert_eq!(
            quit.unsaved(quit.question(), true),
            Some(Next::Confirm),
            "the sheet is shown"
        );
        assert_eq!(
            quit.finish(),
            None,
            "the page cannot end the app from under the sheet"
        );
        assert_eq!(quit.chosen(Choice::Quit), Some(Next::Quit));
        assert_eq!(quit.finish(), Some(Ending::Terminate));
    }

    #[test]
    fn cancel_stands_down_and_a_later_quit_asks_again() {
        let mut quit = QuitState::new();
        quit.begin();
        quit.unsaved(quit.question(), true);
        assert_eq!(
            quit.chosen(Choice::Cancel),
            Some(Next::Cancel { reply: false }),
            "no terminate request waits, so nothing to answer"
        );
        assert_eq!(quit.finish(), None, "nothing ends the app");
        assert!(quit.begin(), "the next close asks the page again");
        assert_eq!(quit.unsaved(quit.question(), true), Some(Next::Confirm));
    }

    #[test]
    fn a_terminate_request_waits_for_the_sheet_and_cancel_answers_it_with_cancel() {
        let mut quit = QuitState::new();
        assert_eq!(
            quit.should_terminate(),
            Answer::Later { begin: true },
            "the request starts the quit"
        );
        assert_eq!(quit.unsaved(quit.question(), true), Some(Next::Confirm));
        assert_eq!(
            quit.should_terminate(),
            Answer::Later { begin: false },
            "a second request waits for the same sheet"
        );
        assert_eq!(
            quit.chosen(Choice::Cancel),
            Some(Next::Cancel { reply: true }),
            "the waiting request is answered with cancel"
        );
        assert_eq!(
            quit.should_terminate(),
            Answer::Later { begin: true },
            "a later request asks the page again, with nothing left over"
        );
        assert_eq!(quit.unsaved(quit.question(), false), Some(Next::Quit));
        assert_eq!(quit.finish(), Some(Ending::Reply));
    }

    #[test]
    fn a_terminate_request_with_nothing_to_lose_is_answered_when_the_page_is_done() {
        let mut quit = QuitState::new();
        assert_eq!(quit.should_terminate(), Answer::Later { begin: true });
        assert_eq!(quit.unsaved(quit.question(), false), Some(Next::Quit));
        assert_eq!(quit.should_terminate(), Answer::Later { begin: false });
        assert_eq!(
            quit.finish(),
            Some(Ending::Reply),
            "the waiting request gets its yes"
        );
        assert_eq!(quit.should_terminate(), Answer::Now);
    }

    #[test]
    fn a_terminate_during_a_close_is_answered_when_the_page_is_done() {
        let mut quit = QuitState::new();
        assert!(quit.begin(), "the window was closed");
        assert_eq!(
            quit.should_terminate(),
            Answer::Later { begin: false },
            "the page is not asked twice"
        );
        assert_eq!(quit.unsaved(quit.question(), false), Some(Next::Quit));
        assert_eq!(quit.finish(), Some(Ending::Reply));
    }

    #[test]
    fn quit_in_the_sheet_answers_a_waiting_terminate_request_with_yes() {
        let mut quit = QuitState::new();
        quit.should_terminate();
        quit.unsaved(quit.question(), true);
        assert_eq!(quit.chosen(Choice::Quit), Some(Next::Quit));
        assert_eq!(quit.finish(), Some(Ending::Reply));
    }

    #[test]
    fn once_approved_the_terminate_that_follows_goes_ahead() {
        let mut quit = QuitState::new();
        quit.begin();
        quit.unsaved(quit.question(), false);
        assert_eq!(quit.finish(), Some(Ending::Terminate));
        assert_eq!(
            quit.should_terminate(),
            Answer::Now,
            "terminate: after the page is done ends the app"
        );
        assert_eq!(quit.finish(), None);
    }

    #[test]
    fn answers_out_of_turn_change_nothing() {
        let mut quit = QuitState::new();
        assert_eq!(
            quit.unsaved(quit.question(), true),
            None,
            "no question is open"
        );
        assert_eq!(quit.chosen(Choice::Quit), None, "no sheet is up");
        assert_eq!(
            quit.finish(),
            None,
            "quit_ready with no quit in progress is refused"
        );
        quit.begin();
        assert_eq!(
            quit.chosen(Choice::Quit),
            None,
            "no sheet while the page is asked"
        );
        assert_eq!(
            quit.finish(),
            None,
            "quit_ready while the page is asked is refused"
        );
        assert_eq!(quit.unsaved(quit.question(), true), Some(Next::Confirm));
        assert_eq!(
            quit.unsaved(quit.question(), true),
            None,
            "a late second answer is ignored"
        );
        assert_eq!(
            quit.unsaved(quit.question(), false),
            None,
            "so is the time standing in for it"
        );
        assert_eq!(
            quit.chosen(Choice::Cancel),
            Some(Next::Cancel { reply: false })
        );
        assert_eq!(quit.chosen(Choice::Cancel), None, "the sheet is gone");
        assert!(quit.begin());
        assert_eq!(quit.unsaved(quit.question(), false), Some(Next::Quit));
        assert_eq!(
            quit.unsaved(quit.question(), true),
            None,
            "the hook already runs"
        );
        assert_eq!(quit.chosen(Choice::Cancel), None, "no sheet to cancel from");
    }

    /// DISH-G-37: Cancel in the sheet and a new quit within `ASK` of the
    /// first question: the first question's stand-in timer fires while the
    /// second question is open, and must not decide it. The second question
    /// is decided by its own answer, whichever way it goes.
    #[test]
    fn a_stale_timer_answers_only_the_question_it_was_started_for() {
        for second_answer in [true, false] {
            let mut quit = QuitState::new();
            assert!(quit.begin(), "question 1 starts its stand-in timer");
            let first = quit.question();
            assert_eq!(quit.unsaved(first, true), Some(Next::Confirm), "the sheet");
            assert_eq!(
                quit.chosen(Choice::Cancel),
                Some(Next::Cancel { reply: false })
            );
            assert!(quit.begin(), "question 2, within ASK of question 1");
            let second = quit.question();
            assert_ne!(first, second, "each question has its own number");
            assert_eq!(
                quit.unsaved(first, false),
                None,
                "question 1's timer fires: its answer is ignored"
            );
            assert_eq!(quit.phase, Phase::Asking, "question 2 is still open");
            let expected = if second_answer {
                Next::Confirm
            } else {
                Next::Quit
            };
            assert_eq!(
                quit.unsaved(second, second_answer),
                Some(expected),
                "question 2 is decided by its own answer"
            );
        }
    }

    /// The numbered path for one question: its own answer works as before,
    /// a number from an earlier or a later question is ignored and leaves the
    /// question open, and its own stand-in timer after the answer changes
    /// nothing.
    #[test]
    fn the_current_questions_own_answer_still_works_and_other_numbers_are_ignored() {
        let mut quit = QuitState::new();
        assert_eq!(quit.question(), 0, "no question has been asked");
        assert!(quit.begin());
        let current = quit.question();
        assert_eq!(current, 1, "the first question");
        assert_eq!(quit.unsaved(current - 1, false), None, "an earlier number");
        assert_eq!(quit.unsaved(current + 1, false), None, "a later number");
        assert_eq!(quit.phase, Phase::Asking, "the question stays open");
        assert_eq!(
            quit.unsaved(current, false),
            Some(Next::Quit),
            "its own answer runs the hook"
        );
        assert_eq!(
            quit.unsaved(current, false),
            None,
            "its own stand-in timer, late, changes nothing"
        );
        assert_eq!(quit.finish(), Some(Ending::Terminate));
    }

    /// The Delivery Manager's AT-R3 (dm-appstore-2783e5d/adv, quit.rs module
    /// dm_adv), adopted as written (DM-237 a): a logout cancelled in the
    /// sheet, then a window close with nothing to lose, ends through
    /// terminate (no request is waiting), not through a reply to the
    /// cancelled request. The reset of `terminate_pending` in `chosen` is what
    /// this holds; with that line removed every other test still passed.
    #[test]
    fn at_r3_a_close_after_a_cancelled_logout_terminates_rather_than_replies() {
        let mut quit = QuitState::new();
        assert_eq!(quit.should_terminate(), Answer::Later { begin: true });
        assert_eq!(quit.unsaved(quit.question(), true), Some(Next::Confirm));
        assert_eq!(
            quit.chosen(Choice::Cancel),
            Some(Next::Cancel { reply: true })
        );
        assert!(quit.begin(), "the window is closed later");
        assert_eq!(quit.unsaved(quit.question(), false), Some(Next::Quit));
        assert_eq!(
            quit.finish(),
            Some(Ending::Terminate),
            "nothing waits for a reply, so the app asks to terminate"
        );
    }

    #[test]
    fn a_missing_method_is_reported_with_its_consequence() {
        let line = not_installed("the reason");
        assert!(line.starts_with("plain-sight: "), "{line}");
        assert!(line.contains("(the reason)"), "{line}");
        assert!(line.contains("would end the app at once"), "{line}");
    }

    /// The method is added to a class made here (tao's delegate class exists
    /// only in the app), and the runtime's answer is read: a class that has
    /// the method already is refused, and a class that does not exist is named.
    #[cfg(target_os = "macos")]
    #[test]
    fn install_reads_the_runtimes_answer_and_names_what_stopped_it() {
        use objc2::runtime::{AnyClass, ClassBuilder, NSObject};
        use objc2::{sel, ClassType};
        let name = c"PlainSightTestDelegate";
        let builder = ClassBuilder::new(name, NSObject::class()).unwrap();
        let class = builder.register();
        assert!(
            class
                .instance_method(sel!(applicationShouldTerminate:))
                .is_none(),
            "a fresh class has no such method"
        );
        assert_eq!(macos::add_should_terminate(name), Ok(()));
        assert!(
            class
                .instance_method(sel!(applicationShouldTerminate:))
                .is_some(),
            "the method was added"
        );
        assert_eq!(
            macos::add_should_terminate(name),
            Err("the runtime refused to add applicationShouldTerminate: to PlainSightTestDelegate, which has the method already".to_owned())
        );
        assert_eq!(
            macos::add_should_terminate(c"PlainSightNoSuchDelegate"),
            Err("the delegate class PlainSightNoSuchDelegate does not exist".to_owned())
        );
        assert!(
            AnyClass::get(c"TaoAppDelegateParent").is_none(),
            "tao's class is not in a unit test"
        );
        let off_main = std::thread::spawn(macos::install).join().unwrap();
        assert_eq!(off_main, Err("not called on the main thread".to_owned()));
    }
}
