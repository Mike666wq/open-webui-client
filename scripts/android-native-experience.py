#!/usr/bin/env python3
"""GitHub-runner-only end-to-end gate. Uses synthetic services, never user data."""
import argparse
import json
import re
import subprocess
import threading
import time
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PACKAGE = 'local.openwebui.client'
PARSER = argparse.ArgumentParser()
PARSER.add_argument('--output', required=True)
ARGS = PARSER.parse_args()
OUT = Path(ARGS.output)
OUT.mkdir(parents=True, exist_ok=True)
COUNT = 0
SNAPSHOTS = {}
SNAPSHOT_LOCK = threading.Lock()


def adb(*args, check=True):
    result = subprocess.run(['adb', *args], text=True, capture_output=True, timeout=35)
    if check and result.returncode:
        raise AssertionError(f'adb operation failed: {args[0]}')
    return result.stdout


def shell(command, check=True):
    return adb('shell', command, check=check)


def nodes(label='ui'):
    global COUNT
    COUNT += 1
    for _ in range(3):
        shell('uiautomator dump /sdcard/native-ui.xml', check=False)
        data = shell('cat /sdcard/native-ui.xml', check=False)
        try:
            root = ET.fromstring(data[data.index('<hierarchy'):])
            safe_label = re.sub(r'[^A-Za-z0-9_.-]', '-', label)
            (OUT / f'{COUNT:03}-{safe_label}.xml').write_text(data, encoding='utf-8')
            result = list(root.iter('node'))
            # Stock WebView accessibility can omit its virtual DOM after navigation.
            # The test service reports ONLY its own synthetic DOM geometry/state.
            # Real adb taps/keys still drive both web and native controls; no app
            # testing API or JS injection into a user's service is introduced.
            webviews = [n for n in result if n.get('class', '') == 'android.webkit.WebView']
            with SNAPSHOT_LOCK:
                snapshot = max(SNAPSHOTS.values(), key=lambda item: item['received'], default=None)
                if snapshot is not None:
                    snapshot = dict(snapshot)
            if webviews and snapshot and time.monotonic() - snapshot['received'] < 2:
                view = bounds(webviews[0])
                scale = (view[2] - view[0]) / snapshot['width']
                for entry in snapshot['entries']:
                    label, rect = entry['label'], entry['rect']
                    if rect[3] <= 0 or rect[1] >= snapshot['height']:
                        continue
                    physical = [int(view[0] + rect[0]*scale), int(view[1] + rect[1]*scale),
                                int(view[0] + rect[2]*scale), int(view[1] + rect[3]*scale)]
                    synthetic = ET.Element('node', {
                        'text': entry.get('text', label), 'content-desc': label,
                        'class': 'fixture-owned-dom-report',
                        'bounds': f'[{physical[0]},{physical[1]}][{physical[2]},{physical[3]}]',
                    })
                    result.append(synthetic)
                (OUT / 'fixture-state.json').write_text(json.dumps(snapshot), encoding='utf-8')
            return result
        except (ValueError, ET.ParseError):
            time.sleep(1)
    raise AssertionError('UNVERIFIED: Android native hierarchy unavailable')


def bounds(node):
    values = list(map(int, re.findall(r'-?\d+', node.get('bounds', ''))))
    assert len(values) == 4, 'UNVERIFIED: control bounds unavailable'
    return values


def text_state(items):
    return json.dumps([node.attrib for node in items], ensure_ascii=False)


