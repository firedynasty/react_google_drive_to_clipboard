# terminal_mount — use Google Drive from your Mac terminal

Five small commands for Drive for Desktop (the mount at
`~/Library/CloudStorage/GoogleDrive-<email>/My Drive`). They are the terminal counterpart of the
web app's `vim`, `web`/`open -a chrome`, and `mv` commands.

| Command | What it does |
|---|---|
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
