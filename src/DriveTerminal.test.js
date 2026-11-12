import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import DriveTerminal from './DriveTerminal';

const FOLDER = 'application/vnd.google-apps.folder';
const ROOT = [{ id: 'root', name: 'My Drive' }];
const folder = (id, name = id) => ({ id, name, mimeType: FOLDER });

let container;
let root;
let contents;
let denied;
let ensureFreshToken;
let openFile;

beforeEach(() => {
  localStorage.clear();
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  contents = {
    root: [folder('Documents'), folder('Other')],
    Documents: [folder('notes'), { id: 'readme', name: 'README.txt', mimeType: 'text/plain' }],
    notes: [folder('technical')],
    technical: [folder('codex')],
    codex: [],
    Other: [],
  };
  denied = new Set();
  ensureFreshToken = jest.fn(async () => 'test-token');
  openFile = jest.fn();
  global.fetch = jest.fn(async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/drive/v3/files/readme' && parsed.searchParams.get('alt') === 'media') {
      return { ok: true, text: async () => 'My reading notes' };
    }
    const query = parsed.searchParams.get('q');
    const id = query?.match(/^'([^']+)' in parents/)?.[1];
    if (id) {
      if (denied.has(id)) return { ok: false, json: async () => ({ error: { message: 'Folder unavailable' } }) };
      return { ok: true, status: 200, json: async () => ({ files: contents[id] || [] }) };
    }
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      const created = { id: 'new-folder', name: body.name, mimeType: body.mimeType };
      contents[body.parents[0]].push(created);
      return { ok: true, status: 200, json: async () => created };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete global.fetch;
});

const render = async (props = {}) => {
  await act(async () => {
    root.render(<DriveTerminal ensureFreshToken={ensureFreshToken} openFile={openFile} {...props} />);
  });
};
const click = async (element) => {
  expect(element).toBeTruthy();
  expect(element.disabled).toBe(false);
  await act(async () => element.click());
};
const button = (label) => container.querySelector(`button[aria-label="${label}"]`);
const crumb = (name) => [...container.querySelectorAll('.term-breadcrumb')].find((entry) => entry.textContent === name);
const entry = (name) => container.querySelector(`.drive-explorer-entry[title="Go to ${name}"]`);
const currentPath = () => JSON.parse(localStorage.getItem('driveTerminal.cwd'));
const recents = () => [...container.querySelectorAll('nav[aria-label="Recent folders"] button')];
const command = async (value) => {
  const input = container.querySelector('.term-input');
  await act(async () => Simulate.change(input, { target: { value } }));
  await act(async () => Simulate.keyDown(input, { key: 'Enter' }));
};

test('restores a deep path and makes each ancestor clickable', async () => {
  const saved = [...ROOT, folder('Documents'), folder('notes'), folder('technical'), folder('codex')];
  localStorage.setItem('driveTerminal.cwd', JSON.stringify(saved));
  await render();
  expect(container.querySelectorAll('.term-breadcrumb').length).toBe(5);
  expect(crumb('codex').getAttribute('aria-current')).toBe('page');
  await click(crumb('technical'));
  expect(currentPath().map((part) => part.name)).toEqual(['My Drive', 'Documents', 'notes', 'technical']);
  expect(entry('codex')).toBeTruthy();
  expect(container.querySelector('.term-body').textContent).toContain('cd ~/Documents/notes/technical');
});

test('shell cd, sidebar folders, file opening, and Up share the same directory', async () => {
  await render();
  await command('cd Documents');
  expect(crumb('Documents').getAttribute('aria-current')).toBe('page');
  await click(container.querySelector('.drive-explorer-entry[title="Open README.txt"]'));
  expect(openFile).toHaveBeenCalledWith('readme', 'README.txt', 'text/plain');
  await click(entry('notes'));
  expect(currentPath().map((part) => part.id)).toEqual(['root', 'Documents', 'notes']);
  await click(button('Up one folder'));
  expect(currentPath().map((part) => part.id)).toEqual(['root', 'Documents']);
  await click(crumb('My Drive'));
  expect(button('Up one folder').disabled).toBe(true);
});

test('clicking a folder in terminal output also updates the explorer', async () => {
  await render();
  await command('ls');
  const documents = [...container.querySelectorAll('.term-entry')].find((item) => item.textContent.includes('Documents'));
  await act(async () => documents.click());
  expect(crumb('Documents').getAttribute('aria-current')).toBe('page');
  expect(entry('notes')).toBeTruthy();
  expect(recents()[0].title).toBe('/My Drive');
});

test('Back and Forward follow visits and a new branch discards forward history', async () => {
  await render();
  expect(button('Back').disabled).toBe(true);
  await click(entry('Documents'));
  await click(entry('notes'));
  await click(button('Back'));
  expect(currentPath().at(-1).id).toBe('Documents');
  await click(button('Forward'));
  expect(currentPath().at(-1).id).toBe('notes');
  await click(button('Back'));
  await click(crumb('My Drive'));
  await click(entry('Other'));
  expect(button('Forward').disabled).toBe(true);
  await click(button('Back'));
  expect(currentPath()).toEqual(ROOT);
});

