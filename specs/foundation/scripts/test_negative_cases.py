"""Testes de mutação mínimos para provar rejeição de erros importantes."""
import copy,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from check_examples import validate_semantics
ROOT=Path(__file__).resolve().parents[1]
a=json.loads((ROOT/'examples/ferias.json').read_text())
b=json.loads((ROOT/'examples/http-db.json').read_text())
cases=[]
x=copy.deepcopy(a);x['flows'][0]['target']='nao_existe';cases.append(('flux target',x,'FLOW_TARGET_MISSING'))
x=copy.deepcopy(a);x['flows'][2]['condition']={'op':'eq','left':{'var':'nao_existe'},'right':{'literal':'approved'}};cases.append(('variável',x,'CONDITION_VAR_UNDEFINED'))
x=copy.deepcopy(a);x['forms'][0]['fields'][0]['bindTo']='nao_existe';cases.append(('binding',x,'FIELD_VAR_UNDEFINED'))
x=copy.deepcopy(b);next(n for n in x['nodes'] if n['id']=='update')['action']['operationId']='sql_arbitrario';cases.append(('op não aprovada',x,'CONNECTOR_NOT_APPROVED'))
x=copy.deepcopy(b);del next(n for n in x['nodes'] if n['id']=='update')['action']['idempotencyKey'];cases.append(('escrita sem idempotência',x,'SIDE_EFFECT_UNSAFE'))
x=copy.deepcopy(a);x['status']='approved';cases.append(('dúvida crítica',x,'BLOCKING_QUESTION'))
for name,obj,expected in cases:
 codes={e['code'] for e in validate_semantics(obj)}
 assert expected in codes,(name,expected,codes)
 print('REJEITOU',name,'->',expected)
print(f'{len(cases)} cenários negativos: PASS (validação de referência, não suíte exaustiva)')
