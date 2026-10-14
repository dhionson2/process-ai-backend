# ARQ-001 — Arquitetura de referência do Copiloto de Processos com IA

**Versão:** 1.0 — Proposta para revisão técnica  
**Data:** 14/10/2026  
**Nome comercial:** a definir (não depende de Unique)  
**Natureza:** documento de arquitetura de solução, decisões, riscos e critérios de validação; não é aceite de implantação  
**Base de produto:** SDD-PROD-001 — Copiloto de Modelagem Conversacional de Processos e Formulários  
**Ambiente-alvo:** OCI, cluster Kubernetes corporativo gerenciado por Rancher; confirmar se o cluster é OKE ou Kubernetes autogerenciado na OCI

## 1. Drivers arquiteturais

- Gerar rascunhos de **BPMN 2.0 e formulários editáveis** a partir de linguagem natural, com refinamento conversacional.
- **Baixo custo incremental** utilizando Kubernetes, Rancher, registry, observabilidade, ingress e PostgreSQL existentes, sempre que houver disponibilidade e autorização.
- **Independência de fornecedor de LLM**: Ollama privado ou provedores externos aprovados, como OpenAI, Anthropic e Google.
- **Correção determinística**: LLM não é a autoridade de validade dos artefatos ou permissões.
- Segurança desde a origem: isolamento de tenants, proteção contra prompt injection, política de dados e sem publicação automática.
- **Dois repositórios** de aplicação: frontend e backend; não criar monorepo nem novo repositório de infraestrutura por obrigação.
- **POC isolada** de sistemas produtivos e dados reais, com interfaces compatíveis com integração futura ao Unique/1Doc.

## 2. ADRs — decisões de arquitetura

| ID | Decisão | Justificativa e implicação |
|---|---|---|
| ADR-01 | Frontend React 19 + TypeScript + Vite em repositório próprio | Reuso do ecossistema visual, `bpmn-js` e `form-js`; publicação como assets estáticos |
| ADR-02 | Backend Node.js + TypeScript + Fastify em repositório próprio | Contratos tipados, menor complexidade operacional, colaboração com stack do Unique |
| ADR-03 | Monólito modular inicialmente | Um serviço lógico; não exige service mesh, múltiplos bancos ou microsserviços |
| ADR-04 | Implantação com Helm nos clusters K8s existentes da OCI gerenciados por Rancher | Aderência à plataforma corporativa; evitar cluster novo |
| ADR-05 | Rascunho canônico como `ProcessSpec` versionado | Toda sugestão, edição, validação e geração parte do mesmo modelo coerente |
| ADR-06 | Pipeline de geração com LLM para interpretação e **código determinístico** para BPMN e formulários | Reduz alucinações, melhora portabilidade entre modelos e possibilita testes |
| ADR-07 | Conhecimento de BPMN e Form hospedado no backend e versionado | Base neutra em relação ao LLM; conter esquema, regras, exemplos e corpus testado |
| ADR-08 | AI Gateway no backend com adaptadores de provedores | Isolar credenciais, custos, limites, política de egress e formato de saída |
| ADR-09 | PostgreSQL para dados e fila persistente opcional | Aproveita tecnologia conhecida; uma única infraestrutura transacional inicial |
| ADR-10 | REST/OpenAPI para comandos e consultas; SSE para progresso, polling como fallback | Contrato independente e UX de operações longas sem manter conexão transacional aberta |
| ADR-11 | Sem execução/publicação direta pela IA | Revisão humana obrigatória; futuras integrações passam pelos fluxos de autorização oficiais |
| ADR-12 | Ollama, quando habilitado, isolado em workload independente e rede privada | Capacidade e memória do modelo não devem ser multiplicadas quando a API escalar |
| ADR-13 | K8s workloads sem privilégios, configuração por Secret e egress controlado | Segurança e governança centralizadas, independentes da escolha do LLM |
| ADR-14 | Sem banco vetorial/RAG obrigatório nem fine-tuning na POC | Começar com regras e exemplos selecionados; só ampliar quando houver evidência de ganho |

## 3. Visão de implantação: OCI + Rancher + Kubernetes

