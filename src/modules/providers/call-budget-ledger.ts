import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

type BudgetState = { calls: number; reservedTokens: number; actualTokens?: number };

/** Optional local durable ledger used to keep bounded smoke budgets across backend restarts. */
export class ProviderCallBudgetLedger {
  private readonly file: string;
  constructor(path: string) {
    this.file = resolve(path);
    const rel = relative(process.cwd(), this.file);
    if (!isAbsolute(this.file) || rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
      throw new Error('Ledger do provider deve ficar fora do repositório/processo');
    }
  }
  reserve(tokens: number, maxCalls: number, maxTokens: number): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    let lockFd: number;
    try { lockFd = openSync(lock, 'wx', 0o600); }
    catch { throw new Error('Ledger local de chamadas ocupado; provider bloqueado por segurança'); }
    try {
      let state: BudgetState = { calls: 0, reservedTokens: 0, actualTokens: 0 };
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<BudgetState>;
        if (!Number.isSafeInteger(parsed.calls) || (parsed.calls as number) < 0 || !Number.isSafeInteger(parsed.reservedTokens) || (parsed.reservedTokens as number) < 0 || (parsed.actualTokens !== undefined && (!Number.isSafeInteger(parsed.actualTokens) || parsed.actualTokens < 0))) throw new Error('Ledger local de chamadas inválido; provider bloqueado por segurança');
        state = { calls: parsed.calls as number, reservedTokens: parsed.reservedTokens as number, actualTokens: parsed.actualTokens || 0 };
      }
      if (maxCalls > 0 && state.calls >= maxCalls) throw new Error('Limite cumulativo local de chamadas Groq atingido');
      if (maxTokens > 0 && state.actualTokens! + state.reservedTokens + tokens > maxTokens) throw new Error('Reserva cumulativa local de tokens Groq atingida');
      const next = { calls: state.calls + 1, reservedTokens: state.reservedTokens + tokens, actualTokens: state.actualTokens };
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(next)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.file);
    } finally {
      closeSync(lockFd);
      try { unlinkSync(lock); } catch { /* lock cleanup is best effort; next call fails closed if it remains */ }
    }
  }
  settle(reservation: number, actualTokens: number): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    let lockFd: number;
    try { lockFd = openSync(lock, 'wx', 0o600); }
    catch { throw new Error('Ledger local de chamadas ocupado'); }
    try {
      const state = JSON.parse(readFileSync(this.file, 'utf8')) as BudgetState;
      const next = { calls: state.calls, reservedTokens: Math.max(0, state.reservedTokens - reservation), actualTokens: (state.actualTokens || 0) + actualTokens };
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(next)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.file);
    } finally {
      closeSync(lockFd);
      try { unlinkSync(lock); } catch { /* fail closed on the next call if cleanup fails */ }
    }
  }
}
