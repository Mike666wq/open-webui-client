import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../src-tauri/plugins/connection-controls/android/src/main/assets/personalization.js', import.meta.url), 'utf8');
function fixture() {
  const styles = new Map(); const attributes = new Map();
  let rows = [row('message-1','First question'), row('message-2','Long question <script>never execute</script>')];
  let jumped = '';
  function row(id,text) { return { id, hidden:false, getAttribute:()=>null, querySelector:()=>({textContent:text}), scrollIntoView:()=>{jumped=id;} }; }
  const messages = {querySelectorAll:()=>rows};
  const chat = {querySelector:selector=>selector==='#messages-container'?messages:selector==='#chat-input'?{}:null};
  const root = {setAttribute:(k,v)=>attributes.set(k,v), removeAttribute:k=>attributes.delete(k), hasAttribute:k=>attributes.has(k), appendChild:node=>styles.set(node.id,node)};
  const document = {documentElement:root,head:root, querySelector:()=>chat, getElementById:id=>styles.get(id), createElement:()=>({remove(){styles.delete(this.id);}})};
  const location = {origin:'https://chat.example',pathname:'/c/one',search:''};
  const invoke = request=>JSON.parse(JSON.stringify(vm.runInNewContext(`(${source})(${JSON.stringify({origin:location.origin,navigation:true,config:{enabled:true,accent:'#123456',dark:true},...request})})`,{document,location})));
  return {invoke,styles,attributes,location,document,replace:()=>{rows=[row('message-3','Other branch')];},jumped:()=>jumped};
}
test('supported page styles apply idempotently and removal restores host attributes',()=>{
  const f=fixture(); assert.equal(f.invoke().supported,true); f.invoke(); assert.equal(f.styles.size,1);
  assert.ok(f.styles.values().next().value.textContent.includes('monospace'));
  f.invoke({config:{enabled:false}}); assert.equal(f.styles.size,0); assert.equal(f.attributes.size,0);
});
test('login, administration, unknown pages and wrong origins are untouched',()=>{
  for(const pathname of ['/auth','/admin','/workspace','/c/id/other']) {
    const f=fixture(); f.invoke(); f.location.pathname=pathname;
    assert.equal(f.invoke().supported,false); assert.equal(f.styles.size,0); assert.equal(f.attributes.size,0);
  }
  const f=fixture(); assert.equal(f.invoke({origin:'https://other.example'}).supported,false);
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
