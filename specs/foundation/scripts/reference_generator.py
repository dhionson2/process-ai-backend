"""Gerador offline e limitado de artefatos de PREVIEW (não execução)."""
from __future__ import annotations
import json
from pathlib import Path
from collections import defaultdict, deque
from xml.etree import ElementTree as ET
from check_examples import validate_fixture

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'examples' / 'generated'
NSB='http://www.omg.org/spec/BPMN/20100524/MODEL'
NSD='http://www.omg.org/spec/BPMN/20100524/DI'
NSDC='http://www.omg.org/spec/DD/20100524/DC'
NSDI='http://www.omg.org/spec/DD/20100524/DI'
NSX='http://www.w3.org/2001/XMLSchema-instance'
for prefix, ns in [('bpmn',NSB),('bpmndi',NSD),('dc',NSDC),('di',NSDI),('xsi',NSX)]:ET.register_namespace(prefix,ns)

def q(ns,tag):return f'{{{ns}}}{tag}'

def node_box(kind):
    if kind in ('startEvent','endEvent'):return (36,36)
    if kind.endswith('Gateway'):return (50,50)
    return (140,80)

def do_layout(spec):
    adj=defaultdict(list)
    for f in spec['flows']:adj[f['source']].append(f['target'])
    start=next(n['id'] for n in spec['nodes'] if n['type']=='startEvent')
    depth={start:0};work=deque([start])
    while work:
        curr=work.popleft()
        for nxt in adj[curr]:
            if nxt not in depth:depth[nxt]=depth[curr]+1;work.append(nxt)
    layers=defaultdict(list)
    for n in spec['nodes']:layers[depth.get(n['id'],999)].append(n)
    pos={}
    for lvl,group in sorted(layers.items()):
        for row,n in enumerate(group):
            width,height=node_box(n['type'])
            pos[n['id']]={'x':110+lvl*210,'y':130+(row-(len(group)-1)/2)*180,'w':width,'h':height}
    return pos

def ast_preview(expr):
    if 'var' in expr:return expr['var']
    if 'literal' in expr:return json.dumps(expr['literal'], ensure_ascii=False)
    op=expr['op']
    if op in ('and','or'):
        return '('+(' && ' if op=='and' else ' || ').join(ast_preview(x) for x in expr['args'])+')'
    if op in ('not','isSet'):return ('!' if op=='not' else 'isset(')+ast_preview(expr['arg'])+('' if op=='not' else ')')
    return '('+ast_preview(expr['left'])+' '+{'eq':'==','ne':'!=','gt':'>','gte':'>=','lt':'<','lte':'<='}[op]+' '+ast_preview(expr['right'])+')'

def generate_bpmn(spec):
    defs=ET.Element(q(NSB,'definitions'), {'id':f"Definitions_{spec['id']}",'targetNamespace':'urn:process-design:preview'})
    proc=ET.SubElement(defs,q(NSB,'process'),{'id':spec['id'],'name':spec['name'],'isExecutable':'false'})
    nodes={n['id']:n for n in spec['nodes']}
    incoming=defaultdict(list);outgoing=defaultdict(list)
    for f in spec['flows']:outgoing[f['source']].append(f['id']);incoming[f['target']].append(f['id'])
    for n in spec['nodes']:
        el=ET.SubElement(proc,q(NSB,n['type']),{'id':n['id'],'name':n['name']})
        if n.get('documentation'):
            ET.SubElement(el,q(NSB,'documentation')).text=n['documentation']
        if n['type']=='serviceTask':
            a=n['action']
            ET.SubElement(el,q(NSB,'documentation')).text=(f"PREVIEW-ONLY: {a['capability']} "
                f"via {a['connectorId']}/{a['operationId']}; configs no ProcessSpec, execução DESATIVADA.")
        for fid in incoming[n['id']]:ET.SubElement(el,q(NSB,'incoming')).text=fid
        for fid in outgoing[n['id']]:ET.SubElement(el,q(NSB,'outgoing')).text=fid
    for f in spec['flows']:
        attrs={'id':f['id'],'sourceRef':f['source'],'targetRef':f['target']}
        if f.get('label'):attrs['name']=f['label']
        el=ET.SubElement(proc,q(NSB,'sequenceFlow'),attrs)
        if 'condition' in f:
            # Preserve a condição para design, NÃO compilar como JUEL/expression executável nesta referência.
            ET.SubElement(el,q(NSB,'documentation')).text='CONDITION AST (preview): '+json.dumps(f['condition'],ensure_ascii=False,sort_keys=True)
    dgm=ET.SubElement(defs,q(NSD,'BPMNDiagram'),{'id':f"Diagram_{spec['id']}"})
    plane=ET.SubElement(dgm,q(NSD,'BPMNPlane'),{'id':f"Plane_{spec['id']}",'bpmnElement':spec['id']})
    pos=do_layout(spec)
    for n in spec['nodes']:
        box=pos[n['id']]
        shape=ET.SubElement(plane,q(NSD,'BPMNShape'),{'id':f"Shape_{n['id']}",'bpmnElement':n['id']})
        ET.SubElement(shape,q(NSDC,'Bounds'),{'x':str(round(box['x'],2)),'y':str(round(box['y'],2)),'width':str(box['w']),'height':str(box['h'])})
    for f in spec['flows']:
        s=pos[f['source']];t=pos[f['target']]
        edge=ET.SubElement(plane,q(NSD,'BPMNEdge'),{'id':f"Edge_{f['id']}",'bpmnElement':f['id']})
        x1=s['x']+s['w'];y1=s['y']+s['h']/2
        x2=t['x'];y2=t['y']+t['h']/2
        ET.SubElement(edge,q(NSDI,'waypoint'),{'x':str(round(x1,2)),'y':str(round(y1,2))})
        if y1!=y2:
            midx=(x1+x2)/2
            ET.SubElement(edge,q(NSDI,'waypoint'),{'x':str(round(midx,2)),'y':str(round(y1,2))})
            ET.SubElement(edge,q(NSDI,'waypoint'),{'x':str(round(midx,2)),'y':str(round(y2,2))})
        ET.SubElement(edge,q(NSDI,'waypoint'),{'x':str(round(x2,2)),'y':str(round(y2,2))})
    ET.indent(defs, space='  ')
    return ET.tostring(defs,encoding='unicode',xml_declaration=True)

