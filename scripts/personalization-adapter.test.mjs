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
    querySelector:selector=>selector==='#messages-container'?messages:selector==='#chat-input'?{}:null,
  });
  const document = {
    documentElement:root,
    head:root,
    querySelector:()=>chat,
    querySelectorAll:selector=>selector==='[data-owc-appearance-surface]'
      ? [body,shell,opaqueInner,chat].filter(item=>surfaces.has(item.name))
      : [],
    getElementById:id=>styles.get(id),
    createElement:()=>({remove(){styles.delete(this.id);}}),
  };
  const location = {origin:'https://chat.example',pathname:'/c/one',search:''};
  const invoke = request=>JSON.parse(JSON.stringify(vm.runInNewContext(`(${source})(${JSON.stringify({origin:location.origin,navigation:true,config:{enabled:true,accent:'#123456',dark:true},...request})})`,{document,location,getComputedStyle:defaultView.getComputedStyle})));
  return {invoke,styles,attributes,surfaces,location,document,replace:()=>{rows=[row('message-3','Other branch')];},jumped:()=>jumped};
}
test('supported page styles apply idempotently and removal restores host attributes',()=>{
  const f=fixture(); assert.equal(f.invoke().supported,true); f.invoke(); assert.equal(f.styles.size,1);
  assert.ok(f.styles.values().next().value.textContent.includes('monospace'));
  assert.match(
    f.styles.values().next().value.textContent,
    /#chat-container :is\(nav, #message-input, #message-input-container/,
  );
  assert.match(
    f.styles.values().next().value.textContent,
    /#messages-container \{ background-color:transparent!important; background-image:none!important; \}/,
  );
  assert.doesNotMatch(
    f.styles.values().next().value.textContent,
    /#messages-container,\s*html\[[^\n]+backgroundColor:rgba/,
  );
  assert.deepEqual([...f.surfaces.keys()].sort(),['chat','opaque-inner']);
  f.invoke({config:{enabled:false}}); assert.equal(f.styles.size,0); assert.equal(f.attributes.size,0); assert.equal(f.surfaces.size,0);
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
