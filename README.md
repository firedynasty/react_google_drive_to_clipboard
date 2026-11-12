# Basic Vercel App

A simple React application with a button that displays "Hello World!" when clicked.

## Getting Started

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm start
```

3. Open [http://localhost:3000](http://localhost:3000) to view it in the browser.

## Features

- Click the button to display "Hello World!" message
- Responsive design
- Ready for Vercel deployment

## Deployment

This app is configured for easy deployment to Vercel. Simply connect your repository to Vercel and it will automatically deploy.

## Available Scripts

- `npm start` - Runs the app in development mode
- `npm run build` - Builds the app for production
- `npm test` - Launches the test runner
- `npm run eject` - Ejects from Create React App (one-way operation)# vercel_google_drive_files_to_clipboard
# react_google_drive_to_clipboard
# react_google_drive_to_clipboard


## Read a folder of Google Docs in the browser

Inside the app opened by `npm start` (usually `http://localhost:3000`), sign in
with Google and open **Terminal**. Navigate to a Drive folder and run:

```text
cd ~/Documents/reading
gdwatch
```

The current folder's Google Docs and text notes appear together below the shell
in a scrollable feed. The **Read folder notes** button in the shell header opens
the same view. **TXT>MD** is enabled by default and renders headings, emphasis, lists,
links, tables, quotes and code blocks across the feed. Toggle it off to read the
original text; the setting is remembered. The same **TXT>MD** toggle is also
beside **Sign Out** in the sticky bar and stays synchronized with the feed.
Use **A−** and **A+** there to resize every note (12–32 px); that size is remembered
across folders and page reloads and applies to both Markdown and plain text. **Copy text** always copies the original
note text, including Markdown syntax. `cd`, the explorer, breadcrumbs and the feed's subfolder buttons
all update the same folder. **Copy text** copies one note; **Refresh** fetches that
note's latest text. **Refresh folder** checks the listing for new or changed files.
Filename filtering keeps the current set of cards; other attachments open in Drive.
The reader loads cards as they approach the viewport, with at most two requests
at once. A failed note has its own retry; leaving the folder cancels pending reads.

```text
gdwatch status
gdwatch stop
```

This browser command uses the app's existing Google sign-in directly. It does not
call a local executable, rclone, or a separate reader server. The standalone Mac
terminal command of the same name is documented in [terminal_mount](terminal_mount/README.md).
Docs are fetched as text and displayed with Markdown formatting, up to 4 MiB per note. Use **Open in Google Docs** for
the full document formatting.

Verification:

```bash
CI=true npm test -- --watchAll=false --runInBand
npm run build
# Node 22+ and Chrome; uses simulated Google sign-in and API calls:
node scripts/check_drive_notes.cjs
```
