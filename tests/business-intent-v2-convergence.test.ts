import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { r04V2 } from './fixtures/business-intent-v2-r04.js';
import { compileBusinessIntentV2ToGraphIR } from '../src/modules/graph-ir/business-intent-v2-compiler.js';
import { businessIntentV2Schema } from '../src/modules/ai/semantic-process.js';
import { validateGraphIR } from '../src/modules/graph-ir/graph-ir.js';
import { lowerGraphIRToProcessSpec } from '../src/modules/graph-ir/processspec.adapter.js';
import { validateProcessSpec } from '../src/modules/validation/validation.service.js';

const compiled=await compileBusinessIntentV2ToGraphIR(r04V2);
function path(labels:string[],value:number,manager:string|string[]='approved',director='approved',finance:string|string[]='confirmed'){
  const g=compiled.graph!;const byId=new Map(g.nodes.map(n=>[n.id,n]));const vars=new Map(g.variables.map(v=>[v.id,g.formRefs.flatMap(f=>f.fields).find(field=>field.bindTo===v.id)?.label||v.key]));const out=new Map<string,typeof g.edges>();for(const e of g.edges)out.set(e.source,[...(out.get(e.source)||[]),e]);const visits=new Map<string,number>();
  const walk=(node:string,seen:string[],steps:number):string[]=>{assert.ok(steps<40,'path traversal bounded');const current=byId.get(node)!;if(current.type==='end')return[...seen,current.name];const edges=out.get(node)||[];const selected=new Map<string,unknown>();const eligible=edges.filter(e=>{if(!e.condition)return true;const c=e.condition as any;const variable=vars.get(c.left?.var)||vars.get(c.right?.var);if(!selected.has(variable)){let actual:any=variable==='Valor'?value:variable==='Decisão do Gestor'?manager:variable==='Decisão do Diretor'?director:finance;if(Array.isArray(actual)){const index=visits.get(variable)||0;visits.set(variable,index+1);actual=actual[Math.min(index,actual.length-1)];}selected.set(variable,actual);}const actual=selected.get(variable);const expected=c.right?.literal??c.left?.literal;switch(c.op){case'eq':return actual===expected;case'gt':return actual>expected;case'lte':return actual<=expected;default:return false;}});assert.equal(eligible.length,1,`rota única em ${current.name}, elegíveis=${eligible.map(e=>e.label)}`);const edge=eligible[0];return walk(edge.target,[...seen,...(edge.label?[edge.label]:[]),...(current.type==='humanTask'?[current.name]:[])],steps+1);};return walk(g.nodes.find(n=>n.type==='start')!.id,[],0);
}

