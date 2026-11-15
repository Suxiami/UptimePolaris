import assert from 'node:assert/strict';
import { build } from 'esbuild';

const mocks = {
  'react/jsx-runtime': `export const jsx=(type,props)=>({type,props}); export const jsxs=jsx;`,
  '@heroui/react': `export const Input='input';`,
  'use-intl': `export const useTranslations=()=>key=>key;`,
};
const result = await build({entryPoints:['frontend/src/admin/themes/ThemeColorOption.tsx'],bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',plugins:[{name:'color-fixture',setup(b){b.onResolve({filter:/.*/},args=>Object.hasOwn(mocks,args.path)?{path:args.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks[args.path],loader:'js'}));}}]});
const {ThemeColorOption}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const changes=[];
const option={key:'accent',label:'Accent',type:'color',default:'#6366F1'};
const render=value=>ThemeColorOption({option,value,onChange:next=>changes.push(next)});
let control=render('#386be8');
assert.equal(control.props.isInvalid,false);
assert.equal(control.props.type,undefined);
const picker=control.props.startContent.props.children;
assert.equal(picker.props.type,'color');
assert.equal(picker.props['aria-label'],'Accent');
picker.props.onChange({target:{value:'#aabbcc'}});
assert.equal(changes.pop(),'#AABBCC');
control.props.onValueChange('bad');
assert.equal(changes.pop(),'bad');
assert.equal(render('bad').props.isInvalid,true);
assert.equal(render('bad').props.errorMessage,'optionColorInvalid');
control.props.onValueChange('');
assert.equal(changes.pop(),undefined);
assert.equal(render(undefined).props.isInvalid,false);
console.log('PASS theme color control: picker, HEX input, invalid feedback and clear-to-default');
