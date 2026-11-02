// The desktop app's side of the page. The page calls window.PlainSightNative
// (index.html, search for "native") and each call here becomes one of the
// app's own commands (src-tauri/src/folder.rs). The app keeps the folder's
// path; the page only ever gets the folder's name (D-07), and for Continue the
// names and the text of the notes Save wrote there, never a path. The app also
// runs window.__plainSightQuit before it closes or quits (src-tauri/src/quit.rs).
//
// The app injects this before the page runs, in the main frame only, after
// Tauri's own scripts, which provide __TAURI_INTERNALS__.invoke. Both objects
// are fixed: the properties can be neither replaced nor deleted, so nothing
// that runs later in the page can swap them for others.
(() => {
  'use strict';
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const fixed = (name, value) => Object.defineProperty(window, name, { value, writable: false, configurable: false, enumerable: false });
  let quitCallback = null;   // the page's quit hook, run by __plainSightQuit below
  let unsavedCallback = null;   // the page's answer whether a quit would lose text, asked by __plainSightUnsaved below

  fixed('PlainSightNative', Object.freeze({
    // { name } of the chosen folder, or null when the picker is cancelled.
    pickFolder: () => invoke('pick_folder'),
    // { name } of the folder remembered from an earlier run, or null.
    savedFolder: () => invoke('saved_folder'),
    forgetFolder: () => invoke('forget_folder').then(() => undefined),
    // Writes the text into the folder as a ".txt", ".md" or ".docx" file (the
    // app makes the Word document from the text) and answers with the file
    // name used, such as "2026-10-20 14-55-03 (2).docx".
    writeTextFile: (base, ext, text) => invoke('write_text_file', { base, ext, text }),
    // Save without a folder: the app shows the system save panel with the
    // name proposed, starting in Downloads, writes the file where the panel
    // put it and answers with the name used, null when the panel was
    // cancelled, or fails, so the page's toast tells the truth (D-49).
    saveDownload: (name, text) => invoke('save_download', { name, text }),
    // Continue: the names of the notes Save wrote into the folder, newest
    // first, and the text of one of them by its name. A failure answers the
    // app's own words, which the page shows.
    listNotes: () => invoke('list_notes'),
    readNote: (name) => invoke('read_note', { name }),
    onQuit: (callback) => { if (typeof callback === 'function') quitCallback = callback; },
    // The page's answer to "would a quit lose text?": true when text is on the
    // page and no vault keeps it; the app then asks before it quits (D-48).
    onUnsavedText: (callback) => { if (typeof callback === 'function') unsavedCallback = callback; }
  }));

  // Before it quits, the app asks this first (src-tauri/src/quit.rs): true
  // shows the "Quit without saving?" sheet, false quits as before. A missing or
  // failing callback answers false, so a quit can never hang on the question.
  fixed('__plainSightUnsaved', () => {
    try { return Boolean(unsavedCallback && unsavedCallback()); } catch (err) { return false; }
  });

  // Closing the window or quitting the app runs this first. The page's quit
  // callback (Esc's wipe and the vault's last write) gets up to 1.8 seconds.
  // WebKit's networking process keeps a localStorage write in a transaction
  // that it commits half a second later (SQLiteStorageArea, transactionDuration
  // 500 ms), so an app that ended at once could lose the vault's last write
  // (QA-C-01). A storage estimate goes the same way as the write and is
  // answered after it, so its answer (or 0.4 s) means the write has arrived;
  // then the commit gets 0.7 s, and the app is told it may end. All of it stays
  // inside the app's own 4 s safety timer (quit.rs, D-42). A failing callback must
  // not keep the app open, and quit_ready is refused unless the app is really
  // quitting.
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  fixed('__plainSightQuit', async () => {
    try {
      await Promise.race([
        new Promise((resolve) => resolve(quitCallback ? quitCallback() : undefined)),
        wait(1800)
      ]);
    } catch (err) { /* the app ends anyway */ }
    try {
      await Promise.race([navigator.storage.estimate(), wait(400)]);
    } catch (err) { /* no storage estimate: the wait below still applies */ }
    await wait(700);
    return invoke('quit_ready').catch(() => {});
  });

  // A right click on the page shows no menu, so it offers no Reload, Back,
  // Inspect or web search of the text. Text fields keep theirs, with Cut, Copy
  // and Paste; checkboxes and radio buttons are not text fields.
  const textField = (el) => el instanceof Element &&
    el.matches('textarea, input:not([type]), input[type="text"], input[type="password"], input[type="search"]');
  window.addEventListener('contextmenu', (e) => { if (!textField(e.target)) e.preventDefault(); }, true);
})();
