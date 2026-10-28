# Plain Sight

Write in private where everyone can see your screen.

Type anything and the screen shows a believable document being written: a novel, a work document or a research paper. Your real words go into a hidden buffer that never touches the network. A chord shows them to you, a key erases them, and when you save a `.sight` file or keep a copy on this device, what is written is ciphertext; a folder save or a plain `.txt` download is plain text, and the page says so where you choose it.

## The promise, and how it is kept

Most privacy claims ask for trust. These ask for a terminal.

| Claim | How it is kept | Check it yourself |
|---|---|---|
| Nothing you type leaves the page. Not a byte. | After it loads, the page requests nothing but its own cover modules from the same origin, and those carry nothing you type: no fetch, no XHR, no beacon, no WebSocket, no form submission, no analytics, no account. The browser enforces it: the page's Content Security Policy is `default-src 'none'`, so a bug could not fetch, post, open a socket, load an image or a frame from the network, or load a script from anywhere but the page's own host; the few paths no policy covers (a navigation, a link hint, a WebRTC connection, a request for one of the page's own files with something typed into its address) exist in browsers, and no line of this page uses any of them. | `grep -c -E "fetch\(\|XMLHttpRequest\|sendBeacon\|WebSocket" index.html` prints `0`. Open the browser's network panel and type for a minute: no requests. |
| Nobody else is in the room. | No server-side code, no cookies, no third-party script, no font or image from anywhere else. The deployment is exactly five files by allowlist: this page, the three covers and the header settings file, which is not served. | `curl -sI https://cover-story-taupe.vercel.app/` shows no `set-cookie`; `cat .vercelignore` is the allowlist. |
| Your text is one variable in memory. | It lives in a closure. It is written into the page only while you peek and removed when the peek ends. Nothing on `window` returns it. | `grep -n "let real" index.html`; `npm test` includes a check that local storage never holds it. |
| Saving a `.sight` file means encrypting. | AES-256-GCM with a key from your password by PBKDF2-SHA-256 at 310,000 rounds and a random 16-byte salt, a random 12-byte IV, all through the browser's WebCrypto with a non-extractable key. The file is a short JSON record you can read. | Save, open the `.sight` file in a text editor, and compare it with the format below. |
| The device vault stores ciphertext only. | The optional copy in your browser's storage is the same record under a phrase of 12 characters or more; the key exists only in memory while the vault is open. | `npm test` runs the vault round trips with right and wrong phrases. |
| A hostile network sees the page load and nothing of yours. | One load over TLS behind HSTS, then at most the page's own cover files from the same host: there is no keystroke timing to watch because nothing you type is sent. The observer learns the hostname and the size of the loads, never a word. | `curl -sI https://cover-story-taupe.vercel.app/ \| grep -i strict`. |
| You can read every line. | One HTML file and three cover files, no framework, no build step, no runtime dependency, MIT. | `wc -l index.html covers/*.js`. |

What it does not do is listed just as plainly in the threat model below: it cannot stop a keylogger, a compromised machine, a browser extension or someone reading your fingers.

## Who it is for

People who write where someone can see the screen: a newsroom, an open office, a train, a shared flat, a classroom. A journalist drafting a note that is not ready to be seen, a person keeping a journal they do not want to explain, anyone who wants a scratchpad that is nobody's business. The watcher sees a document being written, the page's own short notices and, only if you press the peek chord, your text; never your words otherwise, unless you saved them as plain text and the browser or the computer opens that file.

Live: https://cover-story-taupe.vercel.app

Demo GIF: not recorded yet. (Pranav: record a 10 to 15 second screen capture of typing, pressing Cmd+Shift+G to peek, and pressing Esc, convert it to a GIF, save it as `docs/demo.gif`, add the image here, and delete this paragraph.)

Plain Sight was called Cover Story until 20 October 2026. Files saved under the old name still open. A Mac app built around the same page is in progress on the `desktop` branch; its gate saw no network use, which macOS does not yet enforce, and it is not yet cleared for handing to others.

## The three versions

Pick one on the intro screen. The choice is remembered in your browser.

### 1. A novel

Serif type on a paper background, a 680px measure, chapter headings, and a header that reads "Untitled draft" with a live word count. The word count counts the cover text on screen, never your real text. The cover text is an original short story of about 1,760 words that loops with a paragraph break when it runs out.

![The novel cover](docs/book.png)

### 2. A work document

Looks like a modern document editor: sans-serif type, a narrower measure, a document title ("Q3 planning notes"), a thin toolbar of greyed icon placeholders drawn in CSS that do nothing, and "Last edited just now" on the right. That text is decorative and never changes. The cover text is about 1,280 words of ordinary internal project notes for a fictional company, with short headings, bullet lists, action items with invented owners and a decisions section.

![The work document cover](docs/work.png)

### 3. A research paper

Looks like a manuscript: an academic serif on a white sheet, a title block with a fictional title, author and affiliation, numbered sections (Abstract, 1. Introduction, 2. Method, 3. Results, 4. Discussion) and a reference list. The header shows "Page 1 of 1", which is decorative. Citations in the text look like [1] and are plain text. The cover text is about 1,630 words on a deliberately bland topic, and every citation in it is fictional.

![The research paper cover](docs/paper.png)

## Controls

Ctrl is Cmd on a Mac. Either key works on every platform.

| Action | How |
|---|---|
| Write | Type. Each printable key, Enter and Tab is recorded in the hidden buffer and reveals one more character of the cover. Backspace removes one from both. The buffer is append-only: you cannot move the cursor back and edit earlier text. |
| Peek | Press Ctrl+Shift+G. The cover disappears and your real text is shown. Press it again, type anything, switch windows, or open any dialog, and it is hidden again. |
| Copy | While peeking, press Ctrl+C. Your real text goes to the clipboard. |
| Clear | Press Esc. The hidden buffer and the screen are erased. If the device vault is open it is saved first and then locked; its encrypted copy stays. The page also clears itself if its tab has been hidden for more than 10 minutes while the buffer holds text, a dialog waits for a password, or a phrase is typed on the intro; a typed phrase or password goes with it. |
| Save | The Save button asks for a password and downloads a `.sight` file. If you have chosen a folder on the intro screen, it writes a plain file into that folder instead, as `.txt`, `.md` or `.docx` (Word), whichever you picked there. If you picked a plain download on the intro screen (`.txt`, `.md` or `.docx`), it downloads that file named by the moment, with no password. |
| Open | The Open button reads a `.sight` file, asks for its password and replaces the hidden buffer with its contents. It also reads a plain `.txt` or `.md` note, asking first if there is text on the page. Either way the screen is rebuilt to the same length and writing goes on from there. Esc pressed while a note is still being read cancels it. On an address without encryption a plain note still opens; only a `.sight` file needs it. A `.docx` cannot be opened. |
| Keep on this device | On the intro screen, tick "Keep my text on this device" and choose a phrase of 12 characters or more. From then on the page keeps an encrypted copy of your text in this browser. See the device vault below. |
| Unlock | On a later visit, type your phrase on the blank page, then hold Ctrl, press E, then Enter. The right phrase brings your text back. A wrong phrase does nothing at all. |
| Save to a folder | On the intro screen, "Choose a folder on this computer" (Chrome, Edge and other Chromium browsers; Brave after turning a setting on). From then on Save writes a plain file named by the moment you press it, for example `2026-10-20 14-55-03.txt`, into that folder: `.txt`, `.md` or a Word `.docx`, as picked under "Files in the folder are". "Stop using the folder" brings the download back. |
| Help | The `?` button at the bottom right brings the intro screen back, with the version picker, the vault settings, the save folder and the custom cover text box. |

Other keys pressed with Ctrl, Cmd or Alt held are left to the browser and not recorded. Ctrl+E and Ctrl+Enter are taken by the page only while a vault exists on the device. Shift+Tab is left to the browser too, so keyboard users can reach the buttons (Safari skips buttons by default, so there it is Option+Shift+Tab). Keyboard events with `isComposing` set (input method editors) are ignored. Reloading or closing the tab erases the hidden buffer unless the vault holds a copy; if the buffer is not empty, the browser shows its standard "leave page" prompt first.

## How it works

Everything is in `index.html` (the engine, the styles and the intro) plus one ES module per cover in `covers/`. There is no framework, no build step and no runtime dependency. The only development dependency is jsdom, for the tests.

- A `keydown` listener on `document` handles every key. Printable keys are `preventDefault`ed, appended to a string that lives in a closure, and advance a cursor one character through the cover text.
- The cover is rendered one character per keystroke into paragraphs. A cover line that starts with `## ` becomes a heading, a line that starts with `- ` becomes a bullet in a list, and a line that starts with `[n] ` is typed as text but styled as a reference entry. The markers themselves cost no keystrokes.
- About 3.5 percent of the time, at the start of a word, the cover shows a wrong neighbouring key instead of the right letter; the next keystroke removes it. It costs two keystrokes, one for the wrong letter and one to remove it, and looks like a person correcting a typo. The keystroke right after a correction never produces another one.
- When the cover text runs out, the page inserts a paragraph break and starts the text again from the top.
- The hidden buffer is written into the page only while peeking and is removed again when peeking ends. The page's small console object (`window.PlainSight`) exists for the cover loader and the tests; it returns the cover id and text and nothing that touches the hidden buffer, encrypted or not. Any script that runs inside the page could still capture keystrokes directly, which is the extension and malware caveat below.
- Covers are loaded with a dynamic `import('./covers/<id>.js')` from a small module script, so the page must be served over http. Opened directly from a file, the browser blocks the import and the page shows a notice saying so.
- `localStorage` holds whether you have seen the intro, which cover you picked, any custom cover text you pasted, your download choice (encrypted or plain), a timestamp that tells other open tabs the save folder changed and, only if you turned the vault on, the encrypted copy of your text. It never holds the hidden buffer in clear.

### The device vault

Off by default. On the intro screen, tick "Keep my text on this device" and enter a phrase of at least 12 characters. The page derives a key from the phrase (PBKDF2, SHA-256, 310,000 iterations, a fresh random 16-byte salt) and keeps that key in memory only. It then saves the hidden text to `localStorage` as AES-256-GCM ciphertext with a fresh 12-byte IV: 1.5 seconds after the last keystroke, when the tab is hidden, and when you press Esc. The stored record has the same shape as a saved file (below). Neither the phrase nor the text is stored in clear. If the device refuses the write (storage full, site data blocked, or a note above roughly 3.7 MB in WebKit), the vault locks, a toast says so, and the earlier copy stays; your text stays on the page, and entering the phrase on the intro screen then reopens the vault around the page text as it is, which becomes the copy once the device accepts it. If the copy disappears from the device while the vault is open (site data cleared), the vault locks and says so.

Esc, the 10-minute hidden-tab wipe and closing the tab lock the vault: the key is forgotten and the encrypted copy stays. To come back to your text, type the phrase on the blank page (it shows as cover text like any typing), then hold Ctrl, press E, then Enter. The page derives the key from what you typed and tries to decrypt the copy. If it works, the saved text replaces the phrase in the buffer and the cover is rebuilt to its length. If it does not, nothing happens: no message, no change. There is no recovery for a forgotten phrase. On the writing screen, the only sign that the vault is open is the header text (the word count, "Last edited just now" or "Page 1 of 1") drawn in ink instead of grey; the intro's vault box says it in words.

Two tabs of the page in the same browser share one copy: each tab saves on its own schedule and the last save wins. Deleting the copy or changing the phrase in one tab locks the other tabs, which drop any save still on its way instead of writing the old copy back. To stop keeping a copy, open the intro with `?`, untick the box and press Start: the encrypted copy is deleted from the device, whether or not it can still be read. Entering a phrase while the copy is locked opens it instead of replacing it, with anything typed before the intro opened added after the saved text; a phrase that does not open the copy is refused and nothing is overwritten. Entering a new phrase while the vault is open re-encrypts the copy under the new phrase. Esc on the intro applies your choices exactly like Start.

### Browser support

| Browser | Type, peek, copy, clear, vault | Encrypted `.sight` download | Plain download (`.txt`, `.md`, `.docx`) | Write straight into a folder | Checked on this version |
|---|---|---|---|---|---|
| Chrome, Edge, Chromium | by design | by design | by design | by design | not yet; nothing has run in these browsers on this version, and this row's folder cell has only ever run against the test suite's simulated folder; the one real folder run so far is the Brave row below |
| Brave | by design | by design | by design | after turning on `brave://flags/#file-system-access-api` and relaunching; the page shows this | Pranav on 22 October, on 1.3.10: two plain files written into the chosen folder, the second after a reload through the permission prompt; after "Stop using the folder", Save downloaded an encrypted file through Brave's save panel; the `.md` and `.docx` formats of this version have not been tried in Brave yet |
| Safari | by design | by design | by design, with a warning: Safari opens downloaded text files by itself unless "Open safe files after downloading" is off (Settings, General), which may show your text on screen for a `.txt` or `.md` file, and a `.docx` may open too (Pranav's `.txt` download on 22 October, on 1.3.10, did not open by itself; `.md` and `.docx` have not been tried in Safari itself); Safari can also ask where each file goes (File download location: Ask for each download) | no, the browser has no folder access | headless WebKit (Safari's engine) at every release's gate (1.1.1, 1.2.0, 1.3.0 and 1.3.1 had none of their own and were first checked at the following release's gate); on the 1.4.0 page before its merge into main, on 21 and 22 October 2026 with QA-01's scripts wk_save, wk_open, wk_open2, wk_a11y, wk_surrogate, wk_net and wk_folder: Save in `.txt`, `.md`, `.docx` and `.sight`, Open of plain notes and of a `.sight`, the vault with notes it can and cannot store, Backspace after an emoji, the accessibility tree, and a network trace that showed only the page and its cover module; four of the seven end with known failures that are not defects of this version: wk_a11y (the header's grey at 3.32:1, the cover's design and the vault's tell, plus two heading rules), wk_open (an old Tab-cycle check, and five file-name answers changed on purpose for QA-G-03), wk_open2 (the 4 MB keep check, which the lock fails by design) and wk_folder (the "(99)" overwrite, QA-F-10, fixed on main after the merge); Pranav on 22 October, on 1.3.10: a plain .txt downloaded through Safari's save panel and did not open by itself, Safari offered its password menu (the key icon) on the masked phrase field, and a paste of what Cmd+C took from that field showed dots, not the phrase; the automatic opening of downloads is a Safari setting that headless runs cannot show |
| Firefox | by design | by design | by design, and Firefox can ask where each file goes (Settings, General, Downloads) | no, the browser has no folder access | not yet |