```text
Usuário autorizado
      |
 HTTPS (TLS da plataforma)
      v
Ingress / Gateway corporativo (OCI + K8s)
      |
      +---- /          ---> Service frontend ---> Deployment frontend (React estático)
      |
      +---- /api/*     ---> Service api -------> Deployment backend (Fastify)
                                                   |
                      +----------------------------+--------------------------+
                      |                            |                          |
                      v                            v                          v
             PostgreSQL corporativo         AI Gateway interno          Artefatos futuros
             drafts, sessões, jobs          |          |                (OCI Object Storage)
                                           |          +--> APIs externas aprovadas
                                           |                 (via egress permitido)
                                           +--> Service ollama (ClusterIP)
                                                Deployment separado
                                                volume de modelos / nó dedicado se necessário

Rancher: gerencia cluster, permissões de namespace, inspeção de workloads e observabilidade.
Helm / Fleet GitOps (se já adotado) : releases e configuração de ambientes.
OCI: compute, rede, registry/opcional, armazenamento e segredos conforme plataforma.
```

**Atenção:** Rancher é gerenciador da infraestrutura Kubernetes, não substitui o cluster. Confirmar se o cluster OCI usa **OKE (gerenciado pela Oracle)** ou K8s autogerenciado; recursos OCI específicos, como OKE Workload Identity, **não devem ser presumidos**. A escolha de registry depende do que a organização já utiliza; OCI Container Registry é alternativa, não imposição.

### Ambientes e namespaces

- **POC:** namespace isolado `process-copilot-poc`, sem acesso a sistemas de produção, sem dados reais.
- **HML:** `process-copilot-hml`, parâmetros e segredos próprios, integração simulada/autorizada.
- **PROD futura:** `process-copilot-prod`, com recursos, quotas, políticas, controle de mudanças e segregação de acesso.
- Preferir **namespaces por ambiente**, não um namespace por cliente; isolamento dos clientes deve ser **lógico e end-to-end** na aplicação e persistência.
- Não replicar infra compartilhada se Rancher já fornecer Ingress, cert-manager, DNS, monitoring e logs.

### Deployments

| Workload | POC | Produção inicial (referência, validar carga) |
|---|---|---|
| Frontend | 1 réplica | 2 réplicas (ou hosting estático corporativo se mais econômico) |
| API | 1 réplica | 2 réplicas, HPA sob uso medido |
| Worker de geração | Mesmo processo, com concorrência limitada | Deployment separado com **mesma imagem de backend**, caso jobs persistentes sejam necessários |
| Ollama | Desligado, remoto privado ou 1 réplica de laboratório | 1+ instância(s) em pool dedicado **somente se** benchmark justificar o custo |
| PostgreSQL | Banco/instância de desenvolvimento autorizada | Banco corporativo com backup, HA e política existente |

**Importante:** replicas e recursos são um ponto de partida, não sizing certificado. 2 réplicas exigem capacidade do cluster e orçamento; a POC não precisa de alta disponibilidade.

## 4. Limites dos módulos do backend

```text
src/
  http/                  autenticação, validação de entrada, contratos OpenAPI
  application/           casos de uso (gerar, perguntar, revisar, validar, exportar)
  domain/                ProcessSpec, invariantes, estados, regras, RBAC
  ai/
    gateway/             políticas, escolha do provedor, roteamento e cotas
    providers/           ollama, openai, anthropic, gemini
    prompts/             templates versionados e instruções
    knowledge/           especificação BPMN/Form, exemplos, capacidades reais
  generation/
    process-spec/        extração e normalização de intenção
    bpmn/                XML + BPMN DI determinísticos
    forms/               JSON determinístico
  validation/            schemas, grafos, referências, mapeamentos e domínios
  drafts/                versões imutáveis, diff, colaboração e conflitos
  jobs/                  processamento assíncrono e controle de concorrência
  persistence/           repositorios SQL, migrações, tenancy
  integration/           adaptador futuro 1Doc/Unique, desativado na POC
  observability/         logs estruturados, métricas, tracing
infra/
  helm/                  Helm chart do backend e configs por ambiente
```

O frontend tem seu próprio `infra/helm/`, contendo Deployment, Service, Ingress opcional e configurações públicas. Cada repositório possui seu pipeline de build, teste, escaneamento e publicação, porém compartilham **o contrato OpenAPI gerado e versionado** (SDK gerado a partir do contrato publicado, sem repositório terceiro obrigatório).

