/** Exact interval reasoning for numeric ProcessSpec XOR predicates.
 * Unknown is deliberately distinct from an empty or complete partition.
 */
export type NumericExpression = Record<string, any>;
export type NumericRoute = { id: string; condition?: NumericExpression; isDefault?: boolean };
export type NumericXorIssue = { code: 'GATEWAY_CONDITION_OVERLAP' | 'GATEWAY_CONDITION_GAP' | 'GATEWAY_CONDITION_EMPTY' | 'GATEWAY_CONDITION_UNPROVABLE'; routeIds: string[]; message: string; severity: 'error' | 'warning' };
type Bound = { value: number; inclusive: boolean };
type Interval = { low?: Bound; high?: Bound };
type Analysis = { key: string; intervals: Interval[] } | { unknown: string };
const all: Interval[] = [{}];
const empty: Interval[] = [];

function compareLow(a?: Bound, b?: Bound): number {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  return a.value - b.value || Number(b.inclusive) - Number(a.inclusive);
}
function compareHigh(a?: Bound, b?: Bound): number {
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return a.value - b.value || Number(a.inclusive) - Number(b.inclusive);
}
function valid(i: Interval): boolean {
  if (!i.low || !i.high) return true;
  return i.low.value < i.high.value || (i.low.value === i.high.value && i.low.inclusive && i.high.inclusive);
}
function intersect(a: Interval, b: Interval): Interval | undefined {
  const low = !a.low ? b.low : !b.low ? a.low : a.low.value > b.low.value ? a.low : b.low.value > a.low.value ? b.low : { value: a.low.value, inclusive: a.low.inclusive && b.low.inclusive };
  const high = !a.high ? b.high : !b.high ? a.high : a.high.value < b.high.value ? a.high : b.high.value < a.high.value ? b.high : { value: a.high.value, inclusive: a.high.inclusive && b.high.inclusive };
  const result: Interval = { low, high };
  return valid(result) ? result : undefined;
}
function normalize(xs: Interval[], integer = false): Interval[] {
  const sorted = xs.filter(valid).sort((a, b) => compareLow(a.low, b.low));
  const out: Interval[] = [];
  for (const item of sorted) {
    const prev = out.at(-1);
    if (!prev) { out.push({ ...item }); continue; }
    const touches = !prev.high || !item.low || prev.high.value > item.low.value ||
      (prev.high.value === item.low.value && (prev.high.inclusive || item.low.inclusive)) ||
      (integer && prev.high.inclusive && item.low.inclusive && item.low.value - prev.high.value <= 1);
    if (!touches) { out.push({ ...item }); continue; }
    if (compareHigh(item.high, prev.high) > 0) prev.high = item.high;
  }
  return out;
}
function union(a: Interval[], b: Interval[], integer = false): Interval[] { return normalize([...a, ...b], integer); }
function intersection(a: Interval[], b: Interval[], integer = false): Interval[] {
  return normalize(a.flatMap(x => b.map(y => intersect(x, y)).filter((z): z is Interval => Boolean(z))), integer);
}
function complement(xs: Interval[], integer = false): Interval[] {
  const values = normalize(xs, integer);
  if (!values.length) return all;
  const out: Interval[] = [];
  let low: Bound | undefined;
  for (const item of values) {
    if (item.low) {
      const gap: Interval = { low, high: { value: item.low.value, inclusive: !item.low.inclusive } };
      if (valid(gap) && !(integer && low?.inclusive && !item.low.inclusive && item.low.value - low.value <= 1)) out.push(gap);
    }
    if (!item.high) return out;
    low = { value: item.high.value, inclusive: !item.high.inclusive };
  }
  out.push({ low });
  return out;
}
function numericPredicate(expr: NumericExpression, integer: boolean): Analysis {
  if (!expr || typeof expr !== 'object' || typeof expr.op !== 'string') return { unknown: 'A expressão não é comparação numérica suportada' };
  const op = expr.op;
  if (op === 'and' || op === 'or') {
    if (!Array.isArray(expr.args) || !expr.args.length) return { unknown: 'Expressão lógica inválida' };
    const children = expr.args.map((arg: NumericExpression) => numericPredicate(arg, integer));
    if (children.some(x => 'unknown' in x)) return children.find(x => 'unknown' in x) as { unknown: string };
    const keyed = children as Array<{ key: string; intervals: Interval[] }>;
    if (keyed.some(x => x.key !== keyed[0].key)) return { unknown: 'A expressão combina variáveis diferentes' };
    return { key: keyed[0].key, intervals: keyed.slice(1).reduce((acc, x) => op === 'and' ? intersection(acc, x.intervals, integer) : union(acc, x.intervals, integer), keyed[0].intervals) };
  }
  if (op === 'not') {
    const inner = numericPredicate(expr.arg, integer);
    return 'unknown' in inner ? inner : { key: inner.key, intervals: complement(inner.intervals, integer) };
  }
  if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(op)) return { unknown: 'Operador sem redução segura para intervalos' };
  const left = expr.left as NumericExpression;
  const right = expr.right as NumericExpression;
  let key: string; let value: number; let normalizedOp = op;
  if (typeof left?.var === 'string' && typeof right?.literal === 'number' && Number.isFinite(right.literal)) { key = left.var; value = right.literal; }
  else if (typeof right?.var === 'string' && typeof left?.literal === 'number' && Number.isFinite(left.literal)) {
    key = right.var; value = left.literal;
    normalizedOp = ({ lt: 'gt', lte: 'gte', gt: 'lt', gte: 'lte', eq: 'eq', ne: 'ne' } as Record<string, string>)[op];
  } else return { unknown: 'É necessário comparar uma variável numérica com literal numérico finito' };
  let result: Interval[];
  if (integer) {
    const floor = Math.floor(value), ceil = Math.ceil(value);
    if (normalizedOp === 'eq') result = Number.isInteger(value) ? [{ low: { value, inclusive: true }, high: { value, inclusive: true } }] : empty;
    else if (normalizedOp === 'ne') result = complement(Number.isInteger(value) ? [{ low: { value, inclusive: true }, high: { value, inclusive: true } }] : empty, true);
    else if (normalizedOp === 'lt') result = [{ high: { value: ceil - 1, inclusive: true } }];
    else if (normalizedOp === 'lte') result = [{ high: { value: floor, inclusive: true } }];
    else if (normalizedOp === 'gt') result = [{ low: { value: floor + 1, inclusive: true } }];
    else result = [{ low: { value: ceil, inclusive: true } }];
  } else if (normalizedOp === 'eq') result = [{ low: { value, inclusive: true }, high: { value, inclusive: true } }];
  else if (normalizedOp === 'ne') result = complement([{ low: { value, inclusive: true }, high: { value, inclusive: true } }]);
  else if (normalizedOp === 'lt') result = [{ high: { value, inclusive: false } }];
  else if (normalizedOp === 'lte') result = [{ high: { value, inclusive: true } }];
  else if (normalizedOp === 'gt') result = [{ low: { value, inclusive: false } }];
  else result = [{ low: { value, inclusive: true } }];
  return { key, intervals: normalize(result, integer) };
}