test('P0.3 R04 completo compila a mesma atividade financeira compartilhada e ambos os loops',async()=>{
  assert.equal(compiled.valid,true,JSON.stringify(compiled.diagnostics));const g=compiled.graph!;
  assert.equal(g.nodes.filter(n=>n.type==='humanTask').length,6);assert.equal(g.nodes.filter(n=>n.name==='Conferir e processar reembolso').length,1);
  const returns=g.edges.filter(e=>e.kind==='loop-back');assert.equal(returns.length,2);
  const pairs=returns.map(e=>[g.nodes.find(n=>n.id===e.source)?.name,g.nodes.find(n=>n.id===e.target)?.name]);assert.deepEqual(pairs,[['Corrigir dados de pagamento','Conferir e processar reembolso'],['Corrigir solicitação','Analisar solicitação']]);
  assert.ok(returns.every(e=>e.requirementRefs.length>0));assert.ok(returns.every(e=>g.requirements.some(r=>e.requirementRefs.includes(r.id)&&r.kind==='loop'&&r.sourceNodeId===e.source&&r.targetNodeId===e.target)));
  assert.equal(g.edges.some(e=>g.nodes.find(n=>n.id===e.source)?.type==='end'),false);
  const finance=g.nodes.find(n=>n.name==='Conferir e processar reembolso')!;const financeIncoming=g.edges.filter(e=>e.target===finance.id);assert.equal(financeIncoming.length,3);assert.equal(financeIncoming.filter(e=>e.kind==='sequence').length,2);assert.ok(financeIncoming.filter(e=>e.kind==='sequence').every(e=>g.nodes.find(n=>n.id===e.source)?.type==='exclusiveGateway'));assert.equal(financeIncoming.filter(e=>e.kind==='loop-back').length,1);assert.equal(g.nodes.some(n=>n.type==='parallelGateway'),false);
  const amountBindings=g.formRefs.flatMap(f=>f.fields.filter(field=>field.label==='Valor').map(field=>field.bindTo));assert.equal(amountBindings.length,2);assert.equal(new Set(amountBindings).size,1,'Valor do início e Valor corrigido atualizam a mesma variável semântica.');
  assert.deepEqual(path([],1999.99).filter(x=>x==='Aprovar reembolso'),[]);assert.ok(path([],1999.99).includes('Conferir e processar reembolso'));
  assert.ok(path([],2000).includes('Conferir e processar reembolso'));assert.ok(!path([],2000).includes('Aprovar reembolso'));
  assert.ok(path([],2000.01).includes('Aprovar reembolso'));assert.ok(path([],2000.01).includes('Conferir e processar reembolso'));
  assert.equal(path([],2000,'rejected').at(-1),'Reprovado');assert.ok(!path([],2000,'rejected').includes('Conferir e processar reembolso'));
  assert.equal(path([],2000.01,'approved','rejected').at(-1),'Reprovado');assert.ok(!path([],2000.01,'approved','rejected').includes('Conferir e processar reembolso'));
  const low=path([],2000), high=path([],2000.01);assert.equal(low.filter(x=>x==='Conferir e processar reembolso').length,1);assert.equal(high.filter(x=>x==='Aprovar reembolso').length,1);assert.equal(high.filter(x=>x==='Analisar solicitação').length,1);
  const financeCorrection=path([],2000,'approved','approved',['correction','confirmed']);assert.ok(financeCorrection.includes('Corrigir dados de pagamento'));assert.equal(financeCorrection.filter(x=>x==='Conferir e processar reembolso').length,2);assert.equal(financeCorrection.filter(x=>x==='Analisar solicitação').length,1);assert.equal(financeCorrection.includes('Aprovar reembolso'),false);
  const managerCorrection=path([],2000.01,['correction','approved']);assert.ok(managerCorrection.includes('Corrigir solicitação'));assert.equal(managerCorrection.filter(x=>x==='Analisar solicitação').length,2);assert.ok(managerCorrection.includes('Aprovar reembolso'),'Após corrigir, o Gestor reavalia e o valor atualizado acima de 2000 segue ao Diretor.');
  assert.equal(validateGraphIR(g).valid,true);const lowered=await lowerGraphIRToProcessSpec(g);assert.equal(lowered.valid,true,JSON.stringify(lowered.diagnostics));assert.equal((await validateProcessSpec(lowered.processSpec)).valid,true);
  assert.equal(compiled.processSpec?.nodes.filter((n:any)=>n.name==='Conferir e processar reembolso').length,1);assert.equal(compiled.evidence.interpretationCompleteness,'not-measured');
});

test('P0.3 rejeita referências ausentes, ambíguas e campo de decisão sem resolução única',async()=>{
  const missing=structuredClone(r04V2);missing.activities[0].next={kind:'activity',activityRef:'ghost'};const a=await compileBusinessIntentV2ToGraphIR(missing);assert.equal(a.valid,false);assert.ok(a.diagnostics.some(d=>d.code==='BUSINESS_V2_REFERENCE_MISSING'));
  const ambiguous=structuredClone(r04V2);ambiguous.activities[5].ref='registrar_solicitacao';const b=await compileBusinessIntentV2ToGraphIR(ambiguous);assert.equal(b.valid,false);assert.ok(b.diagnostics.some(d=>d.code==='BUSINESS_V2_REFERENCE_AMBIGUOUS'));
  const field=structuredClone(r04V2);field.startFields[0].type='text';const c=await compileBusinessIntentV2ToGraphIR(field);assert.equal(c.valid,false);assert.ok(c.diagnostics.some(d=>d.code==='BUSINESS_V2_FIELD_AMBIGUOUS'));
});

test('BusinessIntent V2 tem schema versionado apenas com referências e sem identidade técnica',()=>{
  const schema=businessIntentV2Schema();const validate=new Ajv2020({allErrors:true,strict:false}).compile(schema);assert.equal(validate(r04V2),true,JSON.stringify(validate.errors));
  const serialized=JSON.stringify(schema);for(const forbidden of ['nodeId','edgeId','gatewayId','variableId','requirementRefs'])assert.equal(serialized.includes(forbidden),false,`${forbidden} não pertence ao contrato semântico`);
});
