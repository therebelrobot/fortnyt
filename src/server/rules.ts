// Rules turn bank descriptions into budget lines. First enabled match wins, by
// priority (lower first) then id. Rules never touch a transaction someone assigned by hand.

import type { Rule, Txn } from '../shared/types';

type Matchable = Pick<Txn, 'description' | 'payee' | 'memo' | 'amountCents' | 'accountId'>;

const regexCache = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  if (!regexCache.has(pattern)) {
    try {
      regexCache.set(pattern, new RegExp(pattern, 'i'));
    } catch {
      regexCache.set(pattern, null);
    }
  }
  return regexCache.get(pattern)!;
}

export function isValidRegex(pattern: string): boolean {
  return compile(pattern) !== null;
}

function fieldText(rule: Rule, t: Matchable): string[] {
  switch (rule.field) {
    case 'description':
      return [t.description];
    case 'payee':
      return [t.payee ?? ''];
    case 'memo':
      return [t.memo ?? ''];
    default:
      return [t.description, t.payee ?? '', t.memo ?? ''];
  }
}

export function ruleMatches(rule: Rule, t: Matchable): boolean {
  if (!rule.enabled || !rule.pattern) return false;
  if (rule.accountId && rule.accountId !== t.accountId) return false;
  if (rule.direction === 'out' && t.amountCents >= 0) return false;
  if (rule.direction === 'in' && t.amountCents <= 0) return false;
  const abs = Math.abs(t.amountCents);
  if (rule.minCents != null && abs < rule.minCents) return false;
  if (rule.maxCents != null && abs > rule.maxCents) return false;

  const needle = rule.pattern.trim().toLowerCase();
  return fieldText(rule, t).some((raw) => {
    const hay = raw.toLowerCase();
    switch (rule.match) {
      case 'exact':
        return hay.trim() === needle;
      case 'starts':
        return hay.trimStart().startsWith(needle);
      case 'regex': {
        const re = compile(rule.pattern);
        return re ? re.test(raw) : false;
      }
      default:
        return hay.includes(needle);
    }
  });
}

export function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
}

export function firstMatch(sortedRules: Rule[], t: Matchable): Rule | null {
  for (const r of sortedRules) if (ruleMatches(r, t)) return r;
  return null;
}
