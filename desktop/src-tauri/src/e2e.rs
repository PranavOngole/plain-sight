//! Test builds only (cargo feature `e2e`). The release app is built without
//! this feature, so none of this code is in it.
//!
//! It lets the end-to-end tests read the page and take pictures of it while
//! they drive it, through files in `$PLAIN_SIGHT_E2E_DIR`, because macOS
//! keeps window contents away from other programs while the screen is locked
//! and the test runner has no Screen Recording permission. The runner writes
//! `request.json`, `{"id": 1, "eval": "<expression>"}` or
//! `{"id": 2, "snapshot": "name.png"}`; the app answers in `response-<id>.json`
//! with `{"ok": true, "value": ...}` or `{"ok": false, "error": "..."}`.
//!
//! The window: `{"id": n, "close": true}` closes it as its red button does
//! (macOS shows Accessibility no windows while the screen is locked, so the
//! runner cannot press the button itself; it answers before it acts, since the
//! app may be gone after), `{"id": n, "windowTitle": true}` answers its title,
//! `{"id": n, "writingTools": true}` the web view's Writing Tools setting,
//! `{"id": n, "delegateResponds": true}` whether the app's delegate answers
//! applicationShouldTerminate: (quit.rs), `{"id": n, "windowRestorable": true}`
//! whether macOS may keep the window's state (main.rs sets it off),
//! `{"id": n, "sheet": "quit"}` (or "cancel") presses that button of the
//! "Quit without saving?" sheet (quit.rs) as its completion handler sees it,
//! false when no sheet is up, and
//! `{"id": n, "window": "minimize"}` (or "unminimize", "hide", "show")
//! minimizes it or hides the app as the yellow button and Cmd+H do; "show"
//! brings a hidden app back as a click on its Dock icon does: it unhides the
//! app and then asks macOS to make it the active app (`unhide_and_activate`).
//! `{"id": n, "windowState": true}` answers, for the evidence when a wait for
//! the page's visibility times out, whether any part of the window is visible
//! (its occlusion state), whether it is on screen, minimized, on the active
//! space and the key window, and whether the app is the active one and
//! hidden. The Quit item and the Dock's quit need no probe: the runner
//! presses the real item through Accessibility and sends the Dock's quit
//! request itself.

use std::path::{Path, PathBuf};
use std::time::Duration;

use objc2::runtime::{AnyObject, NSObjectProtocol};
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSWindow,
    NSWindowOcclusionState,
};
use objc2_foundation::{NSDictionary, NSError, NSString};
use objc2_web_kit::WKWebView;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::quit::macos::{end_sheet, on_main_run_loop};
use crate::quit::Choice;

