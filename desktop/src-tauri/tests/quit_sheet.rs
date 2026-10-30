//! The "Quit without saving?" sheet's buttons (D-48; PO-GUI-2, round 18):
//! the alert that src/sheet.rs builds, as quit.rs shows it, read without
//! showing it and with no event posted, as the Delivery Manager's probe of 29
//! October read it. AppKit makes windows on the main thread only, so this
//! test has its own main (harness = false in Cargo.toml) and runs there, with
//! the process's activation policy set to prohibited first, so that no Dock
//! icon appears. It fails unless the buttons are Cancel and then Quit, Cancel
//! holds Return with no modifier, and Quit holds no key at all, so neither
//! Return nor Escape can quit.

#[cfg(target_os = "macos")]
#[path = "../src/sheet.rs"]
mod sheet;

#[cfg(target_os = "macos")]
fn main() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

    let mtm = MainThreadMarker::new().expect("the test runs on the main thread");
    NSApplication::sharedApplication(mtm)
        .setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    let alert = sheet::quit_alert(mtm);
    let buttons = alert.buttons();
    let read: Vec<(String, String, usize)> = (0..buttons.count())
        .map(|i| {
            let b = buttons.objectAtIndex(i);
            (
                b.title().to_string(),
                b.keyEquivalent().to_string(),
                b.keyEquivalentModifierMask().0,
            )
        })
        .collect();
    for (title, key, mask) in &read {
        println!("button {title:?}: key {key:?}, modifier mask {mask}");
    }
    let holds = |title: &str| read.iter().find(|(t, _, _)| t == title);
    let checks = [
        (
            "the buttons are Cancel and then Quit, the order the sheet's answer is read in",
            read.iter().map(|(t, _, _)| t.as_str()).collect::<Vec<_>>() == ["Cancel", "Quit"],
        ),
        (
            "Cancel holds Return with no modifier, so Return keeps the text",
            holds("Cancel").is_some_and(|(_, key, mask)| key == "\r" && *mask == 0),
        ),
        (
            "Quit holds no key, so neither Return nor Escape quits; only a click does",
            holds("Quit").is_some_and(|(_, key, _)| key.is_empty()),
        ),
    ];
    let mut failed = 0;
    for (name, ok) in checks {
        println!("test {name} ... {}", if ok { "ok" } else { "FAILED" });
        if !ok {
            failed += 1;
        }
    }
    let passed = checks.len() - failed;
    if failed == 0 {
        println!("test result: ok. {passed} passed; 0 failed (quit_sheet, on the main thread)");
    } else {
        println!("test result: FAILED. {passed} passed; {failed} failed (quit_sheet, on the main thread)");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {}