## 5. Modelo de domínio canônico

Entidades principais:
- **Workspace:** agrupamento de rascunhos no contexto de tenant autorizado.
- **Draft:** identidade estável de um processo em criação.
- **DraftRevision:** revisão imutável com `processSpec`, autor, data, alterações e versão-base.
- **Conversation:** mensagens do usuário e da IA, com política de retenção e vínculo ao draft.
- **GenerationJob:** solicitação de geração, estado, timeouts, tentativas e status.
- **ProviderPolicy:** provedores/modelos aprovados, egress permitido, cotas e classificação de dados.
- **Artifact:** BPMN XML, formulários JSON, hashes, resultado da validação e origem.
- **ValidationReport:** erros bloqueantes, alertas, pendências e ligações com elementos.
- **AuditEvent:** usuário, tenant, ação, revisão, resultado e metadados seguros.

### `ProcessSpec` (contrato conceitual)

- `schemaVersion`, `processId`, `name`, `description`, `locale`
- `startEvent`, `endEvents[]`
- `actors[]` (papéis abstratos e estado de resolução)
- `tasks[]` (tipos explicitamente suportados; atributos e formulários)
- `gateways[]` (tipos suportados, condições tipadas e rota padrão quando prevista)
- `flows[]` (arestas entre IDs estáveis, rótulos e condições)
- `forms[]` (campos, tipos, validações e elementos de decisão)
- `variables[]` (tipo, origem, vínculo, escopo)
- `assumptions[]`, `pendingQuestions[]`, `unsupportedFeatures[]`
- `provenance[]` (solicitado pelo usuário, inferido pela IA ou confirmado)

**Estados do rascunho:** `NEW` → `CLARIFICATION_REQUIRED` ↔ `GENERATING` → `VALIDATION_FAILED`/`REVIEW_READY` → `ACCEPTED_DRAFT` → `EXPORTED`/`SUBMITTED_FOR_REVIEW` (etapa futura); `CANCELLED`/`FAILED` preservam a última revisão válida.

**Invariantes:** IDs únicos e estáveis, arestas para nós existentes, ao menos início e caminho até fim quando suportado, tipos compatíveis, gateway com caminhos consistentes, referências a formulários/variáveis existentes, autores autorizados e controle de versão otimista.

## 6. Pipeline de geração e refinamento

1. **AuthZ e policy:** validar usuário, tenant, permissão, tamanho, quotas e classificação dos dados.
2. **Intenção:** separar fatos explícitos, ambiguidades, requisitos e recursos fora do escopo.
3. **Perguntas:** solicitar esclarecimentos quando afetam roteamento, atores, formulário ou conformidade.
4. **AI Gateway:** montar instruções e exemplos relevantes; chamar provedor autorizado; solicitar saída estruturada quando suportada.
5. **Parse/schema:** validar a resposta contra contrato versionado; rejeitar conteúdo estruturalmente indevido.
6. **Normalização:** atribuir IDs, tipar variáveis, converter estruturas declarativas e sinalizar pressupostos.
7. **Validação semântica:** análise de grafo, caminhos, gates/condições, forms, papéis, recursos suportados.
8. **Reparo controlado:** permitir no máximo 1–2 tentativas do LLM **apenas** com erros de validação estritamente necessários. Impor limite de custo e tempo.
9. **Compilação determinística:** ProcessSpec → BPMN XML/DI e JSON form-js.
10. **Verificação final:** importabilidade por bibliotecas e comparação de critérios de cenário.
11. **Revisão:** registrar nova DraftRevision, diffs e pendências; nunca sobrescrever versão anterior silenciosamente.

**Refinamento:** o usuário produz uma instrução que vira **patch estruturado**, aplicado sobre uma revisão-base (`If-Match`/`revisionId`) após validação e aceite. Não enviar ou reescrever toda a definição em cada mudança quando um subconjunto contextual resolver.

**Importante:** regras de BPMN 2.0 e compatibilidade do Unique pertencem a schemas, validadores, exemplos e testes — não somente ao prompt. As instruções do LLM devem referenciar a mesma versão das regras usadas pelos validadores.

## 7. Estratégia de conhecimento especializado

