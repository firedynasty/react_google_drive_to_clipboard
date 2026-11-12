import React, { useState } from 'react';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const fullPath = (stack) => '/' + stack.map((folder) => folder.name).join('/');

const fileIcon = (mimeType) => {
  if (mimeType === FOLDER_MIME) return '📁';
  if (mimeType === 'application/vnd.google-apps.document') return '📄';
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return '📊';
  return '📎';
};

export default function DriveExplorer({ cwd, recentFolders, listing, busy, onNavigate, onOpen, onOpenInWindow, onRefresh }) {
  const [filter, setFilter] = useState('');
  const folder = cwd[cwd.length - 1];
  const currentListing = listing.id === folder.id;
  const entries = currentListing ? listing.files : [];
  const matches = entries.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <aside id="drive-explorer" className="drive-explorer" aria-label="Drive explorer">
      <div className="drive-explorer-section">
        <h3>Recent folders <span>Last 5</span></h3>
        {recentFolders.length === 0 && <p className="drive-explorer-status">Folders you visit will appear here.</p>}
        <nav aria-label="Recent folders">
          {recentFolders.map((stack) => {
            const recent = stack[stack.length - 1];
            return (
              <button
                type="button"
                key={recent.id}
                className="drive-explorer-entry drive-explorer-recent"
                title={fullPath(stack)}
                disabled={busy}
                onClick={() => onNavigate(stack)}
              >
                <span aria-hidden="true">📁</span>
                <span className="drive-explorer-name">
                  <span>{recent.name}</span>
                  <small>{stack.length > 1 ? fullPath(stack.slice(0, -1)) : '/'}</small>
                </span>
              </button>
            );
          })}
        </nav>
      </div>
      <div className="drive-explorer-section">
        <div className="drive-explorer-heading">
          <h3 title={fullPath(cwd)}>In {folder.name}</h3>
          <button type="button" className="term-nav-button" onClick={onRefresh} disabled={busy || listing.loading} aria-label="Refresh folder" title="Refresh folder">↻</button>
        </div>
        <input
          type="search"
          className="drive-explorer-filter"
          aria-label="Filter current folder"
          placeholder="Filter this folder…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="drive-explorer-files" aria-busy={!currentListing || listing.loading}>
          {(!currentListing || listing.loading) && <p className="drive-explorer-status" role="status">Loading folder…</p>}
          {currentListing && listing.error && <p className="drive-explorer-status term-err" role="alert">{listing.error}</p>}
          {currentListing && !listing.loading && !listing.error && matches.length === 0 && (
            <p className="drive-explorer-status">{entries.length ? 'No matching files or folders.' : 'This folder is empty.'}</p>
          )}
          {matches.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className="drive-explorer-entry"
              title={`${entry.mimeType === FOLDER_MIME ? 'Go to' : 'Open'} ${entry.name}`}
              disabled={busy || listing.loading}
              onClick={() => entry.mimeType === FOLDER_MIME ? onNavigate([...cwd, { id: entry.id, name: entry.name }]) : onOpen(entry)}
              onContextMenu={(event) => onOpenInWindow(event, entry)}
            >
              <span aria-hidden="true">{fileIcon(entry.mimeType)}</span>
              <span className="drive-explorer-name">{entry.name}{entry.mimeType === FOLDER_MIME ? '/' : ''}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
