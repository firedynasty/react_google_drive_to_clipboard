// Node 22+, macOS Chrome. Real local server and browser; fake gdcat, no Google requests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gdwatch-browser-'));
const folder = path.join(temporary, 'My Drive');
const second = path.join(temporary, 'Other notes');
const app = path.join(temporary, 'reader');
const bin = path.join(temporary, 'bin');
for (const dir of [folder, second, app, bin, path.join(temporary, 'state')]) fs.mkdirSync(dir);
for (const file of ['server.py', 'index.html']) fs.copyFileSync(path.join(__dirname, file), path.join(app, file));
for (const name of ['A Fractions.gdoc', 'C Broken.gdoc', 'D Slow.gdoc', 'Z Distant.gdoc']) {
  fs.writeFileSync(path.join(folder, name), '{"doc_id":"fake-doc-id"}');
}
fs.writeFileSync(path.join(folder, '.hidden.txt'), 'Hidden note');
fs.writeFileSync(path.join(folder, 'picture.png'), Buffer.from([0, 1, 2, 3]));
fs.mkdirSync(path.join(folder, 'Subfolder'));
fs.writeFileSync(path.join(temporary, 'fail'), '1');
fs.writeFileSync(path.join(folder, 'B notes.md'), 'My local notes\n' + 'Practice one fraction at a time.\n'.repeat(65));
fs.writeFileSync(path.join(second, 'next.txt'), 'Another folder');
fs.writeFileSync(path.join(temporary, 'export.txt'), 'Fractions from Brilliant\n\n1/2 + 1/3 = 5/6\n<script>window.bad = true</script>');
fs.writeFileSync(path.join(bin, 'gdcat'), `#!/bin/bash
printf '%s\\n' "$1" >> "$GDWATCH_FIXTURE/calls"
if [[ "$1" = 'C Broken.gdoc' ]] && [[ -f "$GDWATCH_FIXTURE/fail" ]]; then echo 'Google access denied' >&2; exit 1; fi
if [[ "$1" = 'D Slow.gdoc' ]] && [[ -f "$GDWATCH_FIXTURE/block" ]]; then
  touch "$GDWATCH_FIXTURE/started"
  while [[ ! -f "$GDWATCH_FIXTURE/release" ]]; do sleep 0.1; done
  echo 'STALE OLD FOLDER TEXT'; exit 0
fi
cat "$GDWATCH_FIXTURE/export.txt"
`, { mode: 0o755 });
let chrome, backend, ws;
let nextId = 0;
const callbacks = new Map(), exceptions = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let attempt = 0; attempt < 150; attempt++) { if (await check()) return; await delay(100); }
  throw new Error('Timed out: ' + label);
}
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { callbacks.delete(id); reject(new Error(method)); }, 15000);
    callbacks.set(id, result => { clearTimeout(timer); result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const count = () => fs.existsSync(path.join(temporary, 'calls')) ? fs.readFileSync(path.join(temporary, 'calls'), 'utf8').trim().split('\n').length : 0;
(async () => {
  try {
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const base = `http://127.0.0.1:${port}`, token = 'browser-test-secret';
    backend = spawn('python3', [path.join(app, 'server.py'), '_serve', '--port', String(port), '--folder', folder], {
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, GDWATCH_FIXTURE: temporary,
        GDWATCH_STATE_DIR: path.join(temporary, 'state'), GDWATCH_TOKEN: token }, stdio: 'ignore'
    });
    await until(async () => { try { return (await fetch(base + '/api/health', { headers: { 'X-Gdwatch-Token': token } })).ok; } catch { return false; } }, 'server');
    const profile = path.join(temporary, 'chrome');
    chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
      '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', 'about:blank'
    ], { stdio: 'ignore' });
    await until(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'Chrome');
    const chromePort = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
    ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) { callbacks.get(message.id)?.(message); callbacks.delete(message.id); }
      else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
    };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: base + '/#' + token });
    const card = name => `document.querySelector('.note[data-name="${name}"]')`;
    const content = name => card(name) + '?.querySelector(".note-body").textContent';
    const filter = value => evaluate(`(() => {const input=document.querySelector('#search'); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input')); window.scrollTo(0,0);})()`);
    await until(() => evaluate('document.querySelectorAll(".note").length === 6'), 'all note cards');
    await until(() => evaluate(content('A Fractions.gdoc') + '?.includes("5/6")'), 'first Doc loads without clicking');
    await until(() => evaluate(content('B notes.md') + '?.includes("My local notes")'), 'second note also visible');
    assert.equal(count(), 1, 'distant Docs do not export before scrolling');
    assert.equal(await evaluate('window.bad === undefined'), true);
    assert.equal(await evaluate(card('A Fractions.gdoc') + '.querySelector("a").href'), 'https://docs.google.com/document/d/fake-doc-id/edit');
    assert.equal(await evaluate(card('.hidden.txt') + '.hidden'), true);
    assert.equal(await evaluate('document.querySelectorAll(".other-entry").length'), 2);
    await evaluate('window.copied = null; Object.defineProperty(navigator, "clipboard", {value:{writeText:async value=>{window.copied=value}},configurable:true}); ' + card('A Fractions.gdoc') + '.querySelector(".copy").click()');
    await until(() => evaluate('window.copied?.includes("5/6")'), 'copy text');
    await evaluate('window.originalCard = ' + card('A Fractions.gdoc'));
    fs.writeFileSync(path.join(folder, 'Added.txt'), 'A newly saved note');
    await until(() => evaluate('document.querySelectorAll(".note").length === 7'), 'new file appears');
    assert.equal(await evaluate('window.originalCard === ' + card('A Fractions.gdoc')), true, 'existing notes retain their DOM');
    fs.unlinkSync(path.join(folder, 'Added.txt'));
    await until(() => evaluate('document.querySelectorAll(".note").length === 6'), 'deleted file disappears');
    fs.writeFileSync(path.join(temporary, 'export.txt'), 'Updated Google Doc: 3/4 - 1/6 = 7/12');
    await evaluate(card('A Fractions.gdoc') + '.querySelector("[aria-label^=Refresh]").click()');
    await until(() => evaluate(content('A Fractions.gdoc') + '?.includes("7/12")'), 'per-note remote refresh');
    assert.equal(count(), 2);
    assert.equal(await evaluate(content('B notes.md') + '.includes("My local notes")'), true);
    await filter('Broken');
    await until(() => evaluate(card('C Broken.gdoc') + '?.querySelector(".error")?.textContent.includes("denied")'), 'one Doc error is isolated');
    fs.unlinkSync(path.join(temporary, 'fail'));
    await evaluate(card('C Broken.gdoc') + '.querySelector("[aria-label^=Refresh]").click()');
    await until(() => evaluate(content('C Broken.gdoc') + '?.includes("7/12")'), 'retry one failed Doc');
    await filter('');
    await evaluate(card('Z Distant.gdoc') + '.scrollIntoView()');
    await until(() => evaluate(content('Z Distant.gdoc') + '?.includes("7/12")'), 'scrolling loads distant Doc');
    fs.writeFileSync(path.join(folder, 'B notes.md'), 'Local note updated on disk');
    await until(() => evaluate(content('B notes.md') + '?.includes("updated on disk")'), 'local note change');
    await evaluate('window.scrollTo(0,0)');
    const output = process.env.GDWATCH_SCREENSHOT_DIR || temporary;
    fs.mkdirSync(output, { recursive: true });
    for (const [label, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: label === 'mobile' });
      await delay(100);
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= ${width}`), true, label + ' overflow');
      const capture = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(output, `gdwatch-${label}.png`), Buffer.from(capture.data, 'base64'));
    }
    // Pending exports from an old folder must never fill the new feed.
    fs.writeFileSync(path.join(temporary, 'block'), '1');
    await filter('Slow');
    await until(() => evaluate('!' + card('D Slow.gdoc') + '.querySelector("[aria-label^=Refresh]").disabled'), 'slow Doc ready to refresh');
    await evaluate(card('D Slow.gdoc') + '.querySelector("[aria-label^=Refresh]").click()');
    await until(() => fs.existsSync(path.join(temporary, 'started')), 'slow export started');
    const response = await fetch(base + '/api/watch', { method: 'POST', headers: { 'X-Gdwatch-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: second }) });
    assert.equal(response.status, 200);
    await until(() => evaluate('document.querySelector("#directory").textContent.endsWith("Other notes")'), 'folder switch');
    fs.writeFileSync(path.join(temporary, 'release'), '1');
    await until(() => evaluate(content('next.txt') + '?.includes("Another folder")'), 'new folder notes load automatically');
    assert.equal(await evaluate('document.querySelectorAll(".note").length'), 1);
    await delay(300);
    assert.equal(await evaluate('document.body.textContent.includes("STALE OLD FOLDER TEXT")'), false);
    await send('Page.reload');
    await until(() => evaluate(content('next.txt') + '?.includes("Another folder")'), 'reload retains token');
    assert.deepEqual(exceptions, []);
    await evaluate('document.querySelector("#stop").click()');
    await until(() => evaluate('document.querySelector("#status").textContent === "Stopped"'), 'stop');
    process.stdout.write('PASS: combined feed, lazy export, safe text, copy, filtering, per-note refresh, retry, file changes, stale requests, reload, folder switch, stop, desktop and mobile.\n');
    process.stdout.write('Screenshots: ' + output + '\n');
  } finally {
    fs.writeFileSync(path.join(temporary, 'release'), '1');
    ws?.close(); chrome?.kill(); backend?.kill();
  }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
