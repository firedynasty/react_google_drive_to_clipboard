# terminal_mount — use Google Drive from your Mac terminal

Six small commands for Drive for Desktop (the mount at
`~/Library/CloudStorage/GoogleDrive-<email>/My Drive`). They are the terminal counterpart of the
web app's `vim`, `web`/`open -a chrome`, and `mv` commands.

| Command | What it does |
|---|---|
| `gdwatch [--folder path]` | Read Google Docs and text notes in Chrome, following your terminal folder like termwatch. |
| `gdvim <name>[.gdoc]` | Edit a Google Doc as plain text in vim. Creates the Doc if it doesn't exist (asks first). |
| `gdopen [-n] [path]` | Open a Drive file or folder at its google.com address in Chrome. `-n` only prints the URL. |
| `gdmove <file>... <folder-url\|id>` | Move files into a Drive folder given by its web link. |
| `gdcat <name>...` | Print a Google Doc as text (a Sheet as CSV) to the terminal, like `cat`. Read-only, pipe-friendly. |
| `gdsheet <file.csv> [name]` | Turn a CSV into a native Google Sheet in the current Drive folder (asks first, prints the link). |

## Why they're needed

A `.gdoc` in the mounted Drive is a ~180-byte JSON pointer (`{"doc_id": "…"}`), not the document, so
plain `vim` shows JSON and edits would break it. These scripts use the Drive item id that Drive for
Desktop stores on every file and folder (`xattr -p com.google.drivefs.item-id#S <path>`) and the Drive API.

## Setup

1. Install Drive for Desktop: `brew install --cask google-drive`, sign in, set **Stream files**
   (streaming keeps files in the cloud until you open them, so it doesn't fill your disk).
   Skip the optional "sync folders from your computer" step.
2. Make an rclone remote named **`gdrive`** with full Drive access (`rclone config` → new remote → `drive`,
   scope `drive`). `gdvim` and `gdmove` borrow its login for API calls; `gdopen` needs no login.
   To use another remote name: `export GVIM_REMOTE=myremote`.
3. Run `./install.sh` from this folder. It copies the scripts to `~/.local/bin` and reports anything missing.
   Needs `jq`, `curl`, `python3`, `vim`, `rclone`, and `~/.local/bin` on your `PATH`.

No `source ~/.zshrc` is needed; they are standalone scripts.
Optional `~/.zshrc` shortcuts: `alias gd='cd ~/Library/CloudStorage/GoogleDrive-<email>/My\ Drive'`, `alias web=gdopen`.

## Usage

```
gd                                   # cd into Drive
gdvim "troubleshoot git"              # edit an existing Doc
gdvim buysession                      # no such Doc → "Create it in My Drive/<folder>? [y/N]"
gdopen                                # current folder in Chrome
gdopen "troubleshoot git.gdoc"        # a Doc in its editor
gdopen -n . | pbcopy                  # copy the folder's URL
gdmove a.gdoc b.txt https://drive.google.com/drive/folders/<id>
gdcat "troubleshoot git" | pbcopy    # read a Doc (Sheets print as CSV); works in pipes
gdsheet data.csv "Q3 numbers"       # CSV → Google Sheet here (asks first)
```

## Behaviour worth knowing

- **gdvim** looks in the current folder, then `My Drive`; accepts `name`, `name.gdoc`, or a mistyped `name.doc`.
  On quit it uploads only if you changed the text. If the Doc changed on Google's side while you were in vim it
  refuses to upload and keeps your edits in a temp file. The text as opened is saved to `~/.cache/gdvim/<doc_id>.txt`.
  **Saving flattens rich formatting and links** (plain text goes back in); Docs only, not Sheets/Slides.
- **gdopen** works offline; outside Drive it errors.
- **gdmove** is a real move (same file id, sharing and history kept). It refuses non-folder links, moving a folder
  into itself, and files outside Drive. The local copy disappears after Drive syncs.
- **gdsheet** uploads through the Drive API with conversion to a Google Sheet, one CSV → one Sheet (one tab). It
  puts the Sheet in the folder you're standing in and the `.gdsheet` pointer appears after Drive syncs.
- The rclone token is refreshed only when expired; a refresh through rclone can take ~50s on some machines.
- Commands that read file contents across the mount (`cat`, `grep -r`) download each file they touch.


## Google Docs reader (`gdwatch`)

Run `./install.sh` again to install the reader. From the terminal you want to follow:

```bash
gdocs                              # your existing shortcut to My Drive
gdwatch                            # opens Chrome, then returns to your shell
cd "Math notes"                    # reader follows this terminal folder
gdwatch --folder "$PWD"             # alternatively, stay on one folder
gdwatch status
gdwatch stop                       # stops the reader only
```

The browser shows the folder's Google Docs and text notes together in one scrollable feed.
Notes load automatically as they come into view; there is no file to select first.
Each card has **Copy text**, **Refresh**, and an action to open the original.
Filter by filename to focus on particular notes. Subfolders, Sheets, Slides and
other attachments appear under **Other files and folders**. Use `cd` in your terminal
to switch folders; the feed includes the current folder rather than its descendants.

This reader is read only. Google Docs are exported through the existing `gdcat` / rclone
login. Formatting, images, comments and equations that do not export as plain text
are best viewed using **Open in Google Docs**. Text notes include Markdown, `.txt`,
common source/config formats, and extensionless files. Hidden files stay hidden
unless enabled. Ordinary UTF-8 notes update when their local file changes.

The folder list reads filenames and metadata; contents load near the viewport as
you scroll, with one Google export at a time. Up to 12 exports are cached in memory
for five minutes. Per-note **Refresh** bypasses that cache and fetches later Google
edits, since the local pointer's modification time may stay the same. Login refresh
can take a minute. Exports are limited to 4 MiB; a failed note can be retried without
reloading the other cards. Changing folders cancels pending browser requests and
discards their results.

No extra Google login or React build is required. The server binds to
`127.0.0.1:7684`, separate from termwatch on 7682; `--port` selects another port.
Outside tmux it follows the calling shell via macOS `lsof`; inside tmux it follows
the current pane. Running it from another terminal switches the reader to that terminal.
State and logs live in `~/.cache/gdwatch`. Closing the browser leaves the reader running.

Run directly from this checkout without installation:

```bash
python3 terminal_mount/gdwatch --folder "$PWD"
python3 -m unittest discover -s terminal_mount/drive_reader -p 'test_*.py' -v
# Browser integration check (Node 22+, macOS Chrome; simulated Google exports):
node terminal_mount/drive_reader/browser_check.cjs
```
