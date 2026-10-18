import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Opt-in, local-only capture of model JSON text for an explicitly synthetic GraphIR request. */
export function configuredSyntheticDiagnosticCapture(): ((raw: string) => void) | undefined {
  if (process.env.AI_DIAGNOSTIC_CAPTURE_SYNTHETIC !== 'true') return undefined;
  if (process.env.NODE_ENV === 'production') throw new Error('Captura sintética de diagnóstico é proibida em produção');
  const base = resolve(process.env.LOCALAPPDATA || tmpdir());
  const directory = resolve(process.env.AI_DIAGNOSTIC_CAPTURE_DIR || join(base, 'ProcessAI', 'diagnostics'));
  const rel = relative(process.cwd(), directory);
  if (!isAbsolute(directory) || rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    throw new Error('Diretório de captura precisa ficar fora do repositório/processo');
  }
  return raw => {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw new Error('Resposta de diagnóstico excede o limite local de 1 MiB');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `graphir-${Date.now()}-${randomUUID()}.json`);
    writeFileSync(file, raw, { flag: 'wx', mode: 0o600 });
  };
}
