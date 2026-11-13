// Диагностика UI-обработчиков без браузера. FAIL фиксирует текущий дефект, а не сбой стенда.
import fs from 'node:fs';
import vm from 'node:vm';
let passed=0, failed=0;
function check(name,condition,evidence){console.log(`${condition?'PASS':'FAIL'} ${name}: ${JSON.stringify(evidence)}`);condition?passed++:failed++;}
const values=new Map();
const button={textContent:'',addEventListener(event,fn){this[event]=fn;}};
const context=vm.createContext({document:{createElement(){return button;}},localStorage:{getItem(k){return values.get(k)||null;},setItem(k,v){values.set(k,v);}},window:{}});
const sounds=fs.readFileSync(new URL('../client/shared/sounds.js',import.meta.url),'utf8').replaceAll('export function','function');
vm.runInContext(sounds+'\nvar testButton=muteButton(); testButton.click();',context);
check('mute-click',values.get('sigame:muted')==='1'&&button.textContent==='🔇',{stored:values.get('sigame:muted')||null,label:button.textContent});
const editor=fs.readFileSync(new URL('../client/packs/packs.js',import.meta.url),'utf8');
const dndSource=editor.slice(editor.indexOf('function dnd('),editor.indexOf('function reorder('));
const drag=vm.createContext({});vm.runInContext(dndSource,drag);
function el(id){return {dataset:{dndId:id},classList:{add(){},remove(){}},handlers:{},addEventListener(name,fn){this.handlers[name]=fn;}};}
const question=el('q0:0:0'),theme=el('t0:0'),round=el('r0');
for(const element of [question,theme,round])drag.dnd(element,{onDrop(){}});
let transferred;let stopped=false;
const event={dataTransfer:{setData(_type,value){transferred=value;}},stopPropagation(){stopped=true;}};
for(const element of [question,theme,round]){element.handlers.dragstart(event);if(stopped)break;}
check('question-drag-bubbling',transferred==='q0:0:0',{expected:'q0:0:0',actual:transferred});
console.log(`Итого UI-аудит: ${passed} пройдено, ${failed} проблем`);process.exitCode=failed?1:0;