/** Analyze conditions on one XOR split. Only proven numeric partitions yield errors. */
export function analyzeNumericXor(routes: NumericRoute[], variables: Array<{ key: string; type: string }>): NumericXorIssue[] {
  const conditional = routes.filter(route => route.condition && !route.isDefault);
  if (conditional.length === 0) return [];
  const variableByKey = new Map(variables.map(variable => [variable.key, variable]));
  const firstVariable = (expr: any, seen = new WeakSet<object>()): string | undefined => {
    if (!expr || typeof expr !== 'object' || seen.has(expr)) return undefined;
    seen.add(expr);
    if (typeof expr?.var === 'string') return expr.var;
    for (const child of [expr?.left, expr?.right, expr?.arg, ...(Array.isArray(expr?.args) ? expr.args : [])]) {
      const found = firstVariable(child, seen); if (found) return found;
    }
    return undefined;
  };
  const analyses = conditional.map(route => ({ route, analysis: numericPredicate(route.condition!, variableByKey.get(firstVariable(route.condition) || '')?.type === 'integer') }));
  const unknown = analyses.find(({ analysis }) => 'unknown' in analysis);
  if (unknown) return [{ code: 'GATEWAY_CONDITION_UNPROVABLE', routeIds: conditional.map(route => route.id), message: 'Não foi possível provar a partição numérica das condições deste gateway', severity: 'warning' }];
  const known = analyses as Array<{ route: NumericRoute; analysis: { key: string; intervals: Interval[] } }>;
  const key = known[0].analysis.key;
  const type = variableByKey.get(key)?.type;
  if (!['integer', 'decimal'].includes(type || '') || known.some(item => item.analysis.key !== key))
    return [{ code: 'GATEWAY_CONDITION_UNPROVABLE', routeIds: conditional.map(route => route.id), message: 'Condições não usam o mesmo campo numérico', severity: 'warning' }];
  const issues: NumericXorIssue[] = [];
  for (const { route, analysis } of known) if (!analysis.intervals.length)
    issues.push({ code: 'GATEWAY_CONDITION_EMPTY', routeIds: [route.id], message: 'A condição desta rota é contraditória e nunca pode ser verdadeira', severity: 'error' });
  for (let i = 0; i < known.length; i++) for (let j = i + 1; j < known.length; j++) {
    if (intersection(known[i].analysis.intervals, known[j].analysis.intervals, type === 'integer').length)
      issues.push({ code: 'GATEWAY_CONDITION_OVERLAP', routeIds: [known[i].route.id, known[j].route.id], message: 'As condições destas rotas podem ser verdadeiras simultaneamente', severity: 'error' });
  }
  if (issues.some(issue => issue.code === 'GATEWAY_CONDITION_OVERLAP' || issue.code === 'GATEWAY_CONDITION_EMPTY')) return issues;
  const coverage = known.reduce((acc, item) => union(acc, item.analysis.intervals, type === 'integer'), empty);
  const hasDefault = routes.some(route => route.isDefault);
  if (!hasDefault && complement(coverage, type === 'integer').length) issues.push({ code: 'GATEWAY_CONDITION_GAP', routeIds: known.map(item => item.route.id), message: 'As condições deixam valores numéricos sem rota e o gateway não possui default', severity: 'error' });
  return issues;
}
