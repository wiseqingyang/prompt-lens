/**
 * Micro-JSONPath Evaluator for PromptLens Schema Engine
 * High-speed property query supporting array wildcards, property filters, and fallback paths.
 * Zero external dependencies, execution in <0.05ms.
 */

export function queryPath(obj: any, path: string): any[] {
  if (!obj || !path) return [];
  const parts = path.split('.');
  let current: any[] = [obj];

  for (const part of parts) {
    const next: any[] = [];

    // Filter pattern: e.g. [?thought], [?!thought], parts[?thought]
    const filterMatch = part.match(/^([^\[]*)\[\?([^\]]+)\]$/);
    // Wildcard pattern: e.g. [], [*], candidates[], candidates[*]
    const arrayMatch = part.match(/^([^\[]*)\[\*?\]$/);

    for (const item of current) {
      if (!item || typeof item !== 'object') continue;

      if (filterMatch) {
        const prop = filterMatch[1];
        const cond = filterMatch[2].trim();
        const base = prop ? item[prop] : item;
        if (!base) continue;
        const list = Array.isArray(base) ? base : [base];
        for (const elem of list) {
          if (!elem || typeof elem !== 'object') continue;
          if (cond.startsWith('!')) {
            const key = cond.slice(1);
            if (!elem[key]) next.push(elem);
          } else if (cond.includes('!=')) {
            const [k, v] = cond.split('!=').map((s) => s.trim().replace(/^["']|["']$/g, ''));
            if (elem[k] !== v) next.push(elem);
          } else if (cond.includes('==')) {
            const [k, v] = cond.split('==').map((s) => s.trim().replace(/^["']|["']$/g, ''));
            if (elem[k] === v) next.push(elem);
          } else {
            if (elem[cond]) next.push(elem);
          }
        }
      } else if (arrayMatch) {
        const prop = arrayMatch[1];
        const base = prop ? item[prop] : item;
        if (!base) continue;
        if (Array.isArray(base)) {
          next.push(...base);
        } else {
          next.push(base);
        }
      } else {
        // Simple property access
        if (Array.isArray(item)) {
          for (const elem of item) {
            if (elem && typeof elem === 'object' && elem[part] !== undefined) {
              next.push(elem[part]);
            }
          }
        } else {
          if (item[part] !== undefined) {
            next.push(item[part]);
          }
        }
      }
    }

    current = next;
    if (current.length === 0) break;
  }

  return current;
}

export function queryFirst(obj: any, paths: string | string[]): any {
  if (!obj || !paths) return undefined;
  const pathList = Array.isArray(paths) ? paths : [paths];

  for (const p of pathList) {
    const results = queryPath(obj, p);
    for (const r of results) {
      if (r !== undefined && r !== null && r !== '') {
        return r;
      }
    }
  }

  return undefined;
}