**Fase POC:** arquivos versionados no backend, sem RAG nem banco vetorial:
- BPMN suportado: Start/End, User Task, Exclusive Gateway, Sequence Flow, condições e escopo de tipos.
- Formulários: componentes form-js suportados, campos, `required`, tipos, validações condicionais e regras permitidas.
- Mapeamento: `form field → variable → gateway condition`.
- Exemplos positivos e negativos: férias, compras, solicitação de materiais, aprovação simples etc.
- Contratos e fixtures executáveis para detectar regressão quando o modelo/prompt mudar.

**Quando crescer:** recuperação seletiva por metadados/tipo de tarefa e, se o corpus/volume justificar, RAG com busca textual antes de base vetorial. Fine-tuning somente após benchmark demonstrar ganho consistente e base de treino licenciada/autorizada.

## 8. AI Gateway, modelos e custo

**Adapter contract:** `generateStructured({task, schemaVersion, providerPolicy, promptContext, maxOutput, deadline, correlationId}) -> {result, usage, modelInfo, latency, refusalOrError}`.

- **Providers:** `OllamaAdapter`, `OpenAIAdapter`, `AnthropicAdapter`, `GeminiAdapter`; capacidades de schema JSON, limites, parâmetros e contagem de uso variam. O gateway normaliza o contrato e trata divergências sem mascarar incompatibilidade.
- **Política:** servidor determina catálogo permitido; tenant só escolhe entre opções aprovadas. Nunca aceitar URL arbitrária enviada pelo browser (mitigar SSRF).
- **Credenciais:** somente em Secret/Vault. Nunca cliente ou prompt; não registrar conteúdo de credenciais.
- **Fallback:** nenhuma troca de **privado → externo** sem consentimento e política explícita; fallback entre provedores aprovados é parametrizado e auditado.
- **Custo:** limite por requisição, usuário, tenant e dia; contador de uso, taxa de retrabalho, latência, custo aproximado da API ou custo de compute amortizado no Ollama.
- **Otimizações:** cache de esquema/templates por versão; casos triviais por template sem LLM; recuperação de contexto mínima; diffs em vez de reenvio completo; resumo periódico de conversa; máximo de reparos; limites de concorrência.
- **Modelo local:** benchmark em CPU primeiro somente se a infraestrutura disponível suportar; GPU exclusiva apenas se a qualidade/latência/carga justificarem. **Não afirmar que hospedagem local é gratuita**.

## 9. Persistência e concorrência

PostgreSQL com migrations e schema versionado. Tabelas conceituais:
`tenants` (se a integração exigir espelhamento mínimo), `workspaces`, `drafts`, `draft_revisions`, `conversations`, `messages`, `generation_jobs`, `generation_attempts`, `artifacts`, `validation_reports`, `provider_policies`, `usage_events`, `audit_events`.

Padrões:
- Tenant ID sempre deriva do contexto autenticado, **nunca** de payload cliente confiado sem verificação.
- Todas as consultas e chaves de cache trazem tenant e escopo; testar isolamento negativo.
- Preferir row-level security como defesa em profundidade quando apropriado, com papéis SQL corretos e testes contra bypass; não substitui a autorização do app.
- Revisões **imutáveis**, IDs estáveis, `If-Match`/controle de concorrência otimista.
- Persistir estado dos jobs antes de chamar LLM; idempotência por operação e tratamento de retry.
- Limites de tamanho e retenção de payload; auditoria sem armazenar indiscriminadamente prompts com PII.
- Arquivos de artefatos pequenos podem ficar no banco inicialmente; exportações maiores, histórico pesado e documentos somente em object storage autorizado quando necessário.

### Jobs

Na POC: aceitar solicitação, registrar job, processar com concorrência baixa e responder com status; não acoplar timeout do navegador à persistência. Pode-se iniciar com worker interno se apenas **uma** réplica for usada na POC.

Para 2+ réplicas da API: utilizar **fila persistente de PostgreSQL** com lock transacional/lease, tentativas limitadas, deadlines, idempotência e recuperação após restart. Worker como Deployment separado usando **a mesma imagem do backend**; sem criar terceiro repositório nem Kafka/Redis inicialmente.

