// Declares the app's own commands. The page may call each one only because
// capabilities/main.json grants its permission (decision D-10); the capability
// grants exactly these eight and no core or plugin permission.

use std::path::Path;

/// The page the app embeds: desktop/frontend, which `npm run copy` in desktop/
/// makes from the repository's index.html and covers, and which git ignores.
const PAGE: &str = "../frontend";

fn main() {
    // Without the copied page the Tauri macros stop deep inside the build with
    // a proc-macro panic and no hint (Mac_PS_009), so this comes first. Cargo
    // runs this script again when the folder changes or goes missing.
    println!("cargo:rerun-if-changed={PAGE}");
    if !Path::new(PAGE).join("index.html").is_file() {
        eprintln!(
            "The page is not in desktop/frontend yet, so the app cannot be built or tested. \
             Run `npm run copy` in desktop/ first; `npm run test:rust` and `npm run lint:rust` \
             there do that for you."
        );
        std::process::exit(1);
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pick_folder",
            "saved_folder",
            "forget_folder",
            "write_text_file",
            "save_download",
            "list_notes",
            "read_note",
            "quit_ready",
        ]),
    ))
    .expect("failed to run the Tauri build script");
}