The page detects whether folder access exists and shows the matching note in "Where Save writes" on the intro screen. The browser family is read only to pick the wording of that note; nothing else depends on it.

### Saving into a folder

In browsers with the File System Access API (Chrome, Edge and other Chromium browsers, and Brave once its setting is on) the intro screen offers "Choose a folder on this computer". The page keeps the folder handle in IndexedDB and asks the browser for write permission when it needs it. With a folder chosen, Save writes your real text into a new file named by the moment of the click, `YYYY-MM-DD HH-MM-SS.txt` (or `.md`, or `.docx` for a Word document, as picked on the intro screen; a counter goes before the extension if that name is already taken), and shows the name in a toast; nothing is encrypted and no password is asked. The text written is the text on the page when you pressed Save, even if you press Esc while the browser asks for permission. Choosing or forgetting a folder in one tab reaches your other open tabs. Anyone who can open that folder can read those files, and the computer treats them like any document: on a Mac, Spotlight indexes their contents, Quick Look previews them, Time Machine backs them up, and a Desktop or Documents folder synced by iCloud Drive uploads them to Apple. Pick a folder outside Desktop and Documents if that matters to you. In other browsers the button is hidden and Save downloads instead: an encrypted `.sight` file by default, or, if you pick one on the intro screen, a plain `.txt`, `.md` or `.docx` file named by the moment with no password. Both choices are kept in `localStorage`; the download choice works in every browser.