pub fn watch(app: AppHandle) {
    let Some(dir) = std::env::var_os("PLAIN_SIGHT_E2E_DIR").map(PathBuf::from) else {
        return;
    };
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(40));
        let request = dir.join("request.json");
        let Ok(text) = std::fs::read_to_string(&request) else {
            continue;
        };
        let _ = std::fs::remove_file(&request);
        let Ok(req) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let id = req["id"].as_u64().unwrap_or(0);
        let answer = dir.join(format!("response-{id}.json"));
        let Some(window) = app.get_webview_window("main") else {
            respond(&answer, json!({ "ok": false, "error": "no window" }));
            continue;
        };
        if let Some(expression) = req["eval"].as_str() {
            // The page's own world, so the page's DOM and globals are visible.
            let script = format!("JSON.stringify(({expression}) ?? null)");
            let _ = window
                .with_webview(move |webview| unsafe { eval(webview.inner(), &script, answer) });
        } else if let Some(name) = req["snapshot"].as_str() {
            // A bare PNG name only, so a request can never write outside the folder.
            if name.contains('/') || !name.ends_with(".png") {
                respond(&answer, json!({ "ok": false, "error": "bad name" }));
                continue;
            }
            let target = dir.join(name);
            let _ = window
                .with_webview(move |webview| unsafe { snapshot(webview.inner(), target, answer) });
        } else if req["windowTitle"].as_bool() == Some(true) {
            respond(&answer, json!({ "ok": true, "value": window.title().ok() }));
        } else if req["writingTools"].as_bool() == Some(true) {
            // The web view's writingToolsBehavior as WebKit holds it (-1 is
            // none); null where the property does not exist (before macOS 15).
            let _ = window.with_webview(move |webview| unsafe {
                use objc2::{msg_send, sel};
                let webview: &WKWebView = &*webview.inner().cast();
                let configuration = webview.configuration();
                let exists: bool =
                    msg_send![&configuration, respondsToSelector: sel!(writingToolsBehavior)];
                let value: Option<isize> = if exists {
                    Some(msg_send![&configuration, writingToolsBehavior])
                } else {
                    None
                };
                respond(&answer, json!({ "ok": true, "value": value }));
            });
        } else if req["delegateResponds"].as_bool() == Some(true) {
            // Whether NSApp's delegate has applicationShouldTerminate:, which
            // quit.rs adds at start; read on the main thread, where AppKit is.
            on_main_run_loop(move || {
                let Some(mtm) = MainThreadMarker::new() else {
                    return;
                };
                let app = NSApplication::sharedApplication(mtm);
                let responds = app.delegate().is_some_and(|delegate| {
                    delegate.respondsToSelector(sel!(applicationShouldTerminate:))
                });
                respond(&answer, json!({ "ok": true, "value": responds }));
            });
        } else if let Some(button) = req["sheet"].as_str() {
            let choice = match button {
                "quit" => Choice::Quit,
                "cancel" => Choice::Cancel,
                _ => {
                    respond(
                        &answer,
                        json!({ "ok": false, "error": "unknown sheet button" }),
                    );
                    continue;
                }
            };
            // The sheet lives on the main thread; ending it there runs the
            // completion handler, as a press of the button would.
            on_main_run_loop(move || {
                let pressed = end_sheet(choice);
                respond(&answer, json!({ "ok": true, "value": pressed }));
            });
        } else if req["windowRestorable"].as_bool() == Some(true) {
            // NSWindow's isRestorable as AppKit holds it (main.rs sets it off).
            on_main_run_loop(move || {
                if let Ok(ns_window) = window.ns_window() {
                    // SAFETY: Tauri's pointer to the window's NSWindow, on the main thread.
                    let ns_window: &NSWindow = unsafe { &*ns_window.cast() };
                    respond(
                        &answer,
                        json!({ "ok": true, "value": ns_window.isRestorable() }),
                    );
                }
            });
        } else if req["window"].as_str() == Some("show") {
            // Both steps in order on the main thread, and the answer after
            // them. Before, this was AppHandle::show ("Shows the application,
            // but does not automatically focus it", Tauri 2.12.4), which sends
            // only NSApp unhide: (tao 0.37.1, show_application,
            // src/platform/macos.rs lines 416 to 420). In e2e-run-4 (28
            // October 2026) the page stayed hidden for 5 s after it; most
            // likely the window came back behind another app's window, with
            // the app not active. That run recorded neither, so the test now
            // reads both through windowState when the wait times out.
            on_main_run_loop(move || {
                let Some(mtm) = MainThreadMarker::new() else {
                    return;
                };
                unhide_and_activate(&NSApplication::sharedApplication(mtm));
                respond(&answer, json!({ "ok": true }));
            });
        } else if req["windowState"].as_bool() == Some(true) {
            // Read on the main thread, where AppKit keeps them.
            on_main_run_loop(move || {
                let Some(mtm) = MainThreadMarker::new() else {
                    return;
                };
                let Ok(ns_window) = window.ns_window() else {
                    respond(&answer, json!({ "ok": false, "error": "no NSWindow" }));
                    return;
                };
                // SAFETY: Tauri's pointer to the window's NSWindow, on the main thread.
                let ns_window: &NSWindow = unsafe { &*ns_window.cast() };
                let ns_app = NSApplication::sharedApplication(mtm);
                let occlusion = ns_window.occlusionState();
                respond(
                    &answer,
                    json!({ "ok": true, "value": {
                        "occlusionVisible": occlusion.contains(NSWindowOcclusionState::Visible),
                        "occlusionState": occlusion.0,
                        "windowVisible": ns_window.isVisible(),
                        "miniaturized": ns_window.isMiniaturized(),
                        "onActiveSpace": ns_window.isOnActiveSpace(),
                        "keyWindow": ns_window.isKeyWindow(),
                        "appActive": ns_app.isActive(),
                        "appHidden": ns_app.isHidden(),
                    } }),
                );
            });
        } else if let Some(action) = req["window"].as_str() {
            let done = match action {
                "minimize" => window.minimize(),
                "unminimize" => window.unminimize(),
                "hide" => app.hide(),
                _ => {
                    respond(
                        &answer,
                        json!({ "ok": false, "error": "unknown window action" }),
                    );
                    continue;
                }
            };
            respond(
                &answer,
                match done {
                    Ok(()) => json!({ "ok": true }),
                    Err(error) => json!({ "ok": false, "error": error.to_string() }),
                },
            );
        } else if req["close"].as_bool() == Some(true) {
            respond(&answer, json!({ "ok": true }));
            // The red button's own path: performClose: asks windowShouldClose:,
            // which becomes the window's close request. From the main run loop,
            // outside tao's event handler, as AppKit itself would call it.
            on_main_run_loop(move || {
                if let Ok(ns_window) = window.ns_window() {
                    // SAFETY: Tauri's pointer to the window's NSWindow, on the main thread.
                    let ns_window: &NSWindow = unsafe { &*ns_window.cast() };
                    ns_window.performClose(None);
                }
            });
        }
    });
}

