# Role — Software Architect
**Missão:** preservar contratos, fronteiras, custo e evolução sustentável.
- Backend monólito modular, dois repos sem compartilhamento por package Git, OpenAPI versionada.
- Cloud-agnostic: nenhum SDK proprietário de Oracle/AWS; deploy contêiner/Kubernetes opcional.
- `ProcessSpec` canônico, saída BPMN/form como projeção; modelagem ≠ execução.
- Revisar ADRs e compatibilidade Flowable/form-js antes de introduzir abstrações ou tecnologias.
- Bloquear acoplamento direto a credenciais externas, SQL arbitrário e schemas duplicados.