Estados: `QUEUED`, `RUNNING`, `CLARIFICATION_REQUIRED`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`. Cancelamento de cliente não significa interrupção garantida do processamento externo; aplicar limites do provedor.

## 10. API e comunicação

Contrato público inicial, `/api/v1`:

```text
POST   /drafts                    cria rascunho
GET    /drafts/:id                consulta metadados e última revisão
GET    /drafts/:id/revisions      lista revisões
POST   /drafts/:id/messages       envia pedido contextual; inicia job
POST   /drafts/:id/generate       gera artefatos a partir da revisão
POST   /drafts/:id/validate       valida revisão específica
POST   /drafts/:id/changes/:id/accept  aceita mudanças pendentes
GET    /jobs/:id                  consulta status e erros
GET    /jobs/:id/events           SSE de eventos de progresso
GET    /drafts/:id/export         exporta BPMN + formulários
GET    /providers/available       lista modalidades permitidas, sem segredos
```

- Autenticação em todas as operações de autoria; autorização por tenant e draft; UUIDs não concedem permissão.
- `Idempotency-Key` em operações mutáveis e `If-Match`/`revisionId` para edição e aceite.
- Progresso via SSE com `jobId`; polling funciona se ingress ou proxy interromper SSE.
- Eventos SSE não são o registro oficial de estado; o banco é.
- Timeouts distintos para API e jobs; não manter conexão HTTP bloqueada durante toda inferência.
- Segurança da API: schema validation, quotas por usuário/tenant, request body limits, CORS estrito, headers de segurança, tratamento uniforme de erros e correlation ID.
- Publicar OpenAPI versionado no backend; frontend gera cliente/SDK via CI a partir do artefato especificado e fixado por versão/tag.

## 11. Segurança por camadas (obrigatório antes de cliente real)

### Identidade e autorização
- POC isolada: acesso restrito a equipe autorizada por mecanismo existente; evitar credenciais hardcoded.
- Produção: federar identidade com 1Doc/IdP corporativo; validar claims, audiência, emissor, expiração e tenant no backend; não assumir que SSO do Rancher autentica usuários da aplicação.
- RBAC funcional: visualizar, gerar, editar, exportar, aprovar e publicar são permissões diferentes.

### Proteção dos dados
- TLS na borda; comunicação privada interna e criptografia em repouso conforme recursos existentes.
- Segredos via solução da equipe: OCI Vault + integração Kubernetes (quando disponível) ou Secrets corporativos protegidos. Em **OKE enhanced**, workload identity pode simplificar acesso OCI; em Kubernetes autogerenciado isso pode não se aplicar.
- Nunca aceitar endpoint arbitrário do Ollama/LLM; allowlist de hosts, TLS e timeouts para evitar SSRF e exfiltração.
- Exigir aprovação formal para tráfego de dados reais a LLM externo; roteamento condicionado a classificação de dados e consentimento/política. Redação não garante anonimização suficiente sozinha.
- Isolamento por tenant em dados, caches, métricas, logs e histórico; políticas de backup/restauração.

### Segurança de IA
- Tratar mensagens e documentos como instruções **não confiáveis**; não dar ao modelo ferramentas de deploy, publicação, consulta livre ou administração.
- Separar instruções do sistema, requisitos do usuário e documentos de referência; não executar código produzido pelo LLM.
- Verificar saída por schemas e validadores locais; rejeitar ações e destinos fora da allowlist.
- Testar injection, jailbreak de regras, enumeração de tenants, bypass de permissões e vazamento de secrets.

### Segurança Kubernetes
- `NetworkPolicy` default deny com liberações explícitas (validar CNI); backend e Ollama acessíveis por ClusterIP, somente Ingress necessário exposto.
- ServiceAccount dedicado por workload; Kubernetes RBAC mínimo; não montar token do SA sem necessidade.
- `runAsNonRoot`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem` quando possível, `capabilities.drop: ALL`, seccomp RuntimeDefault.
- `requests` e `limits`, quota namespace e PodDisruptionBudget quando HA justificada.
- Imagens com tag imutável/digest, escaneamento SCA/containers, SBOM, upgrade e rollback.
- OCI Security Lists/NSGs e regras de saída; pod Ollama não recebe ingress externo.

## 12. OCI / Rancher — serviços recomendados

