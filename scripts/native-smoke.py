#!/usr/bin/env python3
"""Opt-in Linux desktop smoke test against tauri-driver (no llama-server needed).
Build with `npm run tauri build -- --debug`; start tauri-driver under Xvfb/D-Bus.
Uses the real bundled webview, IPC, Rust filesystem, and native HTTP transport.
Launch tauri-driver with a disposable XDG_CONFIG_HOME; project opens update app-config recents.
"""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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

review_lock = threading.Lock()
review_stats = {'active': 0, 'peak': 0, 'requests': 0}
by_server = {}

class MockServer(BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.path == '/v1/models'
        body = json.dumps({'data': [{'id': 'mock-reviewer'}]}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        assert self.path == '/v1/chat/completions'
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert data['model'] == 'mock-reviewer'
        assert self.headers.get('Authorization') == getattr(self.server, 'authorization', None)
        with review_lock:
            stats = by_server.setdefault(self.server.server_port, {'active': 0, 'peak': 0, 'requests': 0})
            stats['active'] += 1
            stats['requests'] += 1
            stats['peak'] = max(stats['peak'], stats['active'])
            review_stats['active'] += 1
            review_stats['requests'] += 1
            review_stats['peak'] = max(review_stats['peak'], review_stats['active'])
        try:
            time.sleep(.15)  # Expose overlapping native requests without real inference.
            body = json.dumps({'choices': [{'message': {'content': '{"issues":[]}'}, 'finish_reason': 'stop'}]}).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body)
        finally:
            with review_lock:
                review_stats['active'] -= 1
                stats['active'] -= 1
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), MockServer)
threading.Thread(target=server.serve_forever, daemon=True).start()
second_server = ThreadingHTTPServer(('127.0.0.1', 0), MockServer)
threading.Thread(target=second_server.serve_forever, daemon=True).start()
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
    recents = invoke('load_recent_projects')
    assert recents['ok'] and recents['value'] == [], 'Run the driver with a clean disposable XDG_CONFIG_HOME before this test.'
    with tempfile.TemporaryDirectory(prefix='draftbench-native-', dir=os.environ.get('TMPDIR')) as directory:
        project = invoke('open_project', {'path': directory})
        assert project['ok'] and project['value']['name'].startswith('draftbench-native-'), project
        source = '# Native test\n\nA real local file.\n'
        saved = invoke('save_document', {'path': 'essay.md', 'content': source, 'expectedHash': None})
        assert saved['ok'], saved
        assert Path(directory, 'essay.md').read_text() == source
        canonical = str(Path(directory).resolve())
        assert project['value']['recentProjects'][0]['path'] == canonical, project
        assert invoke('open_project', {'path': directory})['ok']
        assert len(invoke('load_recent_projects')['value']) == 1
        assert not invoke('open_project', {'path': str(Path(directory, 'missing-folder'))})['ok']
        assert len(invoke('load_recent_projects')['value']) == 1
        removed = invoke('remove_recent_project', {'path': canonical})
        assert removed['ok'] and removed['value'] == [], removed
        assert Path(directory, 'essay.md').read_text() == source  # Removing a recent never deletes files.
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
        long_source = '# Native test\n\n' + '\n\n'.join([f'Paragraph {i}. ' + 'A' * 10000 for i in range(5)]) + '\n'
        assert invoke('save_document', {'path': 'reopen.md', 'content': long_source, 'expectedHash': None})['ok']
        assert invoke('open_project', {'path': directory})['ok']
        assert invoke('save_settings', {'value': {'version': 1, 'analysis': {'parallelJobs': 3, 'paragraphInputChars': 64000, 'documentInputChars': 120000}, 'ai': {'serverUrl': endpoint, 'model': 'mock-reviewer'}}})['ok']
        webdriver('DELETE', '/session/' + session)
        session = None
        value = webdriver('POST', '/session', {'capabilities': {'alwaysMatch': {'tauri:options': {'application': BINARY}}}})
        session = value['sessionId']
        route = '/session/' + session
        webdriver('POST', route + '/timeouts', {'script': 120000})
        for _ in range(40):
            text = webdriver('POST', route + '/execute/sync', {'script': 'return document.body.innerText', 'args': []})
            if 'Recent projects' in text and Path(directory).name in text:
                break
            time.sleep(.25)
        assert 'Recent projects' in text and Path(directory).name in text, text
        clicked = webdriver('POST', route + '/execute/sync', {'script': 'const button = document.querySelector(".recent-project-open"); if (!button) return false; button.click(); return true;', 'args': []})
        assert clicked
        for _ in range(40):
            text = webdriver('POST', route + '/execute/sync', {'script': 'return document.body.innerText', 'args': []})
            if 'reopen' in text:
                break
            time.sleep(.25)
        assert 'reopen' in text, text
        assert invoke('read_document', {'path': 'reopen.md'})['value']['content'] == long_source
        assert invoke('use_session_key', {'key': ''})['ok']
        def script(js):
            return webdriver('POST', route + '/execute/sync', {'script': js, 'args': []})
        assert script('const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "reopen"); if (!b) return false; b.click(); return true;')
        for _ in range(40):
            if script('return !!document.querySelector(`[aria-label="Document writing editor"]`)'):
                break
            time.sleep(.25)
        assert script('return !!document.querySelector(`[aria-label="Document writing editor"]`)')
        with review_lock:
            review_stats['peak'] = 0
            review_stats['requests'] = 0
        assert script('const b = [...document.querySelectorAll("footer button")].find(b => b.textContent.includes("Analyze document")); if (!b) return false; b.click(); return true;')
        for _ in range(80):
            status = script('return document.querySelector(".analysis-status")?.textContent || ""')
            if 'findings' in status and 'cached reviews' in status:
                break
            time.sleep(.1)
        assert '0 findings' in status and 'warnings' not in status, status
        with review_lock:
            assert review_stats['active'] == 0 and review_stats['peak'] == 3 and review_stats['requests'] == 13, review_stats
        assert script('const b = [...document.querySelectorAll("footer button")].find(b => b.textContent.includes("Analyze document")); b.click(); return true;')
        for _ in range(40):
            status = script('return document.querySelector(".analysis-status")?.textContent || ""')
            if '19 cached reviews' in status:
                break
            time.sleep(.1)
        assert '19 cached reviews' in status, status
        with review_lock:
            assert review_stats['requests'] == 13, review_stats
        # v0.2: two actual native servers, isolated ephemeral keys, custom reviewers/profile.
        v2 = invoke('load_settings')['value']
        assert v2['version'] == 2, v2  # Clean legacy settings migrated automatically.
        v2['analysis']['legacySingleModel'] = False
        v2['analysis']['parallelJobs'] = 3
        second_endpoint = 'http://127.0.0.1:' + str(second_server.server_port)
        v2['backends'] += [dict(v2['ai'], id='native-first', name='Native First', credentialRef='backend:native-first', parallelJobs=1),
                           dict(v2['ai'], id='native-second', name='Native Second', serverUrl=second_endpoint, credentialRef='backend:native-second', parallelJobs=2)]
        v2['customAnalyzers'] = [dict(id=identifier, name=identifier, description='Native protocol fixture.', enabled=True, scope='paragraph', severity='suggestion', instructions='Review this fixture and return no findings.') for identifier in ['native-review-a', 'native-review-b']]
        v2['analyzers']['native-review-a'] = dict(enabled=True, model='', backend='native-first')
        v2['analyzers']['native-review-b'] = dict(enabled=True, model='', backend='native-second')
        v2['customProfiles'] = [dict(id='native-profile', name='Native profile', description='', enabled=['native-review-a', 'native-review-b']),
                                dict(id='grammar-profile', name='Grammar profile', description='', enabled=['harper'])]
        assert invoke('save_settings', {'value': v2})['ok']
        def restart_and_open(filename):
            global session, route
            webdriver('DELETE', '/session/' + session)
            session = None
            value = webdriver('POST', '/session', {'capabilities': {'alwaysMatch': {'tauri:options': {'application': BINARY}}}})
            session = value['sessionId']; route = '/session/' + session
            webdriver('POST', route + '/timeouts', {'script': 120000})
            for _ in range(60):
                if script('return !!document.querySelector(".recent-project-open")'): break
                time.sleep(.1)
            script('document.querySelector(".recent-project-open").click()')
            for _ in range(60):
                if script('return [...document.querySelectorAll("button")].some(b => b.textContent.trim() === ' + json.dumps(filename) + ')'): break
                time.sleep(.1)
            script('const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === ' + json.dumps(filename) + '); b.click()')
            for _ in range(60):
                if script('return !!document.querySelector(`[aria-label="Document writing editor"]`)'): break
                time.sleep(.1)
            assert script('return !!document.querySelector(`[aria-label="Document writing editor"]`)')
        def select_profile(identifier):
            script('const s = document.querySelector(`[aria-label="Writing profile"]`); s.value = ' + json.dumps(identifier) + '; s.dispatchEvent(new Event("change", {bubbles:true}))')
            assert script('return document.querySelector(`[aria-label="Writing profile"]`).value') == identifier
        def analyze():
            script('const b = [...document.querySelectorAll("footer button")].find(b => b.textContent.includes("Analyze document")); b.click()')
            for _ in range(100):
                status = script('return document.querySelector(".analysis-status")?.textContent || ""')
                if 'findings' in status and 'cached reviews' in status: return status
                time.sleep(.1)
            raise AssertionError(status)
        restart_and_open('reopen')
        assert invoke('use_session_key', {'key': 'native-first-key', 'credentialRef': 'backend:native-first'})['ok']
        assert invoke('use_session_key', {'key': 'native-second-key', 'credentialRef': 'backend:native-second'})['ok']
        server.authorization = 'Bearer native-first-key'
        second_server.authorization = 'Bearer native-second-key'
        select_profile('native-profile')
        with review_lock:
            review_stats.update(active=0, peak=0, requests=0)
            by_server.clear()
        status = analyze()
        assert '0 findings' in status and 'warnings' not in status, status
        with review_lock:
            assert review_stats == {'active': 0, 'peak': 3, 'requests': 12}, review_stats
            assert by_server[server.server_port] == {'active': 0, 'peak': 1, 'requests': 6}, by_server
            assert by_server[second_server.server_port] == {'active': 0, 'peak': 2, 'requests': 6}, by_server
        assert '12 cached reviews' in analyze()
        with review_lock: assert review_stats['requests'] == 12
        # Real embedded Harper IPC, UTF-16 mapping, then real UI/mark-preserving Apply/Undo.
        grammar_text = '😀 They has a plan.'
        grammar = invoke('harper_review', {'text': grammar_text})
        assert grammar['ok'] and grammar['value'], grammar
        for finding in grammar['value']:
            width = len(finding['quote'].encode('utf-16-le'))
            assert grammar_text.encode('utf-16-le')[finding['offset']*2:finding['offset']*2+width].decode('utf-16-le') == finding['quote'], finding
        assert any('have' in f['replacements'] for f in grammar['value']), grammar
        v2['analyzers']['harper']['enabled'] = True
        assert invoke('save_settings', {'value': v2})['ok']
        grammar_source = '# Grammar fixture\n\n😀 They **has** a plan.\n\n```text\nThey has a plan.\n```\n'
        assert invoke('save_document', {'path': 'grammar.md', 'content': grammar_source, 'expectedHash': None})['ok']
        restart_and_open('grammar')
        select_profile('grammar-profile')
        status = analyze()
        assert 'warnings' not in status, status
        assert script('const b = [...document.querySelectorAll(".finding-card")].find(b => b.textContent.includes("“has”")); if (!b) return false; b.click(); return true')
        assert script('const b = [...document.querySelectorAll(".fix-inspector button")].find(b => b.textContent.includes("Apply suggestion")); if (!b || b.disabled) return false; b.click(); return true')
        assert script('return document.querySelector(".ProseMirror strong")?.textContent') == 'have'
        assert script('return document.querySelector(".ProseMirror pre")?.textContent') == 'They has a plan.'
        script('document.querySelector(`button[title="Undo"]`).click()')
        assert script('return document.querySelector(".ProseMirror strong")?.textContent') == 'has'
        with review_lock: assert review_stats['requests'] == 12  # No HTTP during offline review/fix.
        assert invoke('remove_recent_project', {'path': canonical})['value'] == []
        assert Path(directory, 'reopen.md').read_text() == long_source
        assert Path(directory, 'grammar.md').read_text() == grammar_source
        print('PASS: real bundled WebKit/IPC, Markdown CRUD/conflicts/paths, persistent recents, v1→v2 migration, long-input budgets/cache, custom reviewers/profile across two native servers (global peak 3; backend peaks 1/2; isolated keys), and embedded Harper Unicode/code exclusion/mark-preserving Apply/Undo with no HTTP.')
finally:
    if session:
        webdriver('DELETE', '/session/' + session)
    server.shutdown()
    second_server.shutdown()