FIELD_MAP={'text':'textfield','textarea':'textarea','integer':'number','decimal':'number',
           'boolean':'checkbox','select':'select','date':'datetime','datetime':'datetime','email':'textfield'}

def convert_form(form):
    components=[]; warnings=[]
    for idx,f in enumerate(form['fields']):
        if f['type'] not in FIELD_MAP:
            warnings.append({'code':'FORM_FIELD_UNSUPPORTED','field':f['key'],'reason':f['type']});continue
        comp={'type':FIELD_MAP[f['type']],'key':f['bindTo'],'label':f['label'],'id':f"Field_{form['id']}_{idx}"}
        if f['required']:comp['validate']={'required':True}
        if f['type'] in ('date','datetime'):comp['subtype']=f['type']
        if f['type']=='select':comp['values']=f.get('options',[])
        if f.get('visibleWhen') or f.get('requiredWhen'):
            # Não fingir compatibilidade com versões ainda não testadas no browser.
            warnings.append({'code':'DYNAMIC_FORM_RULE_NOT_COMPILED','field':f['key'],'reason':'Requer compilador FEEL e teste na versão form-js alvo'})
        components.append(comp)
    # Botão submetido no contexto de preview; integração 1Doc trata submit via sua própria UI.
    components.append({'type':'button','key':'submit','label':'Enviar','action':'submit','id':f"Submit_{form['id']}"})
    return {'type':'default','components':components},warnings


def emit(name):
    src=ROOT/'examples'/f'{name}.json'; errors=validate_fixture(src)
    if errors:raise RuntimeError(f'{src} inválido: {errors}')
    spec=json.loads(src.read_text(encoding='utf-8'))
    xml=generate_bpmn(spec)
    DEST.mkdir(parents=True,exist_ok=True)
    bpmn_file=DEST/f'{name}.bpmn'
    bpmn_file.write_text(xml,encoding='utf-8')
    ET.fromstring(xml)
    manifest={'specId':spec['id'],'targetProfile':spec['targetProfile'],'previewOnly':True,'isExecutable':False,
              'formArtifacts':{},'uncompiledRules':[],'pendingQuestions':spec['pendingQuestions'],
              'notes':['BPMN gerado somente para design; serviceTask e conditions NÃO são executáveis.',
                      'Formulários NÃO foram importados em browser; teste com versão real é obrigatório.']}
    for form in spec['forms']:
        schema,warnings=convert_form(form)
        namef=f'{name}-{form["id"]}.form.json'
        (DEST/namef).write_text(json.dumps(schema,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
        manifest['formArtifacts'][form['id']]=namef
        manifest['uncompiledRules'].extend(warnings)
    (DEST/f'{name}.manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    print(f"{name}: {len(spec['nodes'])} nós, {len(spec['flows'])} conexões, {len(spec['forms'])} forms, {len(manifest['uncompiledRules'])} avisos da tradução; preview não executável")
    # Teste estrutural de DI e referências, sem prometer validação completa por XSD/editor.
    root=ET.fromstring(xml)
    assert len(root.findall('.//'+q(NSD,'BPMNShape')))==len(spec['nodes'])
    assert len(root.findall('.//'+q(NSD,'BPMNEdge')))==len(spec['flows'])
    assert root.find('.//'+q(NSB,'process')).get('isExecutable')=='false'

if __name__=='__main__':
    emit('ferias')
    emit('http-db')
