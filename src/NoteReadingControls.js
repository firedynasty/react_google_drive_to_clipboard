import React, { useEffect, useState } from 'react';
import './NoteReadingControls.css';

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 32;
const clampFontSize = size => Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));

export function useNoteReadingPreferences() {
  const [formatted, setFormatted] = useState(() => {
    try { return localStorage.getItem('driveTerminal.notesMarkdown') !== '0'; } catch { return true; }
  });
  const [fontSize, setFontSize] = useState(() => {
    try {
      const saved = parseInt(localStorage.getItem('driveTerminal.notesFontSize'), 10);
      return Number.isFinite(saved) ? clampFontSize(saved) : 17;
    } catch { return 17; }
  });
  useEffect(() => {
    try { localStorage.setItem('driveTerminal.notesMarkdown', formatted ? '1' : '0'); } catch { /* storage unavailable */ }
  }, [formatted]);
  useEffect(() => {
    try { localStorage.setItem('driveTerminal.notesFontSize', String(fontSize)); } catch { /* storage unavailable */ }
  }, [fontSize]);
  return { formatted, setFormatted, fontSize, adjustFontSize: amount => setFontSize(size => clampFontSize(size + amount)) };
}

export default function NoteReadingControls({ preferences }) {
  const { formatted, setFormatted, fontSize, adjustFontSize } = preferences;
  return (
    <div className="note-reading-controls" role="group" aria-label="Note reading controls">
      <button type="button" className={`txt-md-toggle-btn${formatted ? ' active' : ''}`} aria-pressed={formatted} onClick={() => setFormatted(value => !value)} title="Toggle Markdown formatting for all notes">TXT&gt;MD</button>
      <button type="button" disabled={fontSize <= MIN_FONT_SIZE} onClick={() => adjustFontSize(-1)} aria-label="Decrease note font size" title="Smaller note text">A−</button>
      <output aria-label="Note font size">{fontSize}px</output>
      <button type="button" disabled={fontSize >= MAX_FONT_SIZE} onClick={() => adjustFontSize(1)} aria-label="Increase note font size" title="Larger note text">A+</button>
    </div>
  );
}
