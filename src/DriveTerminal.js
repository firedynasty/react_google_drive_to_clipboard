import React, { useState, useEffect, useRef, useCallback } from 'react';

// Bash-style shell over the Google Drive API: cd / ls / mv / rm / mkdir / open / recent / find.
// The current folder and command history persist in localStorage so the shell "stays" where you left it.

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const DOC_MIME = 'application/vnd.google-apps.document';
const ROOT = [{ id: 'root', name: 'My Drive' }];
const CWD_KEY = 'driveTerminal.cwd';
const HISTORY_KEY = 'driveTerminal.history';
const ALIAS_KEY = 'driveTerminal.aliases';
// Starting "~/.zshrc" — edit with alias / unalias, saved per browser.
const DEFAULT_ALIASES = {
  dir: 'ls',
  ll: 'ls -l',
  la: 'ls',
  l: 'ls',
  cat: 'open',
  opens: "open -a 'google chrome'",
  '..': 'cd ..',
};

const HELP = [
  'ls [-l] [path]        list folder (click an entry to cd/open it)',
  'cd [path]             change folder  ( ..  /  ~  a/b  "name with spaces" )',
  'pwd                   print current path',
  'open <name|#>         load a file into the viewer',
  'open -a chrome <name> open in a new browser tab (Docs/Sheets editor); also: web <name>',
  'web                   open the current folder in Google Drive',
  'which <name|#>        print full path + link   ( which notes | pbcopy )',
  'mv <src...> <dest>    move into folder dest, or rename a single src',
  'cp <src> [dest]       copy a file (Drive copy) into a folder or as a new name',
  'rm <name...>          move to Drive trash (recoverable)',
  'mkdir <name>          create a folder',
  'recent                10 most recently viewed Docs/Sheets (numbered)',
  'find <text>           search all of Drive by name (numbered)',
  'echo <text>           print text',
  'clear                 clear the screen (also Ctrl+L)',
  '',
  'alias                 list aliases (your ~/.zshrc)',
  "alias name='cmd'      add an alias, e.g. alias docs='cd Documents'",
  'unalias <name>        remove an alias',
  '',
  'Pipes:  cmd | pbcopy    cmd | grep [-i|-v] text    cmd | head [-n N]    cmd | wc -l',
  '        e.g.  pwd | pbcopy     dir | grep -i chess | pbcopy',
  '',
  'Tab completes names, ↑/↓ walk history, # refers to the last recent/find list.',
];

const loadJSON = (key, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const saveJSON = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
};

// Split a command line into tokens, honouring "double", 'single' quotes and backslash escapes.
// Returns tokens plus the raw start index of the last token (for tab completion).
const tokenize = (line) => {
  const tokens = [];
  let cur = '';
  let inToken = false;
  let quote = null;
  let lastStart = line.length;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      if (!inToken) { inToken = true; lastStart = i; }
      quote = c;
    } else if (c === '\\' && i + 1 < line.length) {
      if (!inToken) { inToken = true; lastStart = i; }
      cur += line[++i];
    } else if (/\s/.test(c)) {
      if (inToken) { tokens.push(cur); cur = ''; inToken = false; }
    } else {
      if (!inToken) { inToken = true; lastStart = i; }
      cur += c;
    }
  }
  if (inToken) tokens.push(cur);
  const endsWithSpace = !inToken;
  return { tokens, lastStart: endsWithSpace ? line.length : lastStart, endsWithSpace };
};

// Split on | that isn't inside quotes or escaped.
const splitPipes = (line) => {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) { cur += c + line[++i]; continue; }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += c + line[++i];
      continue;
    } else if (c === '|') {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur.trim());
  return parts;
};