A `.docx` from Save is a minimal Word document that the page writes itself: one paragraph per line of your text, a Word tab for each tab, and no metadata (no author, no dates, no application name; every part of the archive is dated 1 January 1980). LibreOffice gives the text back unchanged apart from one final line break it adds and a byte-order mark it writes; macOS's `textutil` (the text system TextEdit uses) likewise, except that it drops a U+FEFF or a U+FFFC in the text itself, which python-docx returns exactly; Microsoft Word and Pages have not been tried yet. A carriage return in the text ends a paragraph like a line feed. The document the page writes from `tests/fixtures/sample.txt` is kept as `tests/fixtures/sample.docx`; the test suite checks the page's bytes against it, and the Mac app's writer is held to the same two files on its own branch (the App Store candidate). A `.md` file is your text exactly as typed.

### Save file format

Save encrypts the hidden buffer with AES-256-GCM. The key is derived from your password with PBKDF2 (SHA-256, 310,000 iterations, a random 16-byte salt) and the cipher uses a random 12-byte IV, all through the browser's WebCrypto API. The downloaded `.sight` file is JSON:

```json
{
  "format": "plain-sight",
  "version": 1,
  "cipher": "AES-256-GCM",
  "kdf": "PBKDF2-SHA-256",
  "iterations": 310000,
  "salt": "<base64, 16 bytes>",
  "iv": "<base64, 12 bytes>",
  "data": "<base64, ciphertext plus the 16-byte authentication tag>"
}
```