| Capacidade | Prioridade | Opção recomendada |
|---|---|---|
| Kubernetes | Reuso obrigatório | Cluster corporativo existente na OCI, gerenciado via Rancher |
| Container registry | Reuso preferencial | Registry corporativo atual; **OCIR** se aprovado e operacionalmente vantajoso |
| CI/CD | Reuso preferencial | Pipeline já adotado → imagem → Helm/Fleet se equipe usa GitOps |
| Configuração/deploy | Sim | Helm values por ambiente, sem segredos em Git |
| Database | Reuso preferencial | PostgreSQL corporativo, com isolamento lógico e backups |
| Segredos | Sim | OCI Vault + mecanismo aprovado pelo cluster, ou Secret existente sob governança |
| Métricas/traces/logs | Reuso preferencial | Stack observability instalada no Rancher/K8s |
| Modelos Ollama | Opcional | Service ClusterIP e Deployment separado em nodes com capacidade dedicada |
| GPU | Não na POC | Pool GPU OCI/OKE só após benchmark e orçamento |
| Object Storage | Futuro | Para anexos/explorações pesadas, retenção e exports se necessário |

**Custos que devem ser medidos:** CPU/RAM reservadas versus efetivamente consumidas; eventual expansão de node pools; disco do modelo; egress; registry/armazenamento; custos por tokens de API; horas de operação/manutenção. Reaproveitar cluster diminui custo incremental, **mas não significa custo zero**.

## 13. Estimativas de recursos iniciais (hipóteses para POC, não compromisso)

- Frontend estático: `requests ~50m CPU / 64Mi`, `limits ~250m / 256Mi` por pod.
- API sem inferência local: `requests ~100m / 256Mi`, `limits ~500m / 768Mi` por pod.
- Worker, quando separado: começar com `requests ~200m / 256Mi`, `limits ~1 CPU / 1Gi`; testar carga real.
- Ollama: **não fixar requests/limits antes de escolher modelo, quantização, janela de contexto e hardware disponível**. Pode exigir vários GB de RAM em CPU, volumes persistentes para pesos e/ou GPU; não colocá-lo em worker node compartilhado sem verificar capacidade.

**Esses valores são placeholders de laboratório e precisam ser calibrados com métricas.** HPA do backend por CPU e, quando disponível, latência/RPS; worker por profundidade da fila; Ollama com limite estrito de concorrência e escala deliberada (evitar multiplicar modelos em GPU automaticamente).

## 14. Observabilidade e FinOps

Dashboard mínimo:
- `job_success_rate`, `job_duration`, `time_to_first_preview`, `queue_age`, `queue_depth`.
- `provider_error_rate`, `provider_latency`, `tokens_in`, `tokens_out`, `api_cost_estimate` e custo amortizado da inferência local.
- `validation_error_rate` por tipo e versão de ProcessSpec.
- `manual_edit_count`, `regeneration_count`, `human_acceptance_rate`.
- CPU/RAM por workload, OOMKilled, reinícios, egress e volumes.
- Segurança: tentativas de acesso negadas, erros de tenant, políticas de provedor bloqueadas.

**Privacidade:** telemetria de produto preferencialmente sem corpo de prompt; logging com IDs de correlação, tenant pseudonimizado e redaction. Alertar aumento de consumo, falhas, fila acumulada e acesso indevido.

## 15. Testes e qualidade (gates)

1. **Unitários domínio:** schemas, graph invariants, variáveis, condições, tipos, IDs e migração de versão.
2. **Geração golden files:** ProcessSpec → BPMN/XML e Form JSON determinísticos (fixtures com resultados esperados).
3. **Importabilidade:** abrir BPMN no `bpmn-js`, formulários no `form-js` e validar compatibilidade do subconjunto suportado.
4. **IA com benchmark fixo:** conjunto de cenários fictícios, testes por provedor/modelo e métricas de fidelidade.
5. **Prompt injection/abuse:** documentos maliciosos, dados de outro tenant, egress não permitido, requisições grandes.
6. **API e segurança:** OpenAPI, authn/authz, limites, idempotência, corrida de revisões, rate limit.
7. **Operação:** pod restart no meio do job, timeout, indisponibilidade do Ollama, rollbacks e indisponibilidade do PostgreSQL.
8. **Performance:** benchmark CPU do Ollama versus API externa e concorrência ponta a ponta.
9. **E2E UX:** processo de férias completo, ajuste por conversa e prévia de formulários.

