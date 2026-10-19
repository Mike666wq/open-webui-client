import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../src-tauri/plugins/connection-controls/android/src/main/assets/personalization.js', import.meta.url), 'utf8');
function fixture() {
  const styles = new Map(); const attributes = new Map();
  const surfaces = new Map();
  let rows = [row('message-1','First question'), row('message-2','Long question <script>never execute</script>')];
  let jumped = '';
  function row(id,text) { return { id, hidden:false, getAttribute:()=>null, querySelector:()=>({textContent:text}), scrollIntoView:()=>{jumped=id;} }; }
  function node(name,parentElement=null) {
    return {
      name,
      parentElement,
      setAttribute:key=>surfaces.set(name,key),
      removeAttribute:key=>{if(surfaces.get(name)===key) surfaces.delete(name);},
    };
  }
  const messages = {querySelectorAll:()=>rows};
  let detachMessages=false;
  const defaultView = {getComputedStyle:item=>({
    backgroundColor:item.name.startsWith('opaque') ? 'rgb(255, 255, 255)' : 'rgba(0, 0, 0, 0)',
    backgroundImage:'none',
  })};
  const root = Object.assign(node('html'), {
    setAttribute:(k,v)=>attributes.set(k,v), removeAttribute:k=>attributes.delete(k),
    hasAttribute:k=>attributes.has(k),
    appendChild:node=>styles.set(node.id,node),
  });
  const body = node('body', root);
  const shell = node('shell', body);
  const opaqueInner = Object.assign(node('opaque-inner', shell), {
    ownerDocument:{defaultView:defaultView},
  });
  const chat = Object.assign(node('chat', opaqueInner), {
    ownerDocument:{defaultView:defaultView},
    querySelector:selector=>selector==='#messages-container'?(detachMessages?null:messages):selector==='#chat-input'?{}:null,
  });
  const document = {
    documentElement:root,
    head:root,
    querySelector:selector=>selector==='.app'?shell:selector==='#chat-container'?chat:null,
    querySelectorAll:selector=>selector==='[data-owc-appearance-surface]'
      ? [body,shell,opaqueInner,chat].filter(item=>surfaces.has(item.name))
      : [],
    getElementById:id=>styles.get(id),
    createElement:()=>({remove(){styles.delete(this.id);}}),
  };
  const location = {origin:'https://chat.example',pathname:'/c/one',search:''};
  const invoke = request=>JSON.parse(JSON.stringify(vm.runInNewContext(`(${source})(${JSON.stringify({origin:location.origin,navigation:true,config:{enabled:true,accent:'#123456',dark:true},...request})})`,{document,location,getComputedStyle:defaultView.getComputedStyle})));
  return {invoke,styles,attributes,surfaces,location,document,chat,replace:()=>{rows=[row('message-3','Other branch')];},jumped:()=>jumped,clearMessages:()=>{detachMessages=true;},restoreMessages:()=>{detachMessages=false;},messagesPresent:()=>!detachMessages};
}
test('supported page styles apply idempotently and removal restores host attributes',()=>{
  const f=fixture(); assert.equal(f.invoke().supported,true); f.invoke(); assert.equal(f.styles.size,1);
  assert.ok(f.styles.values().next().value.textContent.includes('monospace'));
  const css=f.styles.values().next().value.textContent;
  assert.match(css, /#chat-container :is\(nav, #message-input-container, \.user-message \.rounded-3xl, \.chat-assistant\)/);
  assert.match(css, /backdrop-filter:blur\(18px\) saturate\(145%\)!important/);
  assert.match(css, /border:1px solid rgba\(255,255,255,\.10\)!important/);
  assert.match(css, /#chat-input-container,\.ProseMirror,textarea\) \{ background-color:transparent!important; background-image:none!important; \}/);
  assert.match(
    f.styles.values().next().value.textContent,
    /#messages-container \{ background-color:transparent!important; background-image:none!important; \}/,
  );
  assert.doesNotMatch(
    f.styles.values().next().value.textContent,
    /#messages-container,\s*html\[[^\n]+backgroundColor:rgba/,
  );
  assert.deepEqual([...f.surfaces.keys()].sort(),['chat','opaque-inner','shell']);
  f.invoke({config:{enabled:false}}); assert.equal(f.styles.size,0); assert.equal(f.attributes.size,0); assert.equal(f.surfaces.size,0);
});
test('both themes protect reply text without stacking glass on nested input containers',()=>{
  for(const dark of [false,true]) {
    const f=fixture(); f.invoke({config:{enabled:true,dark,opacity:50}});
    const css=f.styles.values().next().value.textContent;
    assert.match(css,/\.chat-assistant \{ box-sizing:border-box; border-radius:20px; padding:14px 16px/);
    assert.ok(css.includes(`background-color:rgba(${dark?'17,19,24':'248,250,252'},0.5)`));
    assert.ok(css.includes(dark?'rgba(0,0,0,.24)':'rgba(255,255,255,.38)'));
    assert.doesNotMatch(css,/:is\(nav,[^\n]*#chat-input-container/);
    assert.match(css,/:not\(pre\) > code/);
  }
});
test('glass parameters map and clamp without CSS injection',()=>{
  const f=fixture(); f.invoke({config:{enabled:true,dark:true,opacity:10,glassBlur:80,radius:100,codeTone:'glasses;}}body{display:none'}});
  const css=f.styles.values().next().value.textContent;
  assert.ok(css.includes('background-color:rgba(17,19,24,0.4)'));
  assert.ok(css.includes('backdrop-filter:blur(30px) saturate(145%)'));
  assert.ok(css.includes('border-radius:28px'));
  assert.ok(!css.includes('body{display:none'));
  f.invoke({config:{enabled:true,dark:true,opacity:50,glassBlur:0,radius:0,codeTone:'opaque'}});
  const opaque=f.styles.values().next().value.textContent;
  assert.ok(opaque.includes('border-radius:0px'));
  assert.ok(opaque.includes('background:#20242c'));
  f.invoke({config:{enabled:true,dark:true,opacity:80,glassBlur:24,radius:16,codeTone:'glass'}});
  const glass=f.styles.values().next().value.textContent;
  assert.ok(glass.includes('backdrop-filter:blur(24px) saturate(145%)'));
  assert.ok(glass.includes('border-radius:16px'));
  assert.ok(glass.includes('background:rgba(17,19,24,0.6)'));
});
test('new chat root keeps the glass shell before messages exist and after returning to a conversation',()=>{
  const f=fixture(); f.clearMessages(); f.location.pathname='/';
  const empty=f.invoke();
  assert.equal(empty.supported,true); assert.equal(empty.entries.length,0); assert.equal(f.styles.size,1);
  assert.ok(f.surfaces.has('shell'));
  f.location.pathname='/c/restored'; f.restoreMessages();
  const restored=f.invoke();
  assert.equal(restored.supported,true); assert.equal(restored.entries.length,2);
  assert.equal(f.styles.size,1);
});

test('login, administration, unknown pages and wrong origins are untouched',()=>{
  for(const pathname of ['/auth','/admin','/workspace']) {
    const f=fixture(); f.invoke(); f.location.pathname=pathname;
    assert.equal(f.invoke().supported,false); assert.equal(f.styles.size,0); assert.equal(f.attributes.size,0);
  }
  const f=fixture(); assert.equal(f.invoke({origin:'https://other.example'}).supported,false);
});
test('current and compatible nested routes remain supported without the exact root path',()=>{
  const f=fixture();
  f.location.pathname='/c/one/branch';
  assert.equal(f.invoke().supported,true);
});
test('directory only returns mounted questions and rejects stale branch and route jumps',()=>{
  const f=fixture(); const snapshot=f.invoke({config:{enabled:false}});
  assert.equal(snapshot.entries.length,2); assert.equal(f.styles.size,0);
  assert.equal(f.invoke({...snapshot,jump:'message-1'}).jumped,true);
  f.replace(); assert.equal(f.invoke({...snapshot,jump:'message-1'}).jumped,false);
  const next=f.invoke(); assert.equal(next.entries.length,1); assert.equal(next.entries[0].id,'message-3');
  f.location.pathname='/c/two'; assert.equal(f.invoke({...next,jump:'message-3'}).jumped,false);
});
test('request values cannot inject CSS and reading ranges are bounded',()=>{
  const f=fixture(); f.invoke({config:{enabled:true,accent:'red;}body{display:none',opacity:-5,fontSize:900,lineHeight:999}});
  const css=f.styles.values().next().value.textContent;
  assert.ok(!css.includes('body{display:none')); assert.ok(css.includes('font-size:24px')); assert.ok(css.includes('line-height:2.1'));
});

test('unknown structure and disabled directory do not expose message summaries',()=>{
  const f=fixture(); assert.equal(f.invoke({navigation:false}).entries.length,0);
  f.document.querySelector=()=>null; assert.equal(f.invoke().supported,false); assert.equal(f.styles.size,0);
});
