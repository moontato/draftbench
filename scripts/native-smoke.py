#!/usr/bin/env python3
"""Opt-in Linux desktop smoke test against tauri-driver (no llama-server needed).
Build with `npm run tauri build -- --debug`; start tauri-driver under Xvfb/D-Bus.
Uses the real bundled webview, IPC, Rust filesystem, and native HTTP transport.
"""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import Request, urlopen

BASE = os.environ.get('DRAFTBENCH_WEBDRIVER_URL', 'http://localhost:4444')
BINARY = os.environ.get('DRAFTBENCH_BINARY', str(Path(__file__).resolve().parents[1] / 'src-tauri/target/debug/draftbench'))

def webdriver(method, route, data=None):
    req = Request(BASE + route, data=json.dumps(data).encode() if data is not None else None,
                  headers={'Content-Type': 'application/json'}, method=method)
    with urlopen(req, timeout=120) as response:
        value = json.load(response)['value']
    if isinstance(value, dict) and 'error' in value and 'ok' not in value:
        raise RuntimeError(value)
    return value

class MockServer(BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.path == '/v1/models'
        body = json.dumps({'data': [{'id': 'mock-reviewer'}]}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        assert self.path == '/v1/chat/completions'
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert data['model'] == 'mock-reviewer'
        body = json.dumps({'choices': [{'message': {'content': '{"issues":[]}'}, 'finish_reason': 'stop'}]}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body)
    def log_message(self, *args):
        pass

server = HTTPServer(('127.0.0.1', 0), MockServer)
threading.Thread(target=server.serve_forever, daemon=True).start()
session = None
try:
    value = webdriver('POST', '/session', {'capabilities': {'alwaysMatch': {'tauri:options': {'application': BINARY}}}})
    session = value['sessionId']
    route = '/session/' + session
    webdriver('POST', route + '/timeouts', {'script': 120000})
    for _ in range(40):
        text = webdriver('POST', route + '/execute/sync', {'script': 'return document.body.innerText', 'args': []})
        if 'Make your point.' in text:
            break
        time.sleep(.25)
    assert 'Make your point.' in text and 'frontend preview' not in text, text
    assert webdriver('POST', route + '/execute/sync', {'script': 'return typeof crypto.randomUUID === "function"', 'args': []})
    def invoke(command, args=None):
        return webdriver('POST', route + '/execute/async', {
            'script': 'const done = arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => done({ok:true,value}), error => done({ok:false,error}));',
            'args': [command, args or {}],
        })
    assert invoke('use_session_key', {'key': ''})['ok']  # Never read a user's real OS credentials.
    with tempfile.TemporaryDirectory(prefix='draftbench-native-', dir=os.environ.get('TMPDIR')) as directory:
        project = invoke('open_project', {'path': directory})
        assert project['ok'] and project['value']['name'].startswith('draftbench-native-'), project
        source = '# Native test\n\nA real local file.\n'
        saved = invoke('save_document', {'path': 'essay.md', 'content': source, 'expectedHash': None})
        assert saved['ok'], saved
        assert Path(directory, 'essay.md').read_text() == source
        loaded = invoke('read_document', {'path': 'essay.md'})
        assert loaded['value']['content'] == source and loaded['value']['hash'] == saved['value'], loaded
        failed = invoke('save_document', {'path': 'essay.md', 'content': 'overwrite', 'expectedHash': 'stale'})
        assert not failed['ok'] and 'CONFLICT' in failed['error'], failed
        assert Path(directory, 'essay.md').read_text() == source
        refused = invoke('read_document', {'path': '../outside.md'})
        assert not refused['ok'], refused
        assert invoke('create_folder', {'path': 'drafts'})['ok']
        assert invoke('rename_entry', {'path': 'essay.md', 'destination': 'drafts/report.md'})['ok']
        listed = invoke('list_files')['value']
        assert listed[0]['folder'] and listed[0]['children'][0]['path'] == 'drafts/report.md', listed
        assert not invoke('delete_entry', {'path': 'drafts'})['ok']  # Nonempty folder protection.
        assert invoke('delete_entry', {'path': 'drafts/report.md'})['ok']
        assert invoke('delete_entry', {'path': 'drafts'})['ok']
        endpoint = 'http://127.0.0.1:' + str(server.server_port)
        models = invoke('ai_http', {'request': {'id': 'native-models', 'serverUrl': endpoint, 'route': 'models', 'body': None, 'timeoutMs': 3000}})
        assert models['ok'] and models['value']['data'][0]['id'] == 'mock-reviewer', models
        complete = invoke('ai_http', {'request': {'id': 'native-review', 'serverUrl': endpoint, 'route': 'chat/completions', 'body': {'model': 'mock-reviewer', 'messages': [{'role': 'user', 'content': 'Review.'}]}, 'timeoutMs': 3000}})
        assert complete['ok'] and complete['value']['choices'][0]['message']['content'] == '{"issues":[]}', complete
        print('PASS: real bundled desktop UI, IPC, local Markdown CRUD, conflict protection, path boundary, and native HTTP (mock compatible server).')
finally:
    if session:
        webdriver('DELETE', '/session/' + session)
    server.shutdown()