Qualidade objetiva antes de integrar: **100% importabilidade para elementos declaradamente suportados**, nenhuma publicação involuntária e tolerância zero a vazamento entre tenants. Fidelidade semântica é medida com revisão humana, não apenas validação técnica.

## 16. Entrega incremental e gestão de risco

**Fase 0 — Spike e infraestrutura de laboratório:** confirmar cluster Rancher/OCI e limites do namespace, registry, PostgreSQL, ingress, configuração de Secrets e permissão de egress. Escolher 2–3 modelos candidatos sem assumir GPU.

**Fase 1 — Vertical slice funcional:** usuário descreve férias → esclarecimento → ProcessSpec → BPMN + forms → visualização no React; exportação sem executar processo.

**Fase 2 — Correção e revisões:** validações, diffs, geração incremental, base de conhecimento BPMN/Form versionada e testes golden.

**Fase 3 — Integração de provedores:** adapter Ollama, adapter de uma API autorizada, políticas de custo/segurança, benchmarks.

**Fase 4 — Operação corporativa:** helm, pipelines, health probes, observabilidade, gestão de secrets, filas/worker conforme demanda.

**Fase 5 — Avaliação de produto e integração:** demo, tempo e qualidade versus baseline manual, parecer de Produto/Arquitetura, eventual integração controlada ao Unique.

Nenhuma fase implica autorização automática para deploy em ambiente corporativo ou uso de dados reais.

## 17. Critérios de arquitetura aceitos e pontos abertos

### Aceitos como proposta
- Dois repositórios e backend modular.
- Kubernetes/Rancher/OCI, com reuso da plataforma atual.
- AI Gateway desacoplado, provider policy explícita, Ollama como candidato, não padrão irrevogável.
- ProcessSpec versionado; geradores e validadores determinísticos.
- BPMN/formulários sob controle humano e sem execução automática.

### Decisões pendentes de confirmação com infraestrutura/produto
1. Cluster atual é OKE ou K8s autogerenciado na OCI? Quais versões e recursos estão disponíveis?
2. Qual ingress controller, registry, CI/CD/GitOps, monitoramento e esquema de secrets já estão padronizados?
3. Existe PostgreSQL corporativo liberado para POC? Qual política de storage/backup?
4. Permissão para criar namespace e quotas próprias? Há node pool com RAM livre ou GPU?
5. Existe serviço local de inferência corporativo, evitando hospedar Ollama próprio?
6. Provedores externos e classes de dados já são aprovados pela segurança?
7. Quais componentes BPMN/form-js **efetivamente suportados** pelo Unique vigente, além de funcionalidades gerais das bibliotecas?
8. Como a autoria/integração será autorizada na V1 (Softplan) e V2 (órgãos)?
9. Qual teto de orçamento e volume projetado para POC/piloto?

## 18. Referências e limites

**Projeto Unique** (fontes internas, sujeitas a revisão com produto):
- PRD: https://1doc.atlassian.net/wiki/spaces/TECK/pages/3113484291
- V1 piloto: https://1doc.atlassian.net/wiki/spaces/TECK/pages/3113385992
- M7 integração: https://1doc.atlassian.net/wiki/spaces/TECK/pages/3305046022

**Infraestrutura OCI e Rancher:**
- Oracle OCI Registry: https://docs.oracle.com/en-us/iaas/Content/Registry/Concepts/registryoverview.htm
- Oracle K8s secrets (OKE): https://docs.oracle.com/en-us/iaas/Content/ContEng/Tasks/contengmanagingsecrets.htm
- Oracle OKE Workload Identity (somente ambientes compatíveis): https://docs.oracle.com/en-us/iaas/Content/ContEng/Tasks/contenggrantingworkloadaccesstoresources.htm
- Oracle Ollama CPU inference: https://docs.oracle.com/en/solutions/oci-cpu-inference-ollama/index.html
- Rancher Fleet: https://fleet.rancher.io/

**Conclusão:** a plataforma OCI/Kubernetes/Rancher existente deve ser aproveitada; o custo principal a ser otimizado será inferência, memória/GPU, concorrência e retrabalho de geração — não a criação de uma nova infraestrutura de microserviços. A arquitetura é proposta de engenharia, ainda sujeita a validação com a infraestrutura e arquitetura corporativas.
