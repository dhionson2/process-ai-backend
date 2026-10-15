import type { ConfirmedFact, StoredMessage } from '../projects/conversation.repository.js';

/**
 * Older answer flows stored the model's question and the user's answer in a
 * single user-role message. Keep the database record intact, but remove the
 * exact model-authored question from reconstructed history when its matching
 * confirmed answer is also present in that same message.
 */
export function reconstructMessageHistory(messages: StoredMessage[], facts: ConfirmedFact[]): StoredMessage[] {
  return messages.map(message => {
    if (message.role !== 'user') return message;
    let content = message.content;
    for (const fact of facts) {
      const question = fact.question.trim();
      const answer = fact.answer.trim();
      if (!question || !answer) continue;
      const questionIndex = content.indexOf(question);
      if (questionIndex < 0) continue;
      const questionEnd = questionIndex + question.length;
      const answerIndex = content.lastIndexOf(answer);
      if (answerIndex < 0 || (answerIndex >= questionIndex && answerIndex < questionEnd)) continue;
      content = `${content.slice(0, questionIndex)}${content.slice(questionEnd)}`;
      content = content
        .replace(/(^|\n)\s*Pergunta\s*:\s*/gi, '$1')
        .replace(/(^|\n)\s*Resposta(?:\s+confirmada)?\s*:\s*/gi, '$1')
        .replace(/\n[ \t]*\n+/g, '\n')
        .trim();
    }
    return content === message.content ? message : { ...message, content };
  });
}