const quoteArg =(s) => (/[\s"'\\]/.test(s) ? `"${s.replace(/(["\\])/g, '\\$1')}"` : s);

const iconFor = (mimeType) => {
  if (mimeType === FOLDER_MIME) return '📁';
  if (mimeType === SHEET_MIME) return '📊';
  if (mimeType === DOC_MIME) return '📄';
  return '📎';
};

const driveUrl = (f) => {
  if (f.mimeType === FOLDER_MIME) {
    return f.id === 'root' ? 'https://drive.google.com/drive/my-drive' : `https://drive.google.com/drive/folders/${f.id}`;
  }
  if (f.mimeType === DOC_MIME) return `https://docs.google.com/document/d/${f.id}/edit`;
  if (f.mimeType === SHEET_MIME) return `https://docs.google.com/spreadsheets/d/${f.id}/edit`;
  if (f.mimeType === 'application/vnd.google-apps.presentation') return `https://docs.google.com/presentation/d/${f.id}/edit`;
  return `https://drive.google.com/file/d/${f.id}/view`;
};

const pathString = (cwd) => (cwd.length === 1 ? '~' : '~/' + cwd.slice(1).map((c) => c.name).join('/'));

const DriveTerminal = ({ ensureFreshToken, openFile, onClose, visible = true, modalOpen = false }) => {
  const [cwd, setCwd] = useState(() => loadJSON(CWD_KEY, ROOT));
  const [lines, setLines] = useState([{ type: 'out', text: 'Drive shell — type "help" for commands.' }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const historyRef = useRef(loadJSON(HISTORY_KEY, []));
  const historyIdxRef = useRef(-1);
  const cacheRef = useRef(new Map()); // folderId -> entries
  const numberedRef = useRef([]); // last recent/find list, for "open 3"
  const inputRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => { saveJSON(CWD_KEY, cwd); }, [cwd]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);
  // Grab focus when shown, and again when the file modal closes (e.g. Escape) so typing resumes here.
  useEffect(() => {
    if (visible && !modalOpen) inputRef.current?.focus({ preventScroll: true });
  }, [visible, modalOpen]);

  // Saved aliases layer over the defaults (so new defaults appear); unalias stores null to hide a default.
  const [aliasState, setAliases] = useState(() => ({ ...DEFAULT_ALIASES, ...loadJSON(ALIAS_KEY, {}) }));
  useEffect(() => { saveJSON(ALIAS_KEY, aliasState); }, [aliasState]);
  const aliases = Object.fromEntries(Object.entries(aliasState).filter(([, v]) => v !== null));

  // While a pipeline runs, stdout goes into captureRef as { text, file? } items instead of the screen.
  const captureRef = useRef(null);

  const print = useCallback((type, text, extra) => {
    if (captureRef.current && type !== 'err' && type !== 'cmd') {
      if (type === 'grid') {
        extra.files.forEach((f) => captureRef.current.push({ text: '', file: f }));
      } else if (type === 'link') {
        captureRef.current.push({ text: extra.url });
      } else {
        captureRef.current.push({ text, file: extra?.file });
      }
      return;
    }
    setLines((prev) => [...prev, { type, text, ...extra }]);
  }, []);

  const api = useCallback(async (url, options = {}) => {
    const token = await ensureFreshToken();
    const res = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  }, [ensureFreshToken]);

  const listFolder = useCallback(async (folderId, { fresh = false } = {}) => {
    if (!fresh && cacheRef.current.has(folderId)) return cacheRef.current.get(folderId);
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    let files = [];
    let pageToken = '';
    do {
      const data = await api(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size)&orderBy=folder,name&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      );
      files = files.concat(data.files || []);
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    cacheRef.current.set(folderId, files);
    return files;
  }, [api]);

  const invalidate = (...folderIds) => folderIds.forEach((id) => cacheRef.current.delete(id));

  const findChild = (entries, name) =>
    entries.find((e) => e.name === name) || entries.find((e) => e.name.toLowerCase() === name.toLowerCase());

  // Resolve a path to { stack, entry } where stack is the folder chain containing entry.
  // For folders, entry is the folder itself; stack then ends at its parent.
  const resolve = useCallback(async (path, base = cwd) => {
    if (/^#\d+$/.test(path)) {
      const f = numberedRef.current[parseInt(path.slice(1), 10) - 1];
      if (!f) throw new Error(`${path}: no such entry in the last recent/find list`);
      return { stack: null, entry: f };
    }
    let stack = path.startsWith('/') || path === '~' || path.startsWith('~/') ? [...ROOT] : [...base];
    const parts = path.replace(/^~/, '').split('/').filter((p) => p && p !== '.');
    if (parts.length === 0) return { stack: stack.slice(0, -1), entry: { ...stack[stack.length - 1], mimeType: FOLDER_MIME } };
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '..') {
        if (stack.length > 1) stack.pop();
        if (i === parts.length - 1) {
          return { stack: stack.slice(0, -1), entry: { ...stack[stack.length - 1], mimeType: FOLDER_MIME } };
        }
        continue;
      }
      const dir = stack[stack.length - 1];
      const entries = await listFolder(dir.id);
      const child = findChild(entries, part);
      if (!child) throw new Error(`${path}: No such file or folder`);
      if (i === parts.length - 1) return { stack, entry: child };
      if (child.mimeType !== FOLDER_MIME) throw new Error(`${path}: Not a folder`);
      stack = [...stack, { id: child.id, name: child.name }];
    }
    return null;
  }, [cwd, listFolder]);

  // Full path for an item found by id (recent/find results): walk up its parents to My Drive.
  const pathFromParents = async (entry) => {
    const names = [entry.name];
    let parentId = entry.parents?.[0];
    for (let depth = 0; parentId && depth < 30; depth++) {
      const p = await api(`https://www.googleapis.com/drive/v3/files/${parentId}?fields=id,name,parents`);
      names.unshift(p.name); // the top folder comes back as "My Drive"
      parentId = p.parents?.[0];
    }
    return '/' + names.join('/');
  };

  // For open/web: a bare number means "#N from the last list" unless something here is named that.
  const resolveTarget = async (arg) => {
    try {
      return await resolve(arg);
    } catch (e) {
      if (/^\d+$/.test(arg) && numberedRef.current.length) return resolve('#' + arg);
      throw e;
    }
  };

  const printListing = (entries, long) => {
    if (entries.length === 0) { print('out', '(empty)'); return; }
    if (long) {
      entries.forEach((f) => {
        const date = f.modifiedTime ? f.modifiedTime.slice(0, 16).replace('T', ' ') : '';
        const size = f.size ? `${Math.max(1, Math.round(f.size / 1024))}K` : '-';
        print('entry', `${date}  ${size.padStart(7)}  `, { file: f });
      });
    } else {
      print('grid', '', { files: entries });
    }
  };

  const printNumbered = (files) => {
    numberedRef.current = files;
    if (files.length === 0) { print('out', '(no results)'); return; }
    files.forEach((f, i) => print('entry', `${String(i + 1).padStart(2)}  `, { file: f }));
  };

  const commands = {
    help: async () => HELP.forEach((l) => print('out', l)),
    clear: async () => setLines([]),
    pwd: async () => print('out', '/' + cwd.map((c) => c.name).join('/')),

    ls: async (args) => {
      const long = args.includes('-l');
      const paths = args.filter((a) => a !== '-l');
      if (paths.length === 0) {
        printListing(await listFolder(cwd[cwd.length - 1].id, { fresh: true }), long);
        return;
      }
      for (const p of paths) {
        const { entry } = await resolve(p);
        if (entry.mimeType === FOLDER_MIME) {
          if (paths.length > 1) print('out', `${p}:`);
          printListing(await listFolder(entry.id, { fresh: true }), long);
        } else {
          printListing([entry], long);
        }
      }
    },

    cd: async (args) => {
      const target = args[0];
      if (!target || target === '~' || target === '/') { setCwd(ROOT); return; }
      const { stack, entry } = await resolve(target);
      if (entry.mimeType !== FOLDER_MIME) throw new Error(`cd: ${target}: Not a folder`);
      if (!stack) throw new Error('cd: numbered results are not folder paths — use the folder name');
      setCwd([...stack, { id: entry.id, name: entry.name }]);
    },

    open: async (args) => {
      // macOS style: open -a "Google Chrome" <name>  → new browser tab (any app name works)
      if (args[0] === '-a') return commands.web(args.slice(2));
      if (!args[0]) throw new Error('usage: open <name|#>   or   open -a chrome <name>');
      const { stack, entry } = await resolveTarget(args[0]);
      if (entry.mimeType === FOLDER_MIME) {
        if (stack) setCwd([...stack, { id: entry.id, name: entry.name }]);
        else window.open(driveUrl(entry), '_blank', 'noopener');
        return;
      }
      print('out', `Opening ${entry.name}...`);
      openFile(entry.id, entry.name, entry.mimeType);
    },

    web: async (args) => {
      // No name → the current folder in Drive.
      const { entry } = args[0]
        ? await resolveTarget(args[0])
        : { entry: { ...cwd[cwd.length - 1], mimeType: FOLDER_MIME } };
      const url = driveUrl(entry);
      window.open(url, '_blank', 'noopener');
      print('link', `→ ${entry.name}  `, { url }); // clickable fallback if the popup was blocked
    },

    which: async (args) => {
      if (!args[0]) throw new Error('usage: which <name|#>');
      for (const a of args) {
        const { stack, entry } = await resolveTarget(a);
        const path = stack
          ? '/' + [...stack.map((s) => s.name), entry.name].join('/')
          : await pathFromParents(entry);
        print('out', path + (entry.mimeType === FOLDER_MIME ? '/' : ''));
        print('link', '', { url: driveUrl(entry) });
      }
    },

    mkdir: async (args) => {
      if (!args[0]) throw new Error('usage: mkdir <name>');
      for (const name of args) {
        const parent = cwd[cwd.length - 1];
        await api('https://www.googleapis.com/drive/v3/files?fields=id,name', {
          method: 'POST',
          body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent.id] }),
        });
        invalidate(parent.id);
        print('out', `created ${name}/`);
      }
    },

    rm: async (args) => {
      const names = args.filter((a) => a !== '-r' && a !== '-rf' && a !== '-f');
      if (names.length === 0) throw new Error('usage: rm <name...>');
      for (const name of names) {
        const { stack, entry } = await resolve(name);
        await api(`https://www.googleapis.com/drive/v3/files/${entry.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ trashed: true }),
        });
        if (stack) invalidate(stack[stack.length - 1].id);
        print('out', `trashed ${entry.name}`);
      }
    },

    mv: async (args) => {
      if (args.length < 2) throw new Error('usage: mv <src...> <dest>');
      const destPath = args[args.length - 1];
      const sources = args.slice(0, -1);
      let destFolder = null;
      try {
        const { entry } = await resolve(destPath);
        if (entry.mimeType === FOLDER_MIME) destFolder = entry;
        else throw new Error(`mv: ${destPath} already exists`);
      } catch (e) {
        if (!/No such file/.test(e.message)) throw e;
      }

      if (destFolder) {
        for (const src of sources) {
          const { stack, entry } = await resolve(src);
          const fromId = entry.parents?.[0] || stack?.[stack.length - 1].id;
          if (!fromId) throw new Error(`mv: ${src}: use the name, not a # from a list`);
          await api(
            `https://www.googleapis.com/drive/v3/files/${entry.id}?addParents=${destFolder.id}&removeParents=${fromId}&fields=id`,
            { method: 'PATCH', body: '{}' }
          );
          invalidate(fromId, destFolder.id);
          print('out', `${entry.name} → ${destFolder.name}/`);
        }
        return;
      }

      // Destination doesn't exist: rename (and possibly move) a single source.
      if (sources.length > 1) throw new Error(`mv: ${destPath}: No such folder`);
      const { stack, entry } = await resolve(sources[0]);
      const slash = destPath.lastIndexOf('/');
      const newName = destPath.slice(slash + 1);
      const fromId = stack?.[stack.length - 1].id || entry.parents?.[0];
      let url = `https://www.googleapis.com/drive/v3/files/${entry.id}?fields=id`;
      let toId = fromId;
      if (slash >= 0) {
        const { entry: parent } = await resolve(destPath.slice(0, slash) || '/');
        if (parent.mimeType !== FOLDER_MIME) throw new Error(`mv: ${destPath}: Not a folder`);
        toId = parent.id;
        if (toId !== fromId) url += `&addParents=${toId}&removeParents=${fromId}`;
      }
      await api(url, { method: 'PATCH', body: JSON.stringify({ name: newName }) });
      invalidate(fromId, toId);
      print('out', `${entry.name} → ${destPath}`);
    },

    cp: async (args) => {
      if (!args[0]) throw new Error('usage: cp <src> [dest]');
      const { entry } = await resolve(args[0]);
      if (entry.mimeType === FOLDER_MIME) throw new Error('cp: copying folders is not supported');
      let parentId = cwd[cwd.length - 1].id;
      let name = `Copy of ${entry.name}`;
      if (args[1]) {
        try {
          const { entry: dest } = await resolve(args[1]);
          if (dest.mimeType !== FOLDER_MIME) throw new Error(`cp: ${args[1]} already exists`);
          parentId = dest.id;
          name = entry.name;
        } catch (e) {
          if (!/No such file/.test(e.message)) throw e;
          name = args[1];
        }
      }
      await api(`https://www.googleapis.com/drive/v3/files/${entry.id}/copy?fields=id,name`, {
        method: 'POST',
        body: JSON.stringify({ name, parents: [parentId] }),
      });
      invalidate(parentId);
      print('out', `copied ${entry.name} → ${name}`);
    },

    recent: async () => {
      const q = encodeURIComponent(`(mimeType='${SHEET_MIME}' or mimeType='${DOC_MIME}') and trashed=false`);
      const data = await api(
        `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=viewedByMeTime+desc&pageSize=10&fields=files(id,name,mimeType,parents)`
      );
      printNumbered(data.files || []);
    },

    find: async (args) => {
      const text = args.join(' ');
      if (!text) throw new Error('usage: find <text>');
      const q = encodeURIComponent(`name contains '${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed=false`);
      const data = await api(
        `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=viewedByMeTime+desc&pageSize=25&fields=files(id,name,mimeType,parents)`
      );
      printNumbered(data.files || []);
    },
  };
  commands.echo = async (args) => print('out', args.join(' '));
  commands.alias = async (args) => {
    if (args.length === 0) {
      Object.entries(aliases).forEach(([k, v]) => print('out', `alias ${k}=${quoteArg(v)}`));
      return;
    }
    const def = args.join(' ');
    const eq = def.indexOf('=');
    if (eq <= 0) {
      if (aliases[def] === undefined) throw new Error(`alias: ${def}: not found`);
      print('out', `alias ${def}=${quoteArg(aliases[def])}`);
      return;
    }
    const name = def.slice(0, eq).trim();
    const value = def.slice(eq + 1).trim();
    if (!/^[\w.-]+$/.test(name)) throw new Error(`alias: invalid name: ${name}`);
    setAliases((prev) => ({ ...prev, [name]: value }));
  };
  commands.unalias = async (args) => {
    if (!args[0]) throw new Error('usage: unalias <name>');
    const missing = args.find((a) => aliases[a] === undefined);
    if (missing) throw new Error(`unalias: ${missing}: not found`);
    setAliases((prev) => {
      const next = { ...prev };
      args.forEach((a) => {
        if (DEFAULT_ALIASES[a] !== undefined) next[a] = null;
        else delete next[a];
      });
      return next;
    });
  };

  // Pipe targets: take captured items, return the items to pass along.
  const itemText = (it) => it.text + (it.file ? it.file.name + (it.file.mimeType === FOLDER_MIME ? '/' : '') : '');
  const filters = {
    pbcopy: async (items) => {
      const text = items.map(itemText).join('\n');
      await navigator.clipboard.writeText(text);
      print('out', `(copied ${items.length} line${items.length === 1 ? '' : 's'} to clipboard)`, { dim: true });
      return [];
    },
    grep: async (items, args) => {
      const flags = args.filter((a) => /^-[iv]+$/.test(a)).join('');
      const pattern = args.filter((a) => !/^-[iv]+$/.test(a)).join(' ');
      if (!pattern) throw new Error('usage: grep [-i] [-v] <text>');
      const ci = flags.includes('i');
      const needle = ci ? pattern.toLowerCase() : pattern;
      return items.filter((it) => {
        const t = ci ? itemText(it).toLowerCase() : itemText(it);
        return t.includes(needle) !== flags.includes('v');
      });
    },
    head: async (items, args) => {
      const n = parseInt((args.find((a) => /^-?\d+$/.test(a)) || '10').replace('-', ''), 10);
      return items.slice(0, n);
    },
    tail: async (items, args) => {
      const n = parseInt((args.find((a) => /^-?\d+$/.test(a)) || '10').replace('-', ''), 10);
      return items.slice(-n);
    },
    wc: async (items) => [{ text: String(items.length) }],
  };

  // Expand aliases on the first word (repeatedly, with a guard against loops).
  const expand = (tokens) => {
    let out = tokens;
    const seen = new Set();
    while (out.length && aliases[out[0]] !== undefined && !seen.has(out[0])) {
      seen.add(out[0]);
      out = [...tokenize(aliases[out[0]]).tokens, ...out.slice(1)];
    }
    return out;
  };

  const run = async (line) => {
    const trimmed = line.trim();
    print('cmd', trimmed, { prompt: pathString(cwd) });
    if (!trimmed) return;
    historyRef.current = [...historyRef.current.filter((h) => h !== trimmed), trimmed].slice(-200);
    saveJSON(HISTORY_KEY, historyRef.current);
    historyIdxRef.current = -1;

    const stages = splitPipes(trimmed).map((s) => expand(tokenize(s).tokens));
    if (stages.some((s) => s.length === 0)) { print('err', 'syntax error near "|"'); return; }
    const [[cmd, ...args], ...pipeline] = stages;
    const fn = commands[cmd];
    if (!fn) { print('err', `${cmd}: command not found (try "help")`); return; }
    const badFilter = pipeline.find(([f]) => !filters[f]);
    if (badFilter) { print('err', `${badFilter[0]}: can't be used after | (use pbcopy, grep, head, tail, wc)`); return; }
    setBusy(true);
    try {
      if (pipeline.length === 0) {
        await fn(args);
      } else {
        let items = [];
        captureRef.current = items;
        try { await fn(args); } finally { captureRef.current = null; }
        for (const [f, ...fargs] of pipeline) items = await filters[f](items, fargs);
        items.forEach((it) => (it.file ? print('entry', it.text, { file: it.file }) : print('out', it.text)));
      }
    } catch (e) {
      print('err', e.message);
    } finally {
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const complete = async () => {
    const { tokens, lastStart, endsWithSpace } = tokenize(input);
    if (tokens.length === 0 || (tokens.length === 1 && !endsWithSpace)) {
      const partial = tokens[0] || '';
      const matches = [...new Set([...Object.keys(commands), ...Object.keys(aliases)])].filter((c) => c.startsWith(partial));
      if (matches.length === 1) setInput(matches[0] + ' ');
      else if (matches.length > 1) print('out', matches.join('  '));
      return;
    }
    const partial = endsWithSpace ? '' : tokens[tokens.length - 1];
    const slash = partial.lastIndexOf('/');
    const dirPart = slash >= 0 ? partial.slice(0, slash + 1) : '';
    const namePart = partial.slice(slash + 1).toLowerCase();
    try {
      let dirId = cwd[cwd.length - 1].id;
      if (dirPart) {
        const { entry } = await resolve(dirPart === '/' ? '/' : dirPart.replace(/\/$/, ''));
        if (entry.mimeType !== FOLDER_MIME) return;
        dirId = entry.id;
      }
      const matches = (await listFolder(dirId)).filter((e) => e.name.toLowerCase().startsWith(namePart));
      if (matches.length === 0) return;
      const withSlash = (e) => dirPart + e.name + (e.mimeType === FOLDER_MIME ? '/' : '');
      if (matches.length === 1) {
        const done = withSlash(matches[0]);
        setInput(input.slice(0, lastStart) + quoteArg(done) + (done.endsWith('/') ? '' : ' '));
        return;
      }
      // Extend to the longest common prefix, then list the candidates.
      let prefix = matches[0].name;
      for (const m of matches) {
        while (!m.name.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
      }
      if (prefix.length > namePart.length) setInput(input.slice(0, lastStart) + quoteArg(dirPart + prefix));
      else print('grid', '', { files: matches });
    } catch {
      /* no completion */
    }
  };

  const handleKeyDown = (e) => {
    const hist = historyRef.current;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (busy) return;
      const line = input;
      setInput('');
      run(line);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      complete();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hist.length === 0) return;
      const idx = historyIdxRef.current === -1 ? hist.length - 1 : Math.max(0, historyIdxRef.current - 1);
      historyIdxRef.current = idx;
      setInput(hist[idx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdxRef.current === -1) return;
      const idx = historyIdxRef.current + 1;
      if (idx >= hist.length) { historyIdxRef.current = -1; setInput(''); }
      else { historyIdxRef.current = idx; setInput(hist[idx]); }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    } else if (e.key === 'c' && e.ctrlKey && !window.getSelection()?.toString()) {
      e.preventDefault();
      print('cmd', input + '^C', { prompt: pathString(cwd) });
      setInput('');
    }
  };

  // Clicking an entry: folders cd into it, files open in the viewer.
  const clickEntry = (f) => {
    if (busy) return;
    run(`${f.mimeType === FOLDER_MIME ? 'cd' : 'open'} ${quoteArg(f.name)}`);
  };

  const renderName = (f) => (
    <span
      className={`term-entry ${f.mimeType === FOLDER_MIME ? 'term-folder' : 'term-file'}`}
      onClick={() => clickEntry(f)}
      title={f.mimeType === FOLDER_MIME ? 'cd' : 'open'}
    >
      {iconFor(f.mimeType)} {f.name}{f.mimeType === FOLDER_MIME ? '/' : ''}
    </span>
  );

  return (
    <div className="term" onClick={(e) => { if (!window.getSelection()?.toString() && e.target === e.currentTarget) inputRef.current?.focus(); }}>
      <div className="term-header">
        <span>drive shell — {pathString(cwd)}</span>
        {onClose && <button className="term-close" onClick={onClose} title="Close">×</button>}
      </div>
      <div className="term-body" ref={scrollRef} onClick={() => { if (!window.getSelection()?.toString()) inputRef.current?.focus(); }}>
        {lines.map((l, i) => {
          if (l.type === 'cmd') {
            return (
              <div key={i} className="term-line">
                <span className="term-prompt">{l.prompt} $</span> {l.text}
              </div>
            );
          }
          if (l.type === 'grid') {
            return (
              <div key={i} className="term-grid">
                {l.files.map((f) => <span key={f.id}>{renderName(f)}</span>)}
              </div>
            );
          }
          if (l.type === 'link') {
            return (
              <div key={i} className="term-line">
                {l.text}<a className="term-link" href={l.url} target="_blank" rel="noopener noreferrer">{l.url}</a>
              </div>
            );
          }
          if (l.type === 'entry') {
            return <div key={i} className="term-line">{l.text}{renderName(l.file)}</div>;
          }
          return <div key={i} className={`term-line ${l.type === 'err' ? 'term-err' : ''} ${l.dim ? 'term-dim' : ''}`}>{l.text}</div>;
        })}
        <div className="term-input-row">
          <span className="term-prompt">{pathString(cwd)} $</span>
          <input
            ref={inputRef}
            className="term-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            placeholder={busy ? 'working…' : ''}
          />
        </div>
      </div>
    </div>
  );
};

export default DriveTerminal;
