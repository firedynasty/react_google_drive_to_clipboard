import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import DriveNotesFeed from './DriveNotesFeed';
import { DOC_MIME, FOLDER_MIME, fetchDriveNote } from './driveNotes';

const file = (id, name = id) => ({ id, name, mimeType: DOC_MIME });
let root, container, ensureFreshToken, text, failures, observers;
const props = () => ({ folder: { id: 'reading', name: 'reading' }, path: '~/Documents/reading', files: [file('one', 'Fractions'), file('two', 'More fractions')], ensureFreshToken, onRefresh: jest.fn(), onNavigate: jest.fn() });
const render = async (overrides = {}, key = 'reading') => {
  await act(async () => root.render(<DriveNotesFeed key={key} {...props()} {...overrides} />));
};
const card = id => container.querySelector(`[data-note-id="${id}"]`);
const click = async element => { expect(element.disabled).toBe(false); await act(async () => element.click()); };

beforeEach(() => {
  localStorage.clear();
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  ensureFreshToken = jest.fn(async () => 'fresh-token');
  text = { one: '\uFEFF1/2 + 1/3 = 5/6\r\n', two: 'Another note\n<script>window.bad = true</script>' };
  failures = new Set(); observers = [];
  global.fetch = jest.fn(async (url, options) => {
    const id = new URL(url).pathname.split('/')[4];
    expect(options.headers.Authorization).toBe('Bearer fresh-token');
    if (failures.has(id)) return { ok: false, status: 403, json: async () => ({ error: { message: 'Access denied' } }) };
    return { ok: true, headers: new Headers(), text: async () => text[id] || '' };
  });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn(async () => {}) } });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  delete global.fetch; delete global.IntersectionObserver;
});

test('shows notes together without clicking, copies exact text, and treats document HTML as text', async () => {
  await render();
  expect(card('one').querySelector('.drive-note-body').textContent).toBe('1/2 + 1/3 = 5/6');
  expect(card('two').querySelector('.drive-note-body').textContent).toContain('<script>');
  expect(container.querySelector('script')).toBeNull();
  await click(card('one').querySelector('.drive-note-copy'));
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('1/2 + 1/3 = 5/6\n');
  expect(card('one').textContent).toContain('Copied');
});

test('refreshes one card, isolates errors, and retries without refetching other notes', async () => {
  failures.add('one');
  await render();
  expect(card('one').querySelector('[role="alert"]').textContent).toContain('Access denied');
  expect(card('two').querySelector('.drive-note-body').textContent).toContain('Another note');
  failures.clear(); text.one = 'Updated note';
  await click(card('one').querySelector('[aria-label="Refresh Fractions"]'));
  expect(card('one').querySelector('.drive-note-body').textContent).toBe('Updated note');
  expect(fetch.mock.calls.filter(([url]) => url.includes('/two/'))).toHaveLength(1);
});

test('lazy loads near the viewport, filters filenames, and lists subfolders and attachments', async () => {
  global.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(node) { this.node = node; }
    disconnect() {}
  };
  const onNavigate = jest.fn();
  const subfolder = { id: 'history', name: 'History', mimeType: FOLDER_MIME };
  await render({ files: [file('one', 'Fractions'), file('two', 'Fractions'), subfolder, { id: 'sheet', name: 'Numbers', mimeType: 'application/vnd.google-apps.spreadsheet' }], onNavigate });
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => observers[0].callback([{ isIntersecting: true }]));
  expect(card('one').querySelector('.drive-note-body')).toBeTruthy();
  expect(card('two').querySelector('.drive-note-body')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll('.drive-note')).toHaveLength(2);
  expect(container.querySelector('.drive-notes-other a').href).toContain('/sheet/view');
  await click(container.querySelector('.drive-notes-folders button'));
  expect(onNavigate).toHaveBeenCalledWith(subfolder);
  await act(async () => Simulate.change(container.querySelector('input'), { target: { value: 'absent' } }));
  expect(card('one').hidden).toBe(true);
  expect(container.textContent).toContain('No notes match');
});

test('aborts old-folder requests and ignores late responses after navigating', async () => {
  let finish;
  fetch.mockImplementationOnce((url, options) => new Promise(resolve => { finish = () => resolve({ ok: true, text: async () => 'OLD FOLDER TEXT' }); }));
  await render({ files: [file('one')] });
  const signal = fetch.mock.calls[0][1].signal;
  text.two = 'New folder note';
  await render({ folder: { id: 'new', name: 'New folder' }, files: [file('two')] }, 'new');
  expect(signal.aborted).toBe(true);
  await act(async () => finish());
  expect(container.textContent).not.toContain('OLD FOLDER TEXT');
  expect(card('two').querySelector('.drive-note-body').textContent).toBe('New folder note');
});

test('uses media download for text notes and rejects oversized notes before downloading', async () => {
  await fetchDriveNote({ id: 'one', name: 'notes.md', mimeType: 'text/markdown' }, ensureFreshToken, new AbortController().signal);
  expect(fetch.mock.calls[0][0]).toContain('/one?alt=media');
  fetch.mockClear();
  await expect(fetchDriveNote({ id: 'huge', name: 'large.txt', mimeType: 'text/plain', size: '5000000' }, ensureFreshToken)).rejects.toThrow('larger than 4 MiB');
  expect(fetch).not.toHaveBeenCalled();
});


test('Markdown is applied by default, the TXT>MD toggle affects all notes, and copying keeps the source', async () => {
  text.one = '# Fractions\n\nA **bold** idea and *emphasis*.\n\n- First\n- Second\n\n[Practice](https://example.com/practice)\n\n```text\n1/2 + 1/3\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |';
  text.two = '## Second note';
  await render();
  const toggle = container.querySelector('.txt-md-toggle-btn');
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(card('one').querySelector('h1').textContent).toBe('Fractions');
  expect(card('one').querySelector('strong').textContent).toBe('bold');
  expect(card('one').querySelectorAll('li')).toHaveLength(2);
  expect(card('one').querySelector('pre code').textContent).toContain('1/2 + 1/3');
  expect(card('one').querySelector('table')).toBeTruthy();
  const link = card('one').querySelector('.drive-note-body a');
  expect(link.href).toBe('https://example.com/practice');
  expect(link.rel).toBe('noopener noreferrer');
  const requests = fetch.mock.calls.length;
  await click(card('one').querySelector('.drive-note-copy'));
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(text.one);
  await click(toggle);
  expect(card('one').querySelector('pre.drive-note-body').textContent).toBe(text.one);
  expect(card('two').querySelector('pre.drive-note-body').textContent).toBe('## Second note');
  expect(fetch).toHaveBeenCalledTimes(requests);
  expect(localStorage.getItem('driveTerminal.notesMarkdown')).toBe('0');
  await render({}, 'other-folder');
  expect(container.querySelector('.txt-md-toggle-btn').getAttribute('aria-pressed')).toBe('false');
  await click(container.querySelector('.txt-md-toggle-btn'));
  expect(card('one').querySelector('h1')).toBeTruthy();
});

test('formatted notes escape HTML and reject script links', async () => {
  text.one = '<img src=x onerror="window.bad=true">\n\n<script>window.bad=true</script>\n\n[Bad](javascript:alert(1))';
  await render();
  const body = card('one').querySelector('.drive-note-body');
  expect(body.querySelector('img,script,[onerror]')).toBeNull();
  expect(body.querySelector('a')).toBeNull();
  expect(body.textContent).toContain('<script>');
});
