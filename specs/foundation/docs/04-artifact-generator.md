# 04 — Artifact Generator: especificação técnica

## Contratos

```ts
interface ArtifactGenerator {
  generate(spec: ProcessSpec, target: TargetProfile): Promise<{
    bpmnXml: string;
    forms: Array<{ id: string; json: unknown }>;
    manifest: { specRevision: number; target: string; checksums: Record<string,string> };
    diagnostics: Diagnostic[];
  }>;
}
```

**Entrada:** ProcessSpec v1, profile/capability catalog aprovado, versão da saída e configuração de layout. **Saída:** BMPN XML 2.0.2 + BPMNDI, form JSON para cada formulário, manifesto, hashes e erros. Geradores devem ser funções predominantemente puras e determinísticas: mesmo input + versões = mesma saída normalizada.

## Gerador BPMN

1. Revalida contrato e grafo; recusa `scriptTask` e extensões desconhecidas.
2. Produz `definitions`, `process`, elementos com IDs canônicos, `sequenceFlow` sourceRef/targetRef.
3. Gera metadados `documentation` sem incluir segredo, SQL executável ou instruções de runtime.
4. Compila expressões AST do subconjunto permitido com mapeamento **por motor**, não por concatenação livre.
5. Gera `BPMNDiagram`, `BPMNPlane`, shapes e edges; layout em camadas para grafo simples, com tratamento específico para forks/joins/loops/subprocesses em versões futuras.
6. Verifica parse/serialization round-trip; testes de importação em `bpmn-js` e snapshot.
7. Mantém `isExecutable=false` até perfil de execução ter passado no gate. NÃO inferir executor Flowable automaticamente com `flowable:class` ou expressões geradas pela IA.

## Gerador de formulários

1. Traduz tipos de domínio para componentes permitidos da versão efetiva do `form-js`.
2. Configura `key`, label, descrição, propriedades de validação e options.
3. Compila regras `requiredWhen` e `visibleWhen` apenas para sintaxe suportada e com testes; caso contrário bloqueia, não degrada silenciosamente.
4. Preserva mappings para variáveis sem embutir credenciais/dados sensíveis em schemas.
5. Testa import no `FormEditor` e viewer e valida campos requeridos do conjunto de cenários.

## Gerador de service tasks

- Na POC: elementos `serviceTask` **declarativos** em processo não executável. O vínculo `action` permanece no manifesto ou em metadado NÃO executável.
- Na integração: adapter reconhece `connectorId/operationId` e resolve para recurso real criado/aprovado no runtime; escolha entre HTTP task do Flowable OSS, delegate controlado ou external worker depende de teste e ADR.
- Nunca converter texto de intenção em `flowable:class` Java arbitrára, `${...}` sem compilador seguro ou script/SQL livre.

## Compatibilidade por alvo

| Perfil | Finalidade | Status inicial |
| --- | --- | --- |
| `generic-bpmn2` | Prévia interoperável, sem execução | Referência inicial |
| `flowable-oss` | Exportar conforme versão comprovada da engine | Necessita testes integrais e regras de extensão |
| `unique-future` | Artefatos compatíveis com design-api/M3/M4 e futuras ações M7 | **Ainda não homologado**; mapear com contratos reais quando disponíveis |

## Check de finalização

`ProcessSpec schema -> semantic validation -> generate -> XML parse -> BPMNDI complete -> bpmn-js import -> form-js import -> golden snapshots -> (future) Flowable deployment validation -> human approval`.

O kit inclui gerador ilustrativo offline em Python para os casos simples. **Não é a implementação TypeScript final, nem comprovação de engine**.
