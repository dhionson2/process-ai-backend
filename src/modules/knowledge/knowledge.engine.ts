import { readFoundationJson, readFoundationText } from '../../shared/files.js';
import { technicalIntent } from './capability-context.js';

export type KnowledgeSelection = { version: string; moduleIds: string[]; text: string; estimatedTokens: number };
type KnowledgeModule = { id: string; path: string; always: boolean; tags: string[] };

function classifyTags(text: string): Set<string> {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const tags = new Set<string>();
  // A catalog operation described as "aprovada" is not a human approval flow.
  const intent = normalized.replace(/operacao\s+aprovada/g, 'operacao autorizada');
  if (/aprov|reprov|gestor|decis/.test(intent)) tags.add('approval');
  if (/form|campo|preench|obrigator|motivo/.test(normalized)) { tags.add('form'); tags.add('input'); }
  if (/http|api|endpoint|integrac/.test(normalized)) { tags.add('http'); tags.add('api'); tags.add('integration'); tags.add('serviceTask'); }
  if (technicalIntent(text) && /banco|sql|tabela|database|_db/.test(normalized)) { tags.add('database'); tags.add('write'); tags.add('integration'); tags.add('serviceTask'); }
  if (/se |quando|condic|decis|rota|gateway|aprov|reprov/.test(intent)) tags.add('gateway');
  if (/prazo|sla|timer|escal|atras/.test(normalized)) { tags.add('timer'); tags.add('exception'); }
  if (/paralel|simultane/.test(normalized)) { tags.add('parallel'); tags.add('gateway'); }
  if (/subprocess|reutiliz/.test(normalized)) tags.add('subprocess');
  if (/evento|notific|mensagem/.test(normalized)) tags.add('event');
  return tags;
}

function markdownSections(document: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  let heading = '';
  let body: string[] = [];
  for (const line of document.split(/\r?\n/)) {
    if (/^#{1,3} /.test(line)) {
      if (heading || body.length) sections.push({ heading, body: body.join('\n').trim() });
      heading = line;
      body = [];
    } else body.push(line);
  }
  if (heading || body.length) sections.push({ heading, body: body.join('\n').trim() });
  return sections;
}

function relevantDocument(path: string, content: string, tags: Set<string>, remainingChars: number): string {
  const sections = markdownSections(content);
  let selected = sections;
  if (path === 'bpmn-20.md') {
    selected = sections.filter(section => /Fundamentos|Regras de qualidade|Status de suporte/.test(section.heading) ||
      (tags.has('gateway') && /Gateway/.test(section.heading)) || (tags.has('event') && /Eventos/.test(section.heading)) ||
      (tags.has('serviceTask') && /Atividades/.test(section.heading)));
  } else if (path === 'exemplos-intencoes.md') {
    selected = sections.filter(section => {
      const sample = `${section.heading}\n${section.body}`.toLowerCase();
      return (tags.has('approval') && /ferias|aprova|ambigua/.test(sample)) ||
        (tags.has('http') && /api publica/.test(sample)) || (tags.has('database') && /update no banco/.test(sample)) ||
        (tags.has('parallel') && /paralela/.test(sample)) || (tags.has('timer') && /sla e escalonamento/.test(sample));
    });
  } else if (path === 'forms.md') {
    selected = sections.filter(section => /Princípio|Campos e variáveis|Ligação ao BPMN|Geração de schema/.test(section.heading) || (tags.has('approval') && /Exemplo de regra/.test(section.heading)));
  }
  const selectedText = selected.map(section => `${section.heading}\n${section.body}`).join('\n\n').trim();
  if (selectedText.length <= remainingChars) return selectedText;
  return selectedText.slice(0, Math.max(0, remainingChars)).replace(/\n[^\n]*$/, '').trim();
}

export class BpmKnowledgeEngine {
  async selectInterpretation(query: string, maxChars = 3500): Promise<KnowledgeSelection> {
    const manifest = await readFoundationJson('knowledge/manifest.json') as { version: string; modules: KnowledgeModule[] };
    const coreModule = manifest.modules.find(module => module.id === 'business-interpretation');
    if (!coreModule) throw new Error('O módulo versionado business-interpretation está ausente no manifesto de conhecimento');
    const core = await readFoundationText(`knowledge/${coreModule.path}`);
    const moduleIds = ['business-interpretation'];
    let text = core;
    if (technicalIntent(query) && maxChars > core.length) {
      const integrationModule = manifest.modules.find(module => module.id === 'integrations');
      if (integrationModule) {
        text += '\n\n' + await readFoundationText(`knowledge/${integrationModule.path}`);
        moduleIds.push(integrationModule.id);
      }
    }
    text = text.slice(0, Math.max(0, maxChars));
    return { version: manifest.version, moduleIds, text, estimatedTokens: Math.ceil(text.length / 4) };
  }
  async select(query: string, maxChars = 12000): Promise<KnowledgeSelection> {
    const manifest = await readFoundationJson('knowledge/manifest.json') as { version: string; modules: KnowledgeModule[] };
    const tags = classifyTags(query);
    const selectedModules = manifest.modules.filter(module => module.always || module.tags.some(tag => tags.has(tag)) || (module.id === 'few-shots' && tags.size > 0));
    selectedModules.sort((left, right) => Number(right.id === 'few-shots') - Number(left.id === 'few-shots'));
    // Full domain fixtures contain scenario-specific roles, systems and unresolved
    // questions. Small models were copying those details into unrelated prompts.
    // Keep fixtures as validators/generator test data and send only generic,
    // versioned explanatory examples from the knowledge pack.
    const parts: string[] = [];
    let remaining = maxChars;
    const moduleIds: string[] = [];
    for (const module of selectedModules) {
      if (remaining <= 0) break;
      const document = await readFoundationText(`knowledge/${module.path}`);
      const excerpt = relevantDocument(module.path, document, tags, remaining);
      if (!excerpt) continue;
      const heading = `## Fonte ${module.id} (${module.path})\n`;
      const chunk = `${heading}${excerpt}`.slice(0, remaining);
      parts.push(chunk);
      moduleIds.push(module.id);
      remaining -= chunk.length;
    }
    const text = parts.join('\n\n').slice(0, maxChars);
    return { version: manifest.version, moduleIds, text, estimatedTokens: Math.ceil(text.length / 4) };
  }
}
