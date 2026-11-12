import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import server


class ReaderTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name).resolve()
        self.doc = self.folder / 'Fractions $(touch nope).gdoc'
        self.doc.write_text(json.dumps({'doc_id': 'example-Doc_123'}))

    def test_pointer_validation(self):
        self.assertEqual(server.document_id(self.doc), 'example-Doc_123')
        for value in [[], {}, {'doc_id': '../bad'}, {'doc_id': 7}, {'doc_id': 'bad?url=1'}]:
            self.doc.write_text(json.dumps(value))
            with self.assertRaises(server.Problem):
                server.document_id(self.doc)

    def test_exports_are_bounded_cached_and_refreshed(self):
        exports = []

        class Process:
            def __init__(inner, command, **kwargs):
                exports.append(command)
                self.assertEqual(kwargs['cwd'], self.folder)
                kwargs['stdout'].write(b'\xef\xbb\xbfFractions\r\n1/2 + 1/3\r\n')

            def wait(inner, timeout):
                return 0

        documents = server.Documents()
        helper = Path(__file__).parents[1] / 'gdcat'
        with patch('server.subprocess.Popen', Process), patch('server.shutil.which', return_value=str(helper)):
            # is_file for helper only; document stat/open still use the real fixture.
            original = Path.is_file
            with patch.object(Path, 'is_file', lambda path: path == helper or original(path)):
                first = documents.read(self.doc)
                second = documents.read(self.doc)
                third = documents.read(self.doc, refresh=True)
        self.assertEqual(first['text'], 'Fractions\n1/2 + 1/3\n')
        self.assertFalse(first['cached'])
        self.assertTrue(second['cached'])
        self.assertFalse(third['cached'])
        self.assertEqual(len(exports), 2)
        self.assertEqual(exports[0][-1], self.doc.name)
        self.assertEqual(first['url'], 'https://docs.google.com/document/d/example-Doc_123/edit')

    def test_export_failures_are_not_cached(self):
        class Process:
            def __init__(inner, command, **kwargs):
                kwargs['stderr'].write(b'gdcat: Drive returned HTTP 403: permission denied')

            def wait(inner, timeout):
                return 1

        documents = server.Documents()
        with patch('server.subprocess.Popen', Process), patch.object(Path, 'is_file', return_value=True):
            with self.assertRaisesRegex(server.Problem, 'permission denied'):
                documents.read(self.doc)
        self.assertEqual(documents.cache, {})

    def test_watch_rejects_old_folder_traversal_and_external_symlink(self):
        watch = server.Watch(None, self.folder)
        self.assertEqual(watch.file(self.doc.name, str(self.folder)), self.doc)
        for name in ['../outside', '/etc/passwd', '..']:
            with self.assertRaises(server.Problem):
                watch.file(name, str(self.folder))
        with self.assertRaises(server.Problem):
            watch.file(self.doc.name, '/old-folder')
        (self.folder / 'link').symlink_to('/etc/passwd')
        with self.assertRaises(server.Problem):
            watch.file('link', str(self.folder))

    @unittest.skipUnless(os.path.exists('/usr/sbin/lsof'), 'macOS lsof required')
    def test_follows_shell_after_cd(self):
        second = self.folder / 'More notes'
        second.mkdir()
        process = subprocess.Popen(['bash', '--noprofile', '--norc'], cwd=self.folder,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            watch = server.Watch(None, None, process.pid)
            process.stdin.write('printf "ready\\n"\n')
            process.stdin.flush()
            self.assertEqual(process.stdout.readline().strip(), 'ready')
            self.assertEqual(watch.directory(), self.folder)
            process.stdin.write('cd "More notes"\nprintf "ready\\n"\n')
            process.stdin.flush()
            self.assertEqual(process.stdout.readline().strip(), 'ready')
            self.assertEqual(watch.directory(), second)
        finally:
            process.stdin.close()
            process.wait(timeout=5)
            process.stdout.close()

    def test_http_listing_does_not_export_and_requires_token(self):
        (self.folder / 'notes.txt').write_text('Studying fractions')
        (self.folder / 'sheet.gsheet').write_text('{"doc_id":"sheet-id"}')
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        httpd.token = 'test-secret'
        httpd.watch = server.Watch(None, self.folder)
        httpd.documents = server.Documents()
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        base = f'http://127.0.0.1:{httpd.server_port}'

        def get(path, **headers):
            request = Request(base + path, headers={'X-Gdwatch-Token': httpd.token, **headers})
            with urlopen(request) as response:
                return json.load(response)

        with patch.object(httpd.documents, 'read', return_value={'text': '1/2 + 1/3'}) as export:
            listing = get('/api/state')
            self.assertIn(self.doc.name, [item['name'] for item in listing['files']])
            export.assert_not_called()
            for name, expected in [('notes.txt', 'Studying fractions'), ('sheet.gsheet', None)]:
                query = urlencode({'directory': str(self.folder), 'name': name})
                result = get('/api/file?' + query)
                self.assertEqual(result['text'], expected)
                if expected is None:
                    self.assertIn('Sheets and Slides', result['message'])
            export.assert_not_called()
            query = urlencode({'directory': str(self.folder), 'name': self.doc.name, 'refresh': '1'})
            self.assertEqual(get('/api/file?' + query)['text'], '1/2 + 1/3')
            export.assert_called_once_with(self.doc, True)
            for headers in [{'X-Gdwatch-Token': 'wrong'}, {'Origin': 'https://example.com'}, {'Host': 'evil.example'}]:
                with self.assertRaises(HTTPError) as failure:
                    get('/api/state', **headers)
                self.assertEqual(failure.exception.code, 403)
                failure.exception.close()

    def test_oversized_export_is_not_cached(self):
        class Process:
            def __init__(inner, command, **kwargs):
                kwargs['stdout'].write(b'x' * (server.MAX_TEXT + 1))

            def wait(inner, timeout):
                return 0

        documents = server.Documents()
        with patch('server.subprocess.Popen', Process), patch.object(Path, 'is_file', return_value=True):
            with self.assertRaisesRegex(server.Problem, 'too large'):
                documents.read(self.doc)
        self.assertEqual(documents.cache, {})


if __name__ == '__main__':
    unittest.main()
