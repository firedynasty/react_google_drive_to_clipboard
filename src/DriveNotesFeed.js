import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createNoteLoader, DOC_MIME, FOLDER_MIME, isDriveNote, originalUrl } from './driveNotes';
import { useNoteReadingPreferences } from './NoteReadingControls';
import './DriveNotesFeed.css';

const NoteMarkdown = lazy(() => import('./NoteMarkdown'));

function NoteCard({ file, shown, loadNote, formatted }) {
  const ref = useRef(null);
  const [near, setNear] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { id, name, mimeType, size } = file;

  useEffect(() => {
    if (!shown || near) return;
    if (!window.IntersectionObserver) { setNear(true); return; }
    const observer = new IntersectionObserver((changes) => {
      if (changes.some(change => change.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: '400px 0px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near, shown]);

  useEffect(() => {
    if (!near) return;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true); setError(''); setNotice('');
    loadNote({ id, name, mimeType, size }, controller.signal).then(
      data => { if (!cancelled) setResult(data); },
      failure => { if (!cancelled && failure.name !== 'AbortError') setError(failure.message); }
    ).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; controller.abort(); };
  }, [id, name, mimeType, size, loadNote, near, attempt]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(result.text); setNotice('Copied'); }
    catch { setNotice('Select the note text and copy it with your keyboard.'); }
  };

  return (
    <article className="drive-note" data-note-id={id} hidden={!shown} ref={ref} aria-busy={loading}>
      <div className="drive-note-heading">
        <div><h3>{name}</h3><span>{mimeType === DOC_MIME ? 'Google Doc' : 'Text note'}</span></div>
        <div className="drive-note-actions">
          <button type="button" className="drive-note-copy" disabled={!result} onClick={copy}>Copy text</button>
          <button type="button" disabled={loading || !near} onClick={() => setAttempt(value => value + 1)} aria-label={`Refresh ${name}`}>Refresh</button>
          <a href={originalUrl(file)} target="_blank" rel="noopener noreferrer">{mimeType === DOC_MIME ? 'Open in Google Docs ↗' : 'Open original ↗'}</a>
        </div>
      </div>
      {result && (formatted ? <Suspense fallback={<pre className="drive-note-body">{result.text || '(Empty note)'}</pre>}><NoteMarkdown text={result.text || '(Empty note)'} /></Suspense> : <pre className="drive-note-body">{result.text || '(Empty note)'}</pre>)}
      {!result && !error && <p className="drive-note-status">{loading ? 'Loading note…' : 'Loads as you scroll…'}</p>}
      {error && <p className="drive-note-status drive-note-error" role="alert">{error} Use Refresh to try again.</p>}
      <div className="drive-note-footer">
        <span role="status">{notice || (loading ? 'Loading…' : result ? `${result.text.length.toLocaleString()} characters · Fetched ${new Date(result.fetchedAt).toLocaleTimeString()}` : 'Read only')}</span>
      </div>
    </article>
  );
}

function NotesFeed({ folder, path, files, loading, error, ensureFreshToken, onRefresh, onNavigate, readingPreferences }) {
  const [filter, setFilter] = useState('');
  const { formatted, setFormatted, fontSize } = readingPreferences;
  const loader = useMemo(() => createNoteLoader(), []);
  const tokenRef = useRef(ensureFreshToken);
  tokenRef.current = ensureFreshToken;
  const loadNote = useCallback((file, signal) => loader(file, () => tokenRef.current(), signal), [loader]);
  const notes = files.filter(isDriveNote);
  const folders = files.filter(file => file.mimeType === FOLDER_MIME);
  const other = files.filter(file => file.mimeType !== FOLDER_MIME && !isDriveNote(file));
  const match = file => file.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase());
  const matches = notes.filter(match).length;

  return (
    <section className="drive-notes" aria-label="Folder notes" aria-busy={loading} style={{ '--drive-note-font-size': `${fontSize}px` }}>
      <div className="drive-notes-heading">
        <div><h2>Notes in {folder.name}</h2><p>{path}</p></div>
        <div className="drive-notes-heading-actions">
          <button type="button" className={`txt-md-toggle-btn${formatted ? ' active' : ''}`} aria-pressed={formatted} onClick={() => setFormatted(value => !value)} title="Toggle Markdown formatting for all notes">TXT&gt;MD</button>
          <button type="button" disabled={loading} onClick={onRefresh}>Refresh folder</button>
        </div>
      </div>
      <div className="drive-notes-tools">
        <input type="search" aria-label="Filter notes by filename" placeholder="Filter notes by filename…" value={filter} onChange={event => setFilter(event.target.value)} />
        <span>{matches} {matches === 1 ? 'note' : 'notes'}</span>
      </div>
      <p className="drive-notes-hint">Scroll to read this folder’s notes together. The feed follows the Drive shell as you cd.</p>
      {folders.length > 0 && <nav className="drive-notes-folders" aria-label="Subfolders">{folders.filter(match).map(file => <button type="button" key={file.id} onClick={() => onNavigate(file)}>📁 {file.name}</button>)}</nav>}
      {loading && <p className="drive-note-status" role="status">Loading folder…</p>}
      {error && <p className="drive-note-status drive-note-error" role="alert">{error} Try Refresh folder.</p>}
      {!loading && !error && !matches && <p className="drive-note-status">{notes.length ? 'No notes match this filter.' : 'No Google Docs or text notes in this folder. Choose a subfolder above to keep browsing.'}</p>}
      <div className="drive-notes-cards">
        {notes.map(file => <NoteCard key={`${file.id}:${file.modifiedTime || ''}:${file.size || ''}`} file={file} shown={match(file)} loadNote={loadNote} formatted={formatted} />)}
      </div>
      {other.length > 0 && <details className="drive-notes-other"><summary>Other files ({other.length})</summary>{other.filter(match).map(file => <a key={file.id} href={originalUrl(file)} target="_blank" rel="noopener noreferrer">{file.name} ↗</a>)}</details>}
      <p className="drive-notes-hint">Read only · TXT&gt;MD toggles Markdown formatting. Refresh a note to fetch later edits.</p>
    </section>
  );
}

// The app owns shared preferences; the standalone feed also works in isolation.
function StandaloneNotesFeed(props) {
  const readingPreferences = useNoteReadingPreferences();
  return <NotesFeed {...props} readingPreferences={readingPreferences} />;
}

export default function DriveNotesFeed(props) {
  return props.readingPreferences ? <NotesFeed {...props} /> : <StandaloneNotesFeed {...props} />;
}
