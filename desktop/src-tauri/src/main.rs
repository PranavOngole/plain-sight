// Plain Sight as a desktop app: the web page (index.html and covers/) in a
// native window.
//
// The shell adds as little as it can. The page and its cover modules are
// served from inside the app under the page's own content security policy
// (tauri.conf.json), the window may show nothing but the app's own page, and
// Save writes its files through the app: into the chosen folder, never over a
// file, or to the path the save panel returned, the one write that may replace
// a file, since the panel asked. The page can call six app
// commands through the adapter in desktop/adapter.js: five for Save
// (folder.rs) and one to say it is ready to quit (quit.rs). Closing the window and quitting
// both work like Esc first (quit.rs), the window's title follows the page, and
// the menu bar is the app's own (menu.rs), whose File and Help items press the
// page's own buttons. The app runs in the macOS App
// Sandbox with four entitlements (Entitlements.plist), so the chosen folder is
// remembered as a security-scoped bookmark (bookmark.rs); one of the four is
// the network client, which the system web view needs to draw the page in
// the sandbox. The app itself has no network code.

// No console window behind the app on Windows release builds (Windows comes later).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

mod bookmark;
mod docx;
mod folder;
mod menu;
mod quit;

// Test builds only; see the module.
#[cfg(feature = "e2e")]
mod e2e;

/// window.PlainSightNative for the page, built into the app.
const ADAPTER: &str = include_str!("../../adapter.js");

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            folder::pick_folder,
            folder::saved_folder,
            folder::forget_folder,
            folder::write_text_file,
            folder::save_download,
            quit::quit_ready
        ])
        .menu(menu::build)
        .on_menu_event(|app, event| {
            let item: &str = event.id().as_ref();
            if item == menu::QUIT {
                quit::begin(app);
            } else {
                // Open..., Save... and the help item press the page's buttons (D-44).
                menu::press(app, item);
            }
        })
        // Closing the window quits the app (D-21), after the page's quit hook.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                quit::begin(window.app_handle());
            }
        })
        .setup(|app| {
            quit::install(app.handle());
            app.manage(folder::Folder::load(app.path().app_data_dir().ok()));
            // The window is built here rather than in tauri.conf.json so that
            // the handlers below are in place before the page loads.
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
            #[cfg(target_os = "macos")]
            let builder = match web_view_configuration() {
                Some(configuration) => builder.with_webview_configuration(configuration),
                None => builder,
            };
            let window = builder
                // After Tauri's own scripts, before the page, main frame only.
                .initialization_script(ADAPTER)
                .title("Untitled draft")
                // The title bar names the document on screen, the cover's title (D-20).
                .on_document_title_changed(|window, title| {
                    let _ = window.set_title(&title);
                })
                .inner_size(1000.0, 760.0)
                .min_inner_size(520.0, 420.0)
                .center()
                .resizable(true)
                // The page's paper colour, so the window does not flash white
                // while the page loads: on macOS it colours the window, and wry
                // turns off the web view's own background so it shows through.
                .background_color(Color(0xfb, 0xfa, 0xf7, 0xff))
                .on_navigation(|url| {
                    let allowed = is_app_url(url);
                    if cfg!(debug_assertions) {
                        let verdict = if allowed { "allowed" } else { "refused" };
                        eprintln!("plain-sight: navigation to {url} {verdict}");
                    }
                    allowed
                })
                // Links and scripts may not open other windows.
                .on_new_window(|_, _| NewWindowResponse::Deny)
                // Save writes through the app (folder::save_download), which
                // reports the name it used or the failure; the web view itself
                // may download nothing (DM-202).
                .on_download(|_, _| false)
                .build()?;
            #[cfg(target_os = "macos")]
            not_restorable(&window);
            #[cfg(feature = "e2e")]
            e2e::watch(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Plain Sight could not start");
}

/// macOS keeps a restorable window's state under Saved Application State to
/// put the window back after a relaunch, and may keep a picture of it (a
/// third-party reverse-engineering of the format, mothersruin.com, describes
/// window snapshot files; Apple's pages do not say); this window shows the
/// real text while peeking, so it is marked not restorable and macOS should
/// keep nothing of it (Apple, `NSWindow` `isRestorable`: "Set this property
/// to true if you want the window to be preserved or false if you do not
/// want it preserved"). D-45, `Mac_PS_015`. The test build answers a
/// `windowRestorable` probe with the value AppKit holds.
#[cfg(target_os = "macos")]
fn not_restorable(window: &tauri::WebviewWindow) {
    if let Ok(ns_window) = window.ns_window() {
        // SAFETY: Tauri's pointer to the window's NSWindow, used on the main
        // thread, where setup runs.
        let ns_window: &objc2_app_kit::NSWindow = unsafe { &*ns_window.cast() };
        ns_window.setRestorable(false);
    }
}

/// The web view's configuration, made here because Apple's Writing Tools can
/// only be turned off before the web view exists (macOS 15 and later); they
/// could otherwise read and rewrite the page's text. writingToolsBehavior is
/// not in objc2-web-kit 0.3.2, so it is set by name, to
/// NSWritingToolsBehaviorNone (-1, AppKit's NSTextCheckingClient.h).
#[cfg(target_os = "macos")]
fn web_view_configuration() -> Option<objc2::rc::Retained<objc2_web_kit::WKWebViewConfiguration>> {
    use objc2::{msg_send, sel, MainThreadMarker};
    let mtm = MainThreadMarker::new()?;
    // SAFETY: made on the main thread, as WebKit requires.
    let configuration = unsafe { objc2_web_kit::WKWebViewConfiguration::new(mtm) };
    // SAFETY: the setter takes an NSInteger and is only called where it exists.
    unsafe {
        let has_property: bool =
            msg_send![&configuration, respondsToSelector: sel!(setWritingToolsBehavior:)];
        if has_property {
            let _: () = msg_send![&configuration, setWritingToolsBehavior: -1isize];
        }
    }
    Some(configuration)
}

/// The app's own origin, where the page and its covers are served from. On
/// macOS that is tauri://localhost (Windows uses http://tauri.localhost; that
/// is for a later wave).
fn is_app_url(url: &Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_apps_own_origin_may_be_shown() {
        assert!(is_app_url(&url("tauri://localhost/index.html")));
        assert!(is_app_url(&url("tauri://localhost/covers/book.js")));
        assert!(!is_app_url(&url("https://example.com/")));
        assert!(!is_app_url(&url("http://localhost/")));
        assert!(!is_app_url(&url("tauri://example.com/")));
        assert!(!is_app_url(&url("tauri://localhost:8080/")));
        assert!(!is_app_url(&url("file:///etc/hosts")));
        assert!(!is_app_url(&url("about:blank")));
    }
}