def find(label, *, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for node in nodes(label.replace(' ', '-')[:30]):
            if label in (node.get('text'), node.get('content-desc')):
                return node
        time.sleep(1)
    raise AssertionError(f'UNVERIFIED: missing control {label}')


def tap_node(node):
    x1, y1, x2, y2 = bounds(node)
    shell(f'input tap {(x1+x2)//2} {(y1+y2)//2}')


def tap(label, **kwargs):
    tap_node(find(label, **kwargs))


def tap_any(labels, *, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for node in nodes('picker-controls'):
            if node.get('text') in labels or node.get('content-desc') in labels:
                tap_node(node)
                return
        time.sleep(1)
    raise AssertionError('UNVERIFIED: picker controls unavailable: ' + ', '.join(labels))


def save_to_downloads():
    tap_any(['Show roots', 'Show navigation drawer', 'Open navigation drawer'])
    tap_any(['Downloads', 'Download'])
    tap_any(['SAVE', 'Save'])
    time.sleep(2)


def enter(node, text):
    tap_node(node)
    shell('input keyevent KEYCODE_MOVE_END')
    # ADB key chords vary by image; use repeated DEL with a known upper bound.
    shell('input keyevent ' + ' '.join(['KEYCODE_DEL'] * 90))
    shell('input text ' + text)


def screenshot(label):
    data = subprocess.run(['adb', 'exec-out', 'screencap', '-p'], capture_output=True, timeout=30)
    assert data.returncode == 0
    (OUT / f'{label}.png').write_bytes(data.stdout)


def menu():
    tap('Client menu')


def settings():
    menu(); tap('Server address')
    return find('Server address')


def connect_to(address, *, confirm=False):
    enter(find('Server address'), address)
    shell('input keyevent KEYCODE_BACK')
    tap('CONNECT')
    if confirm:
        tap('CONTINUE')


def window_evidence(label):
    dump = shell('dumpsys window windows')
    (OUT / f'{label}-window.txt').write_text(dump, encoding='utf-8')
    return dump


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path != '/__fixture_state':
            self.send_error(404)
            return
        length = min(int(self.headers.get('Content-Length', '0')), 65536)
        state = json.loads(self.rfile.read(length))
        state['received'] = time.monotonic()
        with SNAPSHOT_LOCK:
            SNAPSHOTS[self.server.server_port] = state
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        port = self.server.server_port
        if self.path == '/api/config':
            body = json.dumps({'status': port != 8767}).encode()
            kind = 'application/json'
        else:
            # Data and page nonce prove cancellation does not reload or rebuild.
            body = f'''<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{{margin:0;background:#161616;color:white;font:18px sans-serif}}header{{padding:12px}} textarea{{display:block;width:90%;height:80px;font-size:18px}}button,a{{display:block;padding:14px;margin:8px}}main{{height:1300px}}footer{{position:fixed;bottom:0;background:#333;width:100%;height:44px}}</style>
<header id="fixture-header">Fixture header {port}</header><textarea id="draft" aria-label="Draft">draft-kept</textarea>
<button id="next-route" onclick="history.pushState({{}},'', '/next');document.querySelector('#route').textContent='Second route'">Next route</button><p id="route">First route</p>
<button id="download-fixture" onclick="let a=document.createElement('a');a.download='fixture.txt';a.href=URL.createObjectURL(new Blob(['fixture-download']));a.click()">Download fixture</button>
<button id="probe-native" onclick="window.__TAURI__.core.invoke('plugin:connection-controls|installNativeActions',{{actions:'__CHANNEL__:0'}}).then(()=>document.querySelector('#security').textContent='SECURITY FAILURE',()=>document.querySelector('#security').textContent='Native bridge denied')">Probe native bridge</button><p id="security"></p>
<output id="scroll-state" style="position:fixed;right:0;top:60px;font-size:10px">Scroll 0</output>
<script>onpopstate=()=>document.querySelector('#route').textContent=location.pathname==='/next'?'Second route':'First route';onscroll=()=>document.querySelector('#scroll-state').textContent='Scroll '+Math.round(scrollY);</script>
<main><span id="page-nonce">Page nonce: {time.time_ns()}</span></main><footer>Fixture bottom</footer>
<script>
function reportFixture() {{
  var entries = [];
  var selectors = {{'Fixture header {port}':'#fixture-header','Draft':'#draft','Next route':'#next-route',
    'Download fixture':'#download-fixture','Probe native bridge':'#probe-native'}};
  Object.keys(selectors).forEach(function(label) {{
    var element = document.querySelector(selectors[label]); var r = element.getBoundingClientRect();
    entries.push({{label:label,text:element.value || element.textContent,rect:[r.left,r.top,r.right,r.bottom]}});
  }});
  ['#route','#security','#scroll-state','#page-nonce'].forEach(function(selector) {{
    var element = document.querySelector(selector); var r = element.getBoundingClientRect();
    entries.push({{label:element.textContent,text:element.textContent,rect:[r.left,r.top,r.right,r.bottom]}});
  }});
  fetch('/__fixture_state', {{method:'POST',headers:{{'Content-Type':'application/json'}},
    body:JSON.stringify({{width:innerWidth,height:innerHeight,entries:entries}})}}).catch(function(){{}});
}}
setInterval(reportFixture, 250); reportFixture();
</script>'''.encode()
            kind = 'text/html; charset=utf-8'
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


SERVERS = []
for PORT in (8765, 8766, 8767):
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Fixture)
    SERVERS.append(server)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    adb('reverse', f'tcp:{PORT}', f'tcp:{PORT}')

try:
    shell(f'pm clear {PACKAGE}')
    shell(f'monkey -p {PACKAGE} -c android.intent.category.LAUNCHER 1')
    deadline = time.monotonic() + 30
    fields = []
    while time.monotonic() < deadline:
        fields = [n for n in nodes('local-ready') if n.get('class', '').endswith('EditText') and n.get('text', '').startswith('http')]
        if fields:
            break
        time.sleep(1)
    assert fields, 'UNVERIFIED: local address field or client JavaScript initialization unavailable'
    enter(fields[0], 'http://127.0.0.1:8765')
    shell('input keyevent KEYCODE_BACK')
    tap('Connect')
    find('Fixture header 8765', timeout=40)
    before = nodes('before-settings')
    nonce = next(n.get('text') for n in before if 'Page nonce:' in n.get('text', ''))
    assert 'draft-kept' in text_state(before), 'UNVERIFIED: fixture draft value unavailable'
    assert bounds(find('Client menu'))[2] - bounds(find('Client menu'))[0] >= 48
    assert bounds(find('Fixture header 8765'))[1] >= 0
    dump = window_evidence('immersive')
    # Both API families expose the app's requested system UI policy in dumpsys.
    app_blocks = [part for part in re.split(r'Window #\d+', dump) if PACKAGE in part]
    app_dump = '\n'.join(app_blocks)
    hidden = bool(re.search(r'\bFULLSCREEN\b', app_dump)) or any(
        int(value, 16) & 4 for value in re.findall(r'(?:mSystemUiVisibility|sysui)=(?:0x)?([0-9a-fA-F]+)', app_dump)
    ) or bool(re.search(r'(?:requestedVisibleTypes|Requested visible types|mRequestedVisibleTypes).*navigationBars(?![^\n]*statusBars)', app_dump, re.I))
    requested_masks = re.findall(r'mRequestedVisibleTypes=(0x[0-9a-fA-F]+|[0-9]+)\b', app_dump)
    hidden = hidden or any(int(value, 16 if value.startswith('0x') else 10) & 1 == 0 for value in requested_masks)
    assert hidden, 'UNVERIFIED: unable to prove the app requests hidden status bars'
    screenshot('connected-portrait')

    tap('Probe native bridge'); find('Native bridge denied')
    shell('input swipe 150 700 150 300 600'); time.sleep(1)
    scroll_state = next(n.get('text') for n in nodes('scrolled') if n.get('text', '').startswith('Scroll '))
    assert scroll_state != 'Scroll 0', 'UNVERIFIED: fixture did not scroll'
    field = settings()
    enter(field, 'http://127.0.0.1:8766')
    shell('input keyevent KEYCODE_BACK'); tap('CANCEL')
    after = nodes('after-cancel')
    assert scroll_state in text_state(after), 'Opening/cancelling settings changed scroll position'
    shell('input swipe 150 300 150 1000 600'); time.sleep(1)
    restored = nodes('scroll-restored')
    assert nonce in text_state(restored) and 'draft-kept' in text_state(restored), 'Opening/cancelling settings changed page state'

    # Native button drag persists across keyboard changes without reloading page.
    button = find('Client menu'); x1, y1, x2, y2 = bounds(button)
    x = (x1+x2)//2; y = (y1+y2)//2
    shell(f'input swipe {x} {y} {x} {max(80, y-160)} 700')
    drag_y = bounds(find('Client menu'))[1]
    assert abs(drag_y-y1) > 50, 'Menu button did not drag'
    tap('Draft'); time.sleep(2)
    screenshot('keyboard-visible')
    current = nodes('keyboard')
    draft = find('Draft')
    button = find('Client menu')
    keyboard_nodes = [n for n in current if n.get('package', '').startswith(('com.google.android.inputmethod', 'com.android.inputmethod'))]
    assert keyboard_nodes, 'UNVERIFIED: software keyboard not exposed'
    keyboard_top = min(bounds(n)[1] for n in keyboard_nodes if bounds(n)[3] > bounds(n)[1])
    assert bounds(draft)[3] <= keyboard_top, 'Draft covered by keyboard'
    assert bounds(button)[3] <= keyboard_top, 'Menu covered by keyboard'
    shell('input keyevent KEYCODE_BACK'); time.sleep(2)
    assert abs(bounds(find('Client menu'))[1] - drag_y) <= 4, 'Keyboard overwrote saved menu position'

    # Standard Back traverses only the current service, then backgrounds the app.
    tap('Next route'); find('Second route')
    shell('input keyevent KEYCODE_BACK'); find('First route')
    shell('input keyevent KEYCODE_BACK'); time.sleep(2)
    focused = shell('dumpsys activity activities')
    assert not any(PACKAGE in line for line in focused.splitlines() if 'ResumedActivity' in line), 'Root Back did not background app'
    shell(f'monkey -p {PACKAGE} -c android.intent.category.LAUNCHER 1')
    find('Fixture header 8765')

    # Exercise a real emulated cutout, not a hard-coded top padding assumption.
    overlay_list = shell('cmd overlay list')
    available = re.findall(r'com\.android\.internal\.display\.cutout\.emulation\.[a-z]+', overlay_list)
    cutout_overlay = next((item for item in available if item.endswith('.tall')), None)
    if cutout_overlay is None:
        cutout_overlay = next((item for item in available if item.endswith('.corner')), None)
    assert cutout_overlay, 'UNVERIFIED: no cutout emulation overlay available'
    shell(f'cmd overlay enable {cutout_overlay}')
    time.sleep(3)
    find('Client menu')
    assert bounds(find('Fixture header 8765'))[1] > 0, 'Header entered emulated cutout'
    screenshot('display-cutout')
    shell(f'cmd overlay disable {cutout_overlay}')
    time.sleep(3)

    # Rotate without introducing remote CSS or destroying the client chrome.
    shell('settings put system accelerometer_rotation 0')
    shell('settings put system user_rotation 1'); time.sleep(3)
    find('Client menu'); screenshot('landscape'); window_evidence('landscape')
    shell('settings put system user_rotation 0'); time.sleep(3)
    find('Client menu')

    settings(); connect_to('http://127.0.0.1:8766', confirm=True)
    find('Fixture header 8766', timeout=40); find('Client menu')
    settings(); connect_to('http://127.0.0.1:8767', confirm=True)
    find('Reopen previous server', timeout=45)
    screenshot('connection-failed')
    tap('Reopen previous server')
    find('Fixture header 8766', timeout=40)
    settings(); tap('CANCEL')
    shell(f'am force-stop {PACKAGE}')
    shell(f'monkey -p {PACKAGE} -c android.intent.category.LAUNCHER 1')
    find('Fixture header 8766', timeout=40)
    assert abs(bounds(find('Client menu'))[1] - drag_y) <= 6, 'Menu preference did not persist across restart'

    # Reload must warn; cancelling keeps the exact document nonce.
    nonce = next(n.get('text') for n in nodes() if 'Page nonce:' in n.get('text', ''))
    menu(); tap('Reload'); find('Leave this page?'); tap('CANCEL')
    assert nonce in text_state(nodes()), 'Cancelled reload changed document'
    menu(); tap('Reload'); tap('CONTINUE')
    time.sleep(3)
    assert nonce not in text_state(nodes()), 'Confirmed reload did not reload document'

    # SAF is entered only after a real native menu click. Cancelling is non-destructive.
    menu(); tap('Export Android diagnostics'); time.sleep(2)
    screenshot('diagnostics-picker')
    shell('input keyevent KEYCODE_BACK'); time.sleep(2)
    find('Fixture header 8766'); find('Client menu')
    menu(); tap('Export Android diagnostics'); time.sleep(2)
    save_to_downloads()
    report = shell('cat /sdcard/Download/android-diagnostics.txt')
    assert report and '127.0.0.1' not in report and 'http://' not in report, 'Diagnostic privacy regression'
    tap('Download fixture'); time.sleep(2)
    shell('input keyevent KEYCODE_BACK'); time.sleep(2)
    find('Client menu')
    tap('Download fixture'); time.sleep(2)
    save_to_downloads()
    assert shell('cat /sdcard/Download/fixture.txt').strip() == 'fixture-download', 'Downloaded payload changed'
    screenshot('native-experience-pass')
    window_evidence('final')
    (OUT / 'native-experience-result.txt').write_text('PASS: native menu, immersive request, fixture bridge denial, non-destructive settings, keyboard, drag, Back, rotation, switch, timeout recovery, reload and SAF diagnostic/download save and cancellation.\n', encoding='utf-8')
    print('ANDROID_NATIVE_EXPERIENCE_PASS')
except Exception:
    screenshot('failure')
    window_evidence('failure')
    nodes('failure')
    (OUT / 'failure-logcat.txt').write_text(adb('logcat', '-d', '-t', '2000'), encoding='utf-8')
    raise
finally:
    for server in SERVERS:
        server.shutdown()
    shell('settings put system user_rotation 0', check=False)
    if 'cutout_overlay' in globals() and cutout_overlay:
        shell(f'cmd overlay disable {cutout_overlay}', check=False)
    for port in (8765, 8766, 8767):
        adb('reverse', '--remove', f'tcp:{port}', check=False)
