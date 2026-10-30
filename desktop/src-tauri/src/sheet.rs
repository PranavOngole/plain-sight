//! The "Quit without saving?" sheet's alert (D-48, `Mac_PS_005`), built here
//! for quit.rs, which shows it on the document window, and for
//! tests/quit_sheet.rs, which reads its buttons without showing it.
//!
//! Cancel holds Return, so Return keeps everything as it was, as approved on
//! 21 October; Quit holds no key at all, so only a click on it quits. NSAlert
//! gives a button titled "Cancel" the Escape key, and when that button is the
//! first one added it then gives no button Return (the Delivery Manager's
//! probe of 29 October on macOS 26.5.2; PO-GUI-2, where the real-key run's
//! Return did nothing to the sheet). So the keys are set here, after the
//! buttons are added. A button holds one key, and the button that holds
//! Return is the window's default button: made the default while it held
//! Escape, Cancel took Return in its place (Developer N's probe, round 18).
//! No button holds Escape.

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::NSAlert;
use objc2_foundation::NSString;

/// The alert, its two buttons in this order (the sheet's answer is read by
/// position: the first is Cancel, the second Quit), with their keys set.
pub fn quit_alert(mtm: MainThreadMarker) -> Retained<NSAlert> {
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str("Quit without saving?"));
    alert.setInformativeText(&NSString::from_str(
        "Your text has not been saved. If you quit now, it will be lost.",
    ));
    let cancel = alert.addButtonWithTitle(&NSString::from_str("Cancel"));
    let quit = alert.addButtonWithTitle(&NSString::from_str("Quit"));
    cancel.setKeyEquivalent(&NSString::from_str("\r"));
    quit.setKeyEquivalent(&NSString::from_str(""));
    alert
}