/// The way back to a hidden app that a click on its Dock icon takes: unhide
/// the app (the call tao's show_application makes), then ask macOS to make
/// it the active app. Apple's page for unhide(_:) says it "makes the receiver
/// active" too, but since macOS 14 activation is only a request, which the
/// system may refuse ("app activation is driven by user intent", AppKit
/// Release Notes for macOS 14, App Activation). So the request is made here
/// on its own, and the test reads isActive back through windowState when the
/// page stays hidden. activate() exists from macOS 14; the app runs from
/// 12.0, where activateIgnoringOtherApps: is the call (deprecated since macOS
/// 14). Main thread.
fn unhide_and_activate(ns_app: &NSApplication) {
    ns_app.unhide(None);
    if ns_app.respondsToSelector(sel!(activate)) {
        ns_app.activate();
    } else {
        #[allow(deprecated)]
        ns_app.activateIgnoringOtherApps(true);
    }
}

fn respond(path: &Path, value: Value) {
    // Write then rename, so the runner never reads half an answer.
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, value.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// # Safety
/// `webview` must be the WKWebView pointer Tauri hands to `with_webview`, on the main thread.
unsafe fn eval(webview: *mut std::ffi::c_void, script: &str, answer: PathBuf) {
    let webview: &WKWebView = &*webview.cast();
    let done = block2::RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
        if let Some(error) = unsafe { error.as_ref() } {
            respond(
                &answer,
                json!({ "ok": false, "error": error.localizedDescription().to_string() }),
            );
            return;
        }
        let text = unsafe { result.as_ref() }
            .and_then(|r| r.downcast_ref::<NSString>())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "null".to_owned());
        let value = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
        respond(&answer, json!({ "ok": true, "value": value }));
    });
    webview.evaluateJavaScript_completionHandler(&NSString::from_str(script), Some(&done));
}

/// # Safety
/// `webview` must be the WKWebView pointer Tauri hands to `with_webview`, on the main thread.
unsafe fn snapshot(webview: *mut std::ffi::c_void, target: PathBuf, answer: PathBuf) {
    let webview: &WKWebView = &*webview.cast();
    let done = block2::RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
        let png = unsafe { image.as_ref() }
            .and_then(|image| image.TIFFRepresentation())
            .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
            .and_then(|bitmap| {
                let options = NSDictionary::<NSString, AnyObject>::new();
                unsafe {
                    bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &options)
                }
            });
        let ok = png.is_some_and(|png| std::fs::write(&target, png.to_vec()).is_ok());
        respond(&answer, json!({ "ok": ok }));
    });
    webview.takeSnapshotWithConfiguration_completionHandler(None, &done);
}
