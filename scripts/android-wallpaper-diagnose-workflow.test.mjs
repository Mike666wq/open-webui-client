import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('wallpaper diagnosis is isolated from both quick checks and APK releases', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/android-wallpaper-diagnose.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /name: Android wallpaper diagnosis/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /branches:\s*\n\s*- codex\/android-wallpaper-diagnose\s*\n\s*- codex\/android-wallpaper-preview-fix/);
  assert.match(workflow, /system-images;android-36;google_apis;x86_64/);
  assert.doesNotMatch(workflow, /branches:\s*\n\s*- main/);
  assert.doesNotMatch(workflow, /windows-|macos-|release-orchestrator\.mjs publish/);
  assert.match(workflow, /android-wallpaper-diagnose\.py/);
  assert.match(workflow, /android-wallpaper-evidence/);
});

test('wallpaper diagnosis contains a real import, visual assertion and persistence check', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/android-wallpaper-diagnose.yml', import.meta.url),
    'utf8',
  );
  const script = await readFile(
    new URL('./android-wallpaper-diagnose.py', import.meta.url),
    'utf8',
  );
  const fixture = await readFile(
    new URL('./fixtures/personalization/android.html', import.meta.url),
    'utf8',
  );
  assert.match(script, /ACTION_OPEN_DOCUMENT|Choose image/);
  assert.match(script, /ImageMagick RMSE|compare.*RMSE/s);
  assert.match(script, /def wait_for_web_page/);
  assert.match(script, /Connected WebView did not render/);
  assert.match(script, /fixture-events\.json/);
  assert.match(script, /__fixture_state/);
  assert.match(fixture, /invokeType/);
  assert.match(script, /def ensure_device_root/);
  assert.match(script, /def ensure_fixture_reverse/);
  assert.match(script, /adb root restarts the daemon/);
  const connection = await readFile(
    new URL('../src-tauri/src/connection.rs', import.meta.url),
    'utf8',
  );
  assert.match(connection, /typeof core\?\.invoke==='function'/);
  assert.match(script, /\.pixels\.txt/);
  assert.match(script, /preview the file/);
  assert.match(script, /not is_preview_action/);
  assert.match(script, /Appearance image import failed/);
  assert.match(script, /"dim": 0/);
  assert.doesNotMatch(script, /"dim": 30/);
  assert.match(script, /and local_image\s+and apply is not None/s);
  assert.match(script, /content-desc.*Wallpaper preview|Wallpaper preview/s);
  assert.match(script, /appearance_enabled/);
  assert.match(script, /def screenshot_wallpaper_metrics/);
  assert.match(script, /wallpaper-visible-contract-passed/);
  assert.match(script, /wallpaper_saturation/);
  assert.match(script, /saturation < 0\.20/);
  assert.match(script, /new-chat-wallpaper-passed/);
  assert.match(script, /restored-chat-wallpaper-passed/);
  assert.match(script, /new_chat_saturation/);
  assert.match(script, /restored_chat_saturation/);
  assert.match(script, /assert_fixture_glass/);
  assert.match(script, /same_document/);
  assert.match(script, /tap_fixture_control\(output, "new-chat"/);
  assert.doesNotMatch(script, /am start -a android.intent.action.VIEW/);
  assert.doesNotMatch(script, /OWC-LAYERS/);
  assert.match(script, /install_reported_config/);
  assert.match(script, /haslib\.sha256|hashlib\.sha256/);
  assert.match(script, /node\.get\("text", ""\) == "Appearance & reading"/);
  assert.doesNotMatch(script, /"choose image" in labels/);
  assert.doesNotMatch(script, /find\(output, "Wallpaper fixture 8765"/);
  assert.match(script, /appearance-config\.json/);
  assert.match(script, /Persisted appearance config or decoded JPEG was not found/);
  assert.match(script, /failure-logcat\.txt/);
  assert.match(script, /def tap_after_scroll/);
  assert.match(script, /set_slider_to_start/);
  assert.match(fixture, /#app \{ height: 100dvh; background: #fff; \}/);
  assert.match(fixture, /#chat-container \{ background: #fff; \}/);
  assert.doesNotMatch(fixture, /background: transparent; \}/);
  assert.match(workflow, /src-tauri\/src\/connection\.rs/);
});

test('Android fixture runs real button navigation without messages on the new-chat route', async () => {
  const html = await readFile(new URL('./fixtures/personalization/android.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'Fixture must include its reporting and navigation script');
  const reports = [];
  let currentPath = '/';
  let nodes;
  const shell = {
    get innerHTML() { return 'conversation'; },
    set innerHTML(value) { assert.equal(value, 'conversation'); mountConversation(); },
  };
  function mountConversation() {
    nodes = Object.fromEntries(['new-chat','restore-chat','messages-container','chat-input','chat-pane','message-input-container'].map(id => [
      id, { value:'wallpaper diagnostic', getBoundingClientRect:()=>({left:0,top:0,right:48,bottom:48}), remove(){delete nodes[id];} },
    ]));
    nodes['chat-pane'].insertBefore = node => { nodes[node.id] = node; };
  }
  mountConversation();
  const context = {
    window:{},
    innerWidth:400, innerHeight:800,
    document:{
      readyState:'complete',
      documentElement:{hasAttribute:()=>true},
      querySelector:selector=>selector === '.app > div' ? shell : {},
      getElementById:id=>nodes[id],
      createElement:()=>({}),
    },
    location:{get href(){return `http://127.0.0.1:8765${currentPath}`;},get pathname(){return currentPath;}},
    history:{pushState:(_,__,path)=>{currentPath=path;},replaceState:(_,__,path)=>{currentPath=path;}},
    getComputedStyle:()=>({backgroundColor:'rgba(0, 0, 0, 0)',backgroundImage:'none'}),
    fetch:(_,options)=>{reports.push(JSON.parse(options.body));return Promise.resolve();},
    setInterval:()=>{},
  };
  new vm.Script(script).runInNewContext(context);
  const originalNonce = reports.at(-1).nonce;
  assert.equal(reports.at(-1).path, '/c/original');
  assert.equal(reports.at(-1).hasMessages, true);
  nodes['new-chat'].onclick();
  assert.equal(reports.at(-1).path, '/');
  assert.equal(reports.at(-1).hasMessages, false);
  assert.equal(reports.at(-1).hasInput, true);
  nodes['restore-chat'].onclick();
  assert.equal(reports.at(-1).path, '/c/restored');
  assert.equal(reports.at(-1).hasMessages, true);
  assert.ok(reports.every(report=>report.nonce === originalNonce));
});