test('keeps the last five distinct previous folders, reorders revisits, and restores them', async () => {
  contents.root = Array.from({ length: 7 }, (_, index) => folder(`folder${index}`));
  await render();
  for (let index = 0; index < 7; index++) await command(`cd /folder${index}`);
  expect(recents().map((recent) => recent.title)).toEqual([
    '/My Drive/folder5', '/My Drive/folder4', '/My Drive/folder3', '/My Drive/folder2', '/My Drive/folder1',
  ]);
  await click(recents()[2]);
  expect(currentPath().at(-1).id).toBe('folder3');
  expect(recents().map((recent) => recent.title)).toEqual([
    '/My Drive/folder6', '/My Drive/folder5', '/My Drive/folder4', '/My Drive/folder2', '/My Drive/folder1',
  ]);
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(currentPath().at(-1).id).toBe('folder3');
  expect(recents()).toHaveLength(5);
  expect(recents()[0].title).toBe('/My Drive/folder6');
});

test('failed navigation preserves the current path and visit history', async () => {
  await render();
  denied.add('Documents');
  await click(entry('Documents'));
  expect(currentPath()).toEqual(ROOT);
  expect(button('Back').disabled).toBe(true);
  expect(recents()).toHaveLength(0);
  expect(container.querySelector('.term-err').textContent).toBe('Folder unavailable');
  denied.delete('Documents');
  await click(entry('Documents'));
  expect(currentPath().at(-1).id).toBe('Documents');
});

test('initial load errors offer refresh and terminal mutations refresh the sidebar', async () => {
  denied.add('root');
  await render();
  expect(container.querySelector('[role="alert"]').textContent).toBe('Folder unavailable');
  denied.clear();
  await click(button('Refresh folder'));
  expect(entry('Documents')).toBeTruthy();
  await command('mkdir "new notes"');
  expect(entry('new notes')).toBeTruthy();
  contents.root.push(folder('external-change'));
  await command('ls');
  expect(entry('external-change')).toBeTruthy();
});

test('sidebar navigates by ID when folder names are duplicated or contain slashes', async () => {
  contents.root = [folder('first', 'Notes'), folder('second', 'Notes'), folder('slash', 'ideas/drafts')];
  await render();
  await click(container.querySelectorAll('.drive-explorer-entry[title="Go to Notes"]')[1]);
  expect(currentPath().at(-1).id).toBe('second');
  await click(button('Back'));
  await click(entry('ideas/drafts'));
  expect(currentPath().at(-1)).toEqual({ id: 'slash', name: 'ideas/drafts' });
  await click(recents().find((recent) => recent.title === '/My Drive/Notes'));
  expect(currentPath().at(-1).id).toBe('second');
});

test('filters current contents, resets the filter on navigation, and remembers a hidden explorer', async () => {
  await render();
  const filter = container.querySelector('.drive-explorer-filter');
  await act(async () => Simulate.change(filter, { target: { value: 'Doc' } }));
  expect(entry('Other')).toBeNull();
  await click(entry('Documents'));
  expect(container.querySelector('.drive-explorer-filter').value).toBe('');
  expect(entry('notes')).toBeTruthy();
  await click(container.querySelector('.term-explorer-toggle'));
  expect(container.querySelector('.drive-explorer')).toBeNull();
  expect(localStorage.getItem('driveTerminal.explorer')).toBe('false');
  await command('cd notes');
  await click(container.querySelector('.term-explorer-toggle'));
  expect(entry('technical')).toBeTruthy();
});

test('hidden terminal waits until visible before loading the explorer', async () => {
  await render({ visible: false });
  expect(fetch).not.toHaveBeenCalled();
  await render({ visible: true });
  expect(entry('Documents')).toBeTruthy();
});


test('gdwatch opens the current folder feed inside the app, follows cd, and stops', async () => {
  await render();
  await command('cd Documents');
  expect(container.querySelector('.drive-notes')).toBeNull();
  await command('gdwatch');
  expect(container.querySelector('.drive-notes').textContent).toContain('Notes in Documents');
  expect(container.querySelector('.drive-note-body').textContent).toBe('My reading notes');
  expect(container.querySelector('.term-err')).toBeNull();
  await command('cd notes');
  expect(container.querySelector('.drive-notes').textContent).toContain('Notes in notes');
  expect(container.textContent).not.toContain('My reading notes');
  await command('gdwatch status');
  expect(container.querySelector('.term-body').textContent).toContain('Folder notes: open');
  await command('gdwatch stop');
  expect(container.querySelector('.drive-notes')).toBeNull();
  expect(container.querySelector('.term-body').textContent).toContain('Folder notes closed');
});

test('folder notes load with the explorer hidden and expose a button to open them', async () => {
  localStorage.setItem('driveTerminal.explorer', 'false');
  localStorage.setItem('driveTerminal.cwd', JSON.stringify([...ROOT, { id: 'Documents', name: 'Documents' }]));
  await render();
  expect(fetch).not.toHaveBeenCalled();
  const read = [...container.querySelectorAll('button')].find(node => node.textContent === 'Read folder notes');
  await click(read);
  expect(container.querySelector('.drive-note-body').textContent).toBe('My reading notes');
  expect(container.querySelector('.drive-explorer')).toBeNull();
  contents.Documents.push({ id: 'new-doc', name: 'New doc', mimeType: 'application/vnd.google-apps.document' });
  await click([...container.querySelectorAll('button')].find(node => node.textContent === 'Refresh folder'));
  expect(container.querySelector('[data-note-id="new-doc"]')).toBeTruthy();
});
