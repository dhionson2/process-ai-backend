"""Validação de referência para fixtures do design kit; não é o runtime TypeScript."""
from __future__ import annotations
import json
from collections import Counter, defaultdict, deque
from pathlib import Path
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / 'contracts/process-spec.v1.schema.json').read_text(encoding='utf-8'))
CATALOG = json.loads((ROOT / 'contracts/mock-capability-catalog.json').read_text(encoding='utf-8'))
APPROVED = {(c['connectorId'],op['operationId']):(op['capability'],op['sideEffectLevel']) for c in CATALOG['connectors'] for op in c['operations']}


def expr_vars(expr):
    if 'var' in expr:
        yield expr['var']
    for key in ('left','right','arg'):
        if key in expr:
            yield from expr_vars(expr[key])
    for a in expr.get('args', []):
        yield from expr_vars(a)


def validate_semantics(spec):
    d=[]
    def add(code, path, detail): d.append({'code':code, 'path':path, 'message':detail})
    nodes={n['id']:n for n in spec['nodes']}; forms={x['id']:x for x in spec['forms']};roles={r['id']:r for r in spec['roles']}
    variables={v['key']:v for v in spec['variables']}
    flows={x['id']:x for x in spec['flows']}
    for name,arr,key in [('NODE',spec['nodes'],'id'),('FLOW',spec['flows'],'id'),('FORM',spec['forms'],'id'),('ROLE',spec['roles'],'id'),('VARIABLE',spec['variables'],'key')]:
        counts=Counter(obj[key] for obj in arr)
        for ident,n in counts.items():
            if n>1:add('DUPLICATE_ID',name, f'{ident} duplicado')
    starts=[x['id'] for x in spec['nodes'] if x['type']=='startEvent']
    ends=[x['id'] for x in spec['nodes'] if x['type']=='endEvent']
    if len(starts)!=1:add('START_COUNT_INVALID','nodes',f'Esperado 1 start; atual {len(starts)}')
    if not ends:add('END_MISSING','nodes','Pelo menos um endEvent')
    adj=defaultdict(list)
    out=defaultdict(list)
    for f in spec['flows']:
        if f['source'] not in nodes:add('FLOW_SOURCE_MISSING',f['id'],f['source'])
        if f['target'] not in nodes:add('FLOW_TARGET_MISSING',f['id'],f['target'])
        if f['source'] in nodes and f['target'] in nodes:
            adj[f['source']].append(f['target']);out[f['source']].append(f)
        if f.get('condition'):
            for v in expr_vars(f['condition']):
                if v not in variables:add('CONDITION_VAR_UNDEFINED',f['id'],v)
    seen=set(starts)
    queue=deque(starts)
    while queue:
        for tgt in adj[queue.popleft()]:
            if tgt not in seen:seen.add(tgt);queue.append(tgt)
    for id_ in nodes:
        if id_ not in seen:add('UNREACHABLE_NODE',id_, 'Nó não alcançável do início')
        if nodes[id_]['type'] not in ('endEvent',) and not out[id_] and nodes[id_]['type'] not in ('boundaryEvent','intermediateCatchEvent'):
            add('DEAD_END',id_,'Nó sem saída')
    for n in spec['nodes']:
        if n['type'] in ('exclusiveGateway',):
            routes=out[n['id']]
            if len(routes)<2:add('GATEWAY_ROUTE_MISSING',n['id'],'XOR precisa de 2 ou mais saídas')
            if any('condition' not in f and not f.get('isDefault') for f in routes):
                add('GATEWAY_ROUTE_MISSING',n['id'],'Saída sem condição/default')
        if n.get('formId') and n['formId'] not in forms:add('FORM_UNDEFINED',n['id'],n['formId'])
        if n.get('roleId') and n['roleId'] not in roles:add('ROLE_UNRESOLVED',n['id'],n['roleId'])
        if n['type']=='serviceTask':
            if 'action' not in n:add('CAPABILITY_NOT_SUPPORTED',n['id'],'Sem contrato de ação')
            else:
                a=n['action'];target=(a['connectorId'],a['operationId']);allowed=APPROVED.get(target)
                if allowed != (a['capability'],a['sideEffectLevel']):add('CONNECTOR_NOT_APPROVED',n['id'],str(target))
                if a['sideEffectLevel']!='read' and (not a.get('idempotencyKey') or not a.get('approvalRequired')):
                    add('SIDE_EFFECT_UNSAFE',n['id'],'Escrita deve pedir aprovação e chave de idempotência')
                for exp in a['inputMapping'].values():
                    for v in expr_vars(exp):
                        if v not in variables:add('CONDITION_VAR_UNDEFINED',n['id'],v)
                if a.get('idempotencyKey'):
                    for v in expr_vars(a['idempotencyKey']):
                        if v not in variables:add('CONDITION_VAR_UNDEFINED',n['id'],v)
                for outputvar in a['outputMapping'].values():
                    if outputvar not in variables:add('OUTPUT_VAR_UNDEFINED',n['id'],outputvar)
    for form in spec['forms']:
        keys=Counter(x['key'] for x in form['fields'])
        for k,num in keys.items():
            if num>1:add('DUPLICATE_ID',form['id'],f'Campo {k}')
        for field in form['fields']:
            if field['bindTo'] not in variables:add('FIELD_VAR_UNDEFINED',form['id'],field['bindTo'])
            for expr_kind in ('visibleWhen','requiredWhen'):
                if expr_kind in field:
                    for var in expr_vars(field[expr_kind]):
                        if var not in variables:add('CONDITION_VAR_UNDEFINED',f"{form['id']}.{field['key']}",var)
    for v in spec['variables']:
        s=v['source']
        if s['kind']=='form':
            f=forms.get(s.get('formId'))
            if not f or s.get('fieldKey') not in [x['key'] for x in f['fields']]:add('VARIABLE_SOURCE_INVALID',v['key'],'Campo de origem ausente')
        if s['kind']=='action':
            n=nodes.get(s.get('nodeId'))
            if not n or n['type']!='serviceTask' or n.get('action',{}).get('outputMapping',{}).get(s.get('outputKey'))!=v['key']:
                add('VARIABLE_SOURCE_INVALID',v['key'],'Saída de ação ausente')
    if any(q['blocking'] for q in spec['pendingQuestions']) and spec['status'] in ('approved','ready-for-review'):
        add('BLOCKING_QUESTION','pendingQuestions','Não pode aprovar com dúvida crítica')
    if spec['targetProfile']!='generic-bpmn2':
        add('CAPABILITY_NOT_SUPPORTED','targetProfile','POC só valida prévia genérica; perfil do motor exige suíte própria')
    if any(n['type'] not in {'startEvent','endEvent','userTask','serviceTask','exclusiveGateway'} for n in spec['nodes']):
        add('CAPABILITY_NOT_SUPPORTED','nodes','Há tipos fora do subconjunto POC')
    return d


def validate_fixture(path):
    spec=json.loads(path.read_text(encoding='utf-8'))
    val=Draft202012Validator(SCHEMA)
    errors=[{'code':'SCHEMA_INVALID','path':'/'.join(map(str,e.path)),'message':e.message} for e in val.iter_errors(spec)]
    if not errors: errors=validate_semantics(spec)
    return errors

if __name__=='__main__':
    ok=True
    for f in sorted((ROOT/'examples').glob('*.json')):
        d=validate_fixture(f)
        print(f'{f.name}: '+('OK' if not d else f'{len(d)} ERROR(S)'))
        for e in d:print(' ',e)
        ok=ok and not d
    if not ok:raise SystemExit(1)
    print('Schema + subset semantic checks: PASS. NÃO comprova compatibilidade em runtime/bpmn-js/form-js.')
