import React, { useEffect } from 'react';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { vim, Vim } from '@replit/codemirror-vim';

// Vim-mode editor for the file modal. :w saves, :q closes the editor (:q! discards), :wq does both.
// Ex commands are global to the vim package, so they call whatever the mounted editor last registered.
const handlers = { save: async () => {}, quit: () => {}, dirty: () => false };

Vim.defineEx('write', 'w', () => { handlers.save(); });
Vim.defineEx('quit', 'q', (cm, params) => {
  if (handlers.dirty() && !params.argString?.includes('!') && params.input !== 'q!') {
    handlers.error('No write since last change (add ! to override)');
    return;
  }
  handlers.quit();
});
Vim.defineEx('wq', 'wq', async () => { await handlers.save(); handlers.quit(); });
Vim.defineEx('xit', 'x', async () => { await handlers.save(); handlers.quit(); });

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--dt-text, #eee)', backgroundColor: 'var(--dt-modal-bg, #0f0f23)' },
  '.cm-content': { caretColor: 'var(--dt-text, #eee)', padding: '15px' },
  '.cm-scroller': { fontFamily: 'monospace', lineHeight: '1.5' },
  '.cm-gutters': { display: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--dt-text, #eee)' },
  '.cm-fat-cursor': { background: '#ba68c8 !important', color: '#000 !important' },
  '&:not(.cm-focused) .cm-fat-cursor': { outline: '1px solid #ba68c8', background: 'transparent !important' },
  '.cm-panels': { backgroundColor: 'var(--dt-modal-bg, #0f0f23)', color: 'var(--dt-text, #eee)' },
  '.cm-vim-panel': { fontFamily: 'monospace' },
  '.cm-vim-panel input': { color: 'inherit', background: 'transparent', outline: 'none', border: 'none' },
});

const VimEditor = ({ value, onChange, fontSize, onSave, onQuit, isDirty, onError }) => {
  useEffect(() => {
    handlers.save = onSave;
    handlers.quit = onQuit;
    handlers.dirty = isDirty;
    handlers.error = onError;
  });

  return (
    <div className="edit-textarea vim-editor" style={{ fontSize: `${fontSize}px` }}>
      <CodeMirror
        value={value}
        height="100%"
        autoFocus
        basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
        extensions={[vim(), EditorView.lineWrapping, theme]}
        onChange={onChange}
        style={{ height: '100%' }}
      />
    </div>
  );
};

export default VimEditor;
