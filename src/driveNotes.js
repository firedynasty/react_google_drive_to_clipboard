export const DOC_MIME = 'application/vnd.google-apps.document';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_TEXT = 4 * 1024 * 1024;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|text|org|rst|log|tex|csv|tsv|json|ya?ml|toml|ini|cfg|conf|py|jsx?|tsx?|html?|css|sh|bash|zsh|sql|xml)$/i;

export function isDriveNote(file) {
  if (file.mimeType === DOC_MIME) return true;
  if (file.mimeType?.startsWith('application/vnd.google-apps.')) return false;
  return file.mimeType?.startsWith('text/') || TEXT_EXTENSIONS.test(file.name) ||
    ['application/json', 'application/xml', 'application/javascript', 'application/yaml'].includes(file.mimeType);
}

export function originalUrl(file) {
  const id = encodeURIComponent(file.id);
  if (file.mimeType === DOC_MIME) return `https://docs.google.com/document/d/${id}/edit`;
  return `https://drive.google.com/file/d/${id}/view`;
}

const aborted = () => new DOMException('Request cancelled', 'AbortError');

async function boundedText(response) {
  if (Number(response.headers?.get('content-length')) > MAX_TEXT) {
    await response.body?.cancel();
    throw new Error('This note is larger than 4 MiB. Open the original to read it.');
  }
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_TEXT) {
          await reader.cancel();
          throw new Error('This note is larger than 4 MiB. Open the original to read it.');
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      text = chunks.join('');
    } finally {
      reader.releaseLock();
    }
  } else {
    text = await response.text();
    if (new Blob([text]).size > MAX_TEXT) throw new Error('This note is larger than 4 MiB. Open the original to read it.');
  }
  if (text.includes('\0')) throw new Error('This file is not plain text. Open the original to view it.');
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export async function fetchDriveNote(file, ensureFreshToken, signal) {
  if (!isDriveNote(file)) throw new Error('Open this file in its original viewer.');
  if (Number(file.size) > MAX_TEXT) throw new Error('This note is larger than 4 MiB. Open the original to read it.');
  const token = await ensureFreshToken();
  if (signal?.aborted) throw aborted();
  const id = encodeURIComponent(file.id);
  const resource = file.mimeType === DOC_MIME ? `${id}/export?mimeType=text%2Fplain` : `${id}?alt=media`;
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${resource}`, {
    headers: { Authorization: `Bearer ${token}` }, signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Could not read this note (HTTP ${response.status}).`);
  }
  return { text: await boundedText(response), fetchedAt: Date.now() };
}

// One queue per feed, shared by its visible cards. Aborted jobs never start a fetch.
export function createNoteLoader() {
  let active = 0;
  const queue = [];
  function finished() { active--; drain(); }
  function drain() {
    while (active < 2 && queue.length) {
      const job = queue.shift();
      if (job.signal.aborted) { job.reject(aborted()); continue; }
      active++;
      fetchDriveNote(job.file, job.ensureFreshToken, job.signal).then(job.resolve, job.reject).finally(finished);
    }
  }
  return (file, ensureFreshToken, signal) => new Promise((resolve, reject) => {
    queue.push({ file, ensureFreshToken, signal, resolve, reject }); drain();
  });
}
