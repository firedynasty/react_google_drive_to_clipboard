#!/usr/bin/env python3
"""Read Google Docs from the calling terminal's folder. Standard library only."""

import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

HERE = Path(__file__).resolve().parent
CACHE = Path(os.environ.get('GDWATCH_STATE_DIR', Path.home() / '.cache' / 'gdwatch'))
MAX_TEXT = 4 * 1024 * 1024
HTTP = build_opener(ProxyHandler({}))
POINTERS = {'.gdoc', '.gdsheet', '.gsheet', '.gslides'}


def document_id(path):
    if path.stat().st_size > 16384:
        raise Problem('This Google Drive pointer is too large.')
    try:
        with path.open('rb') as stream:
            pointer = json.loads(stream.read(16385))
        item_id = pointer.get('doc_id') if isinstance(pointer, dict) else None
        if not isinstance(item_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', item_id):
            raise ValueError('invalid id')
        return item_id
    except (ValueError, UnicodeError) as error:
        raise Problem('This file is not a readable Google Drive pointer.') from error


class Documents:
    """Small, in-memory export cache; listings never fetch document contents."""
    def __init__(self):
        self.lock = threading.Lock()
        self.cache = {}

    def read(self, path, refresh=False):
        item_id = document_id(path)
        info = path.stat()
        key = (str(path), item_id, info.st_mtime_ns, info.st_size)
        # Serialize exports, including login refresh, to avoid duplicate requests.
        with self.lock:
            cached = self.cache.get(key)
            if not refresh and cached and time.monotonic() - cached[0] < 300:
                return dict(cached[1], cached=True)
            helper = HERE.parent / 'gdcat'
            if not helper.is_file():
                helper = Path(shutil.which('gdcat') or '')
            if not helper.is_file():
                raise Problem('gdcat is missing. Run terminal_mount/install.sh first.', 503)
            try:
                with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
                    # Name is a separate argument, never shell code; cwd avoids gdcat's root fallback.
                    process = subprocess.Popen(['bash', str(helper), path.name], cwd=path.parent,
                                               stdout=output, stderr=errors, start_new_session=True)
                    try:
                        code = process.wait(timeout=150)
                    except subprocess.TimeoutExpired:
                        import signal
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                        raise Problem('Google took too long. Try Refresh document again.', 504)
                    errors.seek(0)
                    if code:
                        detail = errors.read(2048).decode('utf-8', errors='replace').strip()
                        raise Problem(detail or 'Could not export this Doc. Check your rclone Drive login.', 502)
                    output.seek(0)
                    content = output.read(MAX_TEXT + 1)
            except OSError as error:
                raise Problem('Could not run gdcat. Check the terminal_mount installation.', 503) from error
            if len(content) > MAX_TEXT:
                raise Problem('This document is too large for the reader (4 MiB limit). Open it in Google Docs.', 413)
            try:
                text = content.decode('utf-8-sig').replace('\r\n', '\n').replace('\r', '\n')
            except UnicodeError as error:
                raise Problem('The exported document was not UTF-8 text.', 502) from error
            result = {'text': text, 'url': f'https://docs.google.com/document/d/{item_id}/edit',
                      'fetchedAt': time.time(), 'cached': False}
            if len(self.cache) >= 12:
                self.cache.pop(next(iter(self.cache)))
            self.cache[key] = (time.monotonic(), result)
            return result


class Problem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class Watch:
    def __init__(self, target, folder, shell_pid=None):
        self.lock = threading.Lock()
        self.set_location(target, folder, shell_pid)

    def set_location(self, target, folder, shell_pid=None):
        fixed = str(Path(folder).expanduser().resolve(strict=True)) if folder else None
        if fixed and not Path(fixed).is_dir():
            raise Problem('Choose a folder to watch.')
        if not fixed and not target and (not isinstance(shell_pid, int) or shell_pid <= 1):
            raise Problem('Could not identify the calling terminal shell.')
        with self.lock:
            self.target, self.folder, self.shell_pid = target, fixed, shell_pid

    def directory(self):
        with self.lock:
            target, fixed, shell_pid = self.target, self.folder, self.shell_pid
        if fixed:
            return Path(fixed)
        if not target:
            try:
                result = subprocess.run(
                    [shutil.which('lsof') or '/usr/sbin/lsof', '-a', '-p', str(shell_pid), '-d', 'cwd', '-F0n'],
                    capture_output=True, timeout=2, check=True)
                names = [field[1:] for field in result.stdout.split(b'\0') if field.startswith(b'n')]
                if not names:
                    raise ValueError('shell has no working directory')
                directory = Path(os.fsdecode(names[0])).resolve(strict=True)
                if not directory.is_dir():
                    raise ValueError('not a folder')
                return directory
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                raise Problem('The watched terminal closed. Run gdwatch from the terminal you want to follow.', 503) from error
        try:
            # display-message expects a pane target; a session needs its colon.
            if ':' not in target and not target.startswith(('%', '@')):
                target += ':'
            result = subprocess.run(
                [shutil.which('tmux') or 'tmux', 'display-message', '-p', '-t', target, '#{pane_current_path}'],
                capture_output=True, text=True, timeout=2, check=True)
            reported = result.stdout.rstrip('\r\n')
            if not reported or not Path(reported).is_absolute():
                raise ValueError('terminal has no working directory')
            directory = Path(reported).resolve(strict=True)
            if not directory.is_dir():
                raise ValueError('not a folder')
            return directory
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise Problem('No matching terminal session. Start termview, then run gdwatch again.', 503) from error

    def state(self):
        directory = self.directory()
        files = []
        with os.scandir(directory) as entries:
            for entry in entries:
                try:
                    info = entry.stat(follow_symlinks=False)
                    kind = 'folder' if entry.is_dir(follow_symlinks=False) else 'file'
                    files.append({'name': entry.name, 'kind': kind, 'size': info.st_size,
                                  'version': f'{info.st_size}:{info.st_mtime_ns}'})
                except FileNotFoundError:
                    continue
        files.sort(key=lambda item: (item['kind'] != 'folder', item['name'].casefold()))
        revision = hashlib.sha256(json.dumps(files, ensure_ascii=True).encode()).hexdigest()
        return {'directory': str(directory), 'files': files, 'revision': revision,
                'following': not bool(self.folder), 'connected': True}

    def file(self, name, directory):
        current = self.directory()
        if directory != str(current):
            raise Problem('The terminal changed folders. Select the file again.', 409)
        if not name or Path(name).name != name or name in ('.', '..'):
            raise Problem('Select a file in the current folder.')
        path = current / name
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(current):
            raise Problem('This link points outside the current folder.')
        if not resolved.is_file():
            raise Problem('Select a file to preview.')
        return path


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, value, content_type='application/json; charset=utf-8'):
        payload = json.dumps(value, ensure_ascii=True).encode() if isinstance(value, dict) else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(payload)

    def permitted(self, api=False):
        allowed = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        if self.headers.get('Host') not in allowed:
            raise Problem('Invalid host.', 403)
        origin = self.headers.get('Origin')
        if origin and origin not in {f'http://{host}' for host in allowed}:
            raise Problem('Invalid origin.', 403)
        if api and not hmac.compare_digest(self.headers.get('X-Gdwatch-Token', ''), self.server.token):
            raise Problem('Open the watcher using the link printed by gdwatch.', 403)

    def handle_request(self, method):
        try:
            route = urlsplit(self.path)
            self.permitted(api=route.path.startswith('/api/'))
            if method == 'GET' and route.path == '/':
                return self.reply(200, (HERE / 'index.html').read_bytes(), 'text/html; charset=utf-8')
            if method == 'GET' and route.path == '/api/health':
                return self.reply(200, {'ok': True, 'pid': os.getpid(), 'protocol': 2})
            if method == 'GET' and route.path == '/api/state':
                return self.reply(200, self.server.watch.state())
            if method == 'GET' and route.path == '/api/file':
                query = parse_qs(route.query)
                name = query.get('name', [''])[0]
                path = self.server.watch.file(name, query.get('directory', [''])[0])
                result = {'name': name, 'path': str(path), 'text': None}
                if path.suffix.lower() == '.gdoc':
                    result.update(self.server.documents.read(path, query.get('refresh') == ['1']))
                elif path.suffix.lower() in POINTERS:
                    result['message'] = 'This reader previews Google Docs. Open Sheets and Slides in their Google editor.'
                elif path.stat().st_size > MAX_TEXT:
                    result['message'] = 'This file is too large to preview here. Choose Open on Mac.'
                else:
                    with path.open('rb') as stream:
                        content = stream.read(MAX_TEXT + 1)
                    if len(content) > MAX_TEXT:
                        result['message'] = 'This file is too large to preview here. Choose Open on Mac.'
                    elif b'\0' in content:
                        result['message'] = 'This file is not plain text. Choose Open on Mac.'
                    else:
                        try:
                            result['text'] = content.decode('utf-8-sig')
                        except UnicodeDecodeError:
                            result['message'] = 'This file is not UTF-8 text. Choose Open on Mac.'
                return self.reply(200, result)
            if method == 'POST':
                length = int(self.headers.get('Content-Length', '0'))
                if length < 0 or length > 16384:
                    raise Problem('Request is too large.', 413)
                body = json.loads(self.rfile.read(length) or b'{}')
                if not isinstance(body, dict):
                    raise Problem('Invalid request.')
                if route.path == '/api/open':
                    path = self.server.watch.file(body.get('name', ''), body.get('directory', ''))
                    subprocess.run(['/usr/bin/open', str(path)], check=True, timeout=10,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    return self.reply(200, {'ok': True})
                if route.path == '/api/watch':
                    self.server.watch.set_location(body.get('target'), body.get('folder'), body.get('shell_pid'))
                    return self.reply(200, {'ok': True})
                if route.path == '/api/stop':
                    self.reply(200, {'ok': True})
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                    return
            self.reply(404, {'error': 'Not found.'})
        except Problem as error:
            self.reply(error.status, {'error': str(error)})
        except FileNotFoundError:
            self.reply(404, {'error': 'This file or folder is no longer available.'})
        except PermissionError:
            self.reply(403, {'error': 'macOS did not allow access to this file or folder.'})
        except (ValueError, TypeError, subprocess.SubprocessError, OSError):
            self.reply(400, {'error': 'Could not complete this request. Refresh and try again.'})

    def do_GET(self):
        self.handle_request('GET')

    def do_POST(self):
        self.handle_request('POST')


def state_file(port):
    return CACHE / f'{port}.json'


def request(state, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = Request(f'http://127.0.0.1:{state["port"]}{path}', data=data,
                  headers={'X-Gdwatch-Token': state['token'], 'Content-Type': 'application/json'})
    with HTTP.open(req, timeout=3) as response:
        return json.load(response)


def running(port):
    try:
        state = json.loads(state_file(port).read_text())
        health = request(state, '/api/health')
        if health.get('pid') == state['pid']:
            state['protocol'] = health.get('protocol', 1)
            return state
    except (OSError, ValueError, KeyError, URLError):
        pass
    return None


def stop(state):
    request(state, '/api/stop', {})
    for _ in range(30):
        if not running(state['port']):
            return
        time.sleep(0.1)
    raise Problem('The watcher is still stopping. Try again in a moment.')


def serve(args):
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    server.token = os.environ['GDWATCH_TOKEN']
    server.watch = Watch(args.target, args.folder, args.shell_pid)
    server.documents = Documents()
    state = {'port': args.port, 'token': server.token, 'pid': os.getpid()}
    temporary = state_file(args.port).with_suffix(f'.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(state))
    temporary.replace(state_file(args.port))
    try:
        server.serve_forever(poll_interval=0.15)
    finally:
        server.server_close()
        try:
            if json.loads(state_file(args.port).read_text())['pid'] == os.getpid():
                state_file(args.port).unlink()
        except (OSError, ValueError, KeyError):
            pass


def main():
    parser = argparse.ArgumentParser(description='Follow this terminal folder in Chrome; read Google Docs and text notes.')
    parser.add_argument('action', choices=['start', 'stop', 'status', '_serve'], nargs='?', default='start')
    parser.add_argument('--port', type=int, default=int(os.environ.get('GDWATCH_PORT', '7684')))
    parser.add_argument('--target', help='follow a specific tmux pane/session instead of this terminal')
    parser.add_argument('--shell-pid', type=int, help='follow a specific shell process (normally detected automatically)')
    parser.add_argument('--folder', help='watch a fixed folder instead of following tmux')
    parser.add_argument('--no-open', action='store_true', help='print the link without opening Chrome')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be from 1024 to 65535')
    if not args.target and not args.folder and not args.shell_pid:
        args.target = os.environ.get('TMUX_PANE')
        if not args.target:
            args.shell_pid = os.getppid()
    os.umask(0o077)
    CACHE.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.action == '_serve':
        return serve(args)
    state = running(args.port)
    if args.action == 'stop':
        if state:
            stop(state)
            print('gdwatch: watcher stopped; your terminal and server keep running.')
        else:
            print('gdwatch: no watcher is running on this port.')
        return
    if args.action == 'status':
        print(f'gdwatch: {"running" if state else "stopped"} on port {args.port}.')
        if state:
            print('gdwatch: watching ' + request(state, '/api/state')['directory'])
        return
    folder = str(Path(args.folder).expanduser().resolve(strict=True)) if args.folder else None
    if folder and not Path(folder).is_dir():
        parser.error('--folder must be a directory')
    # Upgrade a running older watcher without invalidating its open Chrome tab.
    previous_token = None
    if state and state.get('protocol', 1) < 2:
        previous_token = state['token']
        stop(state)
        state = None
    if not state:
        token = previous_token or secrets.token_urlsafe(32)
        command = [sys.executable, str(HERE / 'server.py'), '_serve', '--port', str(args.port)]
        if args.target:
            command.extend(['--target', args.target])
        if args.shell_pid:
            command.extend(['--shell-pid', str(args.shell_pid)])
        if folder:
            command.extend(['--folder', folder])
        with (CACHE / f'{args.port}.log').open('ab') as log:
            process = subprocess.Popen(command, env=dict(os.environ, GDWATCH_TOKEN=token),
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                       start_new_session=True, close_fds=True)
        for _ in range(50):
            state = running(args.port)
            if state:
                break
            if process.poll() is not None:
                break
            time.sleep(0.1)
        if not state:
            if process.poll() is None:
                process.terminate()
            raise SystemExit(f'gdwatch: could not start on port {args.port}. See {CACHE / f"{args.port}.log"}.')
    request(state, '/api/watch', {'target': args.target, 'folder': folder, 'shell_pid': args.shell_pid})
    url = f'http://127.0.0.1:{args.port}/#{state["token"]}'
    print(f'gdwatch: {url}')
    print('gdwatch: watching ' + request(state, '/api/state')['directory'])
    print('gdwatch: notes load together as you scroll. Refresh a Doc to fetch later edits. Stop with: gdwatch stop')
    if not args.no_open:
        subprocess.run(['/usr/bin/open', '-a', 'Google Chrome', url], check=True)


if __name__ == '__main__':
    try:
        main()
    except (Problem, OSError, ValueError, URLError, subprocess.SubprocessError) as error:
        raise SystemExit(f'gdwatch: {error}')
