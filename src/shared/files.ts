import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(process.cwd(), 'specs/foundation');
export async function readFoundationText(relativePath: string): Promise<string> {
  // Caminhos precisam ser internos e controlados pelo código: jamais aceitar input do usuário.
  return readFile(resolve(root, relativePath), 'utf8');
}
export async function readFoundationJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFoundationText(relativePath)) as unknown;
}