Open checks the shape of the file, refuses a format, version, cipher or kdf field that does not match the above (`"cover-story"` from the project's earlier name is also accepted), refuses an iteration count below 1,000 or above 2,000,000 (so a crafted file cannot hang the tab), derives the key and decrypts. A wrong password or a damaged file fails with the toast "Wrong password or damaged file" and nothing else changes. Those are the parameters; judge them for yourself. There is no password recovery.

## Threat model

What it helps with:

- A casual onlooker who can see your screen sees a document being written, not your text. The tab title, the header and the typing rhythm all fit the cover, and the unlock phrase shows as cover text while you type it.
- Walking away from the machine with the tab in the background: the page clears itself after 10 minutes hidden, including a phrase or password typed but not submitted. (If the tab stays in the foreground, nothing clears on its own. Press Esc.)
- Someone who finds a saved `.sight` file, or the vault copy in the browser's storage, without the password or phrase gets the ciphertext, its exact byte length (AES-GCM adds no padding), the parameters listed under "Save file format" and, for a downloaded file, a name made of the cover's title and the minute it was saved; nothing of the text.
- Network observers: nothing you type is sent anywhere; the page requests only its own files from its own host, and its Content Security Policy makes the browser refuse every other request it governs; the paths no policy covers (a navigation, a link hint, a WebRTC connection, a request for one of the page's own files with something typed into its address) are used by no line of this page.

What it does not protect against:

- Onlookers reading your fingers or lips, or a camera pointed at the keyboard.
- Anyone who can see the screen while you are peeking, or who looks at your clipboard after you copy.
- A compromised machine. Malware, a hardware or software keylogger, or screen recording captures keystrokes and pixels before the page ever sees them.
- Browser extensions. An extension with access to the page can read its DOM and JavaScript state, including the hidden buffer.
- Corporate monitoring: endpoint agents, managed browsers, data loss prevention tools and screen recording all sit outside the page.
- A forgotten password or phrase. Neither the file nor the vault copy can be opened without it.
- A weak phrase. Anyone who can read the browser's storage on your device can try phrases offline; the slow key derivation helps, a long phrase helps more.
- The browser's own memory. While the page is open, the plain text is in the browser's memory, and a crash dump or swap file could hold it.
- Shared computers. The vault copy stays on the device after Esc; on a machine other people use, leave the vault off or delete the copy before you leave.
- Plain files. Saving into a folder, or choosing a plain `.txt`, `.md` or `.docx` download, writes your words unencrypted to disk, where any program, backup or person with access to that folder can read them; on a Mac, Spotlight indexes the contents, Quick Look previews the files, and a synced Desktop or Documents folder uploads them to iCloud Drive, and a browser set to open downloads may display them at once. Use the encrypted download or the vault when that matters.

Corporate IT may treat a page like this as an exfiltration or monitoring-evasion tool. Using it on a managed machine may break policy regardless of what you type. It exists to demonstrate a client-side technique and an honest threat model, not to defeat an employer's monitoring.

## Known limitations

- No mobile support. Virtual keyboards do not reliably fire `keydown` events, so typing on a phone or tablet does not work. The layout does not overflow at phone widths, but the page is a desktop tool.
- Only key presses are recorded. Text that arrives another way, such as a paste, drag and drop, dictation or the composed text of an input method editor, is neither recorded nor shown.
- Characters that need Alt, Option or AltGr on your keyboard layout (for example @ or { on many non-US layouts, or accented letters typed with Option on a Mac) are passed to the browser and not recorded, because every Alt chord is left alone.
- The hidden text is append-only. You can peek, copy and backspace, but not move the cursor back and edit.
- The page has to be served over http (see "Run locally"). Opening `index.html` directly shows a notice instead of a cover.
- Peek, copy and unlock are keyboard chords, so they do not work from a touch screen.
- Saving into a folder needs the File System Access API, which Chromium browsers offer (Brave behind a setting) and Safari and Firefox do not; those two get a download instead: the encrypted `.sight` by default, or `.txt`, `.md` or `.docx` by choice. The folder path was checked here with a simulated folder in the test suite; the plain download was checked in headless WebKit; real-browser runs on this version are listed in the browser table.
- With the vault on, the page saves 1.5 seconds after the last keystroke and again when the tab is hidden, on Esc and on the way out of the page. Closing or reloading the tab within about a second of typing can still lose those last keystrokes from the copy, because the browser may not wait for the encryption to finish.
- Tested headless in WebKit (Safari's engine) at every release's independent gate (1.1.1, 1.2.0, 1.3.0 and 1.3.1 had no gate of their own and were first checked at the following release's gate), and on the 1.4.0 page on 21 and 22 October 2026 before its merge into main: no console errors, all three covers, the chords, the vault, save and open, and no horizontal overflow at 390px; the builder's own WebKit checks run on each deployment as well. Current Chrome, Edge and Firefox use the same standard APIs (WebCrypto, ES modules, the Clipboard API with a fallback) and are expected to work, but they have not been checked on this version.

## Being safest

- The Mac app (the `desktop` branch) will be the better choice on shared machines and untrusted networks once it is cleared for others: its gate saw no network use, and no browser extension can reach it. Until then, use the page in a browser profile with no extensions.
- Use the encrypted save or the vault. A plain `.txt` is readable by anyone with the folder, and macOS indexes it for Spotlight and may sync it to iCloud.
- Press Esc when you step away. The peek chord is public, so anyone at your keyboard can use it.
- On a shared network, open the page from an https link or bookmark, never click through a certificate warning, and clear your clipboard after a copy.
- Use a browser profile without extensions. An extension with page access can read anything on the page.

## Planned hardening

Logged on 21 October 2026, in this order: an App Sandbox with no network permission for the Mac app, so macOS itself refuses every connection; Secure Keyboard Entry and a capture-proof window while the real text is on screen in the app; a clipboard that clears itself after a copy; an idle lock that wipes the screen and locks the vault, in the app also when the Mac locks; a higher PBKDF2 round count (the vault carries the count with its key since 1.3.10, so older copies keep opening); and encrypted, plainly named files for folder saves. None of these exists yet; each will appear in the changelog when it does.

## Run locally

```
git clone https://github.com/PranavOngole/plain-sight.git
cd plain-sight
npx serve -l tcp://127.0.0.1:3000 .
```

Then open http://localhost:3000. The `-l` option keeps the server on this computer only; `serve` listens on every network address by default, which would expose anything else in the folder. Any static file server works; the page needs http only so the browser will import the cover modules. Use localhost or https: on any other plain http address the browser gives the page no encryption, so the vault and encrypted files cannot work there, and the intro says so.

To run the tests:

```
npm install
npm test
```

The suite (`tests/smoke.mjs`) loads the real `index.html` in jsdom and drives it through keyboard events, the dialogs, the download path and the console object: cover rendering, the hidden buffer, the peek chord, copy, Backspace, Esc, the 10-minute wipe, the three covers, bullets, headings, references, save and open with right and wrong passwords, and the device vault with right and wrong phrases. It exits non-zero on any failure. jsdom does not run module scripts, so the suite imports the cover files itself and hands them to the page the same way the module loader does.

## Deployment

The site is served with security headers from `vercel.json`: a script policy that allows scripts from the page's own origin and its two inline scripts by hash and nothing else, no framing, no content sniffing, no referrer, and five browser features the page never uses turned off (camera, microphone, location, payment, USB). `node tools/vercel-headers.mjs` regenerates the file from `index.html`; `npm test` fails when the two disagree, and the builder runs it before every deploy (a practice: nothing in the repository runs it on `vercel --prod`); a page deployed with a stale hash shows a blank document (measured on 1.3.10 by the independent gate), which the headless WebKit checks run on each deployment would show.

The site is deployed with the Vercel CLI (`vercel --prod`) as plain static files with no framework and no build step. `.vercelignore` is an allowlist: everything is excluded except `index.html`, `covers/` and `vercel.json`, so nothing else in the working folder can reach the deployment. Until 20 October 2026 it was a list of exclusions and the deployment carried local tool files; see the changelog for 1.3.1.

## Fictional content

All cover text is original prose written for this project. The people, places and events in the story, the company, project, owners, dates and figures in the work notes, and the study, region, figures, authors, affiliation and every reference in the paper are fictional. None of the cited papers exist. The author name and affiliation in the paper's title block are placeholders.

## License

MIT. See `LICENSE`.
