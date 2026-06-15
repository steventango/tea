import Database, { DB, PartitionElement } from './database';
import { IDBPDatabase } from 'idb';
import Fuse from 'fuse.js';
import { MDCChipSet } from '@material/chips';
import Color from 'color';

const PAGE_SIZE = 100;
const SEARCH_RESULT_LIMIT = 2200;
const SEARCH_FUZZY_LIMIT = 0.08;
const SEARCH_TERM_SCORE_FOR_MATCH = 90;
const SEARCH_DIRECT_MATCH_MIN_LENGTH = 3;
const TONE_DIGITS = /\d+/g;
const SPACES = /\s+/g;
const LETTERS_AND_NUMBERS = /^[a-z0-9]+$/;
const DEFAULT_PARTITION_PROBABILITIES = [0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125];
const WORDSET_PARTITIONS = ['0', '1', '2', '3', '4', '5', '6', '7', 'learned'];
const STATS_DATE_FORMAT = new Intl.DateTimeFormat(navigator.language || 'en-US', {
  month: 'short',
  day: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

type SearchScope = 'all' | 'character' | 'simplified' | 'pinyin' | 'jyutping' | 'definition' | 'hsk';

const SEARCH_PLACEHOLDERS: Record<SearchScope, string> = {
  all: 'characters, pinyin, jyutping, definitions, HSK',
  character: 'Chinese characters',
  simplified: 'simplified characters',
  pinyin: 'pinyin (bai, laoshi, xiangjiao)',
  jyutping: 'jyutping (maa5, gong2)',
  definition: 'English definition',
  hsk: 'HSK level',
};

type QueueState = 'selected' | 'queued' | 'add';

type SearchablePartitionElement = PartitionElement & {
  searchText: string;
};

type SearchableIndexEntry = SearchablePartitionElement & {
  pinyin: string;
  jyutping: string;
  pinyinNoSpace: string;
  jyutpingNoSpace: string;
  pinyinNoToneNoSpace: string;
  jyutpingNoToneNoSpace: string;
  definitionsText: string;
  definitionsNoSpace: string;
  definitionsNoToneNoSpace: string;
  hskText: string;
  status: string;
  normT: string;
  normS: string;
  normPinyin: string;
  normJyutping: string;
  normDefinitionsText: string;
};

const SCOPE_PREFIXES: Record<string, SearchScope> = {
  all: 'all',
  a: 'all',
  char: 'character',
  character: 'character',
  c: 'character',
  simp: 'simplified',
  simplified: 'simplified',
  s: 'simplified',
  p: 'pinyin',
  py: 'pinyin',
  pinyin: 'pinyin',
  j: 'jyutping',
  jy: 'jyutping',
  jyut: 'jyutping',
  jyutping: 'jyutping',
  e: 'definition',
  d: 'definition',
  def: 'definition',
  definition: 'definition',
  en: 'definition',
  eng: 'definition',
  english: 'definition',
  h: 'hsk',
  hsk: 'hsk',
};

type StateFilter = 'all' | 'learned' | 'learning' | 'selected' | 'unlearned';

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();
}

function buildSearchVariants(value: string) {
  const query = normalizeText(value);
  return {
    query,
    noTone: query.replace(TONE_DIGITS, ''),
    noSpace: query.replace(SPACES, ''),
    noToneNoSpace: query.replace(TONE_DIGITS, '').replace(SPACES, ''),
  };
}

function buildSearchTermScore(entry: SearchableIndexEntry, terms: Array<string>, scope: SearchScope) {
  let score = 0;
  for (const term of terms) {
    if (!term) {
      continue;
    }

    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) {
      continue;
    }
    const normalizedTermNoTone = normalizedTerm.replace(TONE_DIGITS, '');
    const hasToneNumber = normalizedTerm !== normalizedTermNoTone;
    const normalizedTermNoSpace = normalizedTerm.replace(SPACES, '');
    const hasNormalizedTerm = normalizedTerm.length > 0;
    const hasNormalizedTermNoTone = normalizedTermNoTone.length > 0;
    const hasNormalizedTermNoSpace = normalizedTermNoSpace.length > 0;

    const defExactToken = entry.normDefinitionsText.split(/\s+/).includes(normalizedTerm);
    const pinyinExactToken = entry.normPinyin.split(/\s+/).includes(normalizedTerm);
    const pinyinNoToneToken = normalizedTermNoTone
      ? entry.normPinyin.split(/\s+/).includes(normalizedTermNoTone)
      : false;
    const pinyinNoSpaceToken = normalizedTermNoSpace
      ? entry.pinyinNoSpace.includes(normalizedTermNoSpace)
      : false;
    const pinyinNoToneNoSpaceToken = normalizedTermNoTone
      ? entry.pinyinNoToneNoSpace.includes(normalizedTermNoTone)
      : false;
    const jyutpingExactToken = entry.normJyutping.split(/\s+/).includes(normalizedTerm);
    const jyutpingNoToneToken = normalizedTermNoTone
      ? entry.normJyutping.split(/\s+/).includes(normalizedTermNoTone)
      : false;
    const jyutpingNoSpaceToken = normalizedTermNoSpace
      ? entry.jyutpingNoSpace.includes(normalizedTermNoSpace)
      : false;
    const jyutpingNoToneNoSpaceToken = normalizedTermNoTone
      ? entry.jyutpingNoToneNoSpace.includes(normalizedTermNoTone)
      : false;

    const matchDefinition = scope === 'all' || scope === 'definition';
    const matchCharacter = scope === 'all' || scope === 'character';
    const matchSimplified = scope === 'all' || scope === 'simplified';
    const matchPinyin = scope === 'all' || scope === 'pinyin';
    const matchJyutping = scope === 'all' || scope === 'jyutping';
    const matchHsk = scope === 'all' || scope === 'hsk';

    if (matchDefinition && hasNormalizedTerm) {
      if (defExactToken) {
        score += 260;
      } else if (entry.normDefinitionsText.includes(normalizedTerm)) {
        score += 170;
      }
      if (entry.normDefinitionsText.startsWith(normalizedTerm)) {
        score += 60;
      }
    }

    if (matchCharacter && hasNormalizedTerm && entry.normT === normalizedTerm) {
      score += 220;
    } else if (matchCharacter && hasNormalizedTerm && entry.normT.startsWith(normalizedTerm)) {
      score += 150;
    } else if (matchCharacter && hasNormalizedTerm && entry.normT.includes(normalizedTerm)) {
      score += 90;
    }
    if (matchSimplified && hasNormalizedTerm && entry.normS === normalizedTerm) {
      score += 190;
    } else if (matchSimplified && hasNormalizedTerm && entry.normS.startsWith(normalizedTerm)) {
      score += 140;
    } else if (matchSimplified && hasNormalizedTerm && entry.normS.includes(normalizedTerm)) {
      score += 80;
    }
    if (matchPinyin && hasNormalizedTerm && pinyinExactToken) {
      score += 180;
    } else if (matchPinyin && hasNormalizedTermNoTone && pinyinNoToneToken) {
      score += 170;
    } else if (matchPinyin && hasNormalizedTermNoSpace && pinyinNoSpaceToken) {
      score += 140;
    } else if (matchPinyin && hasNormalizedTermNoTone && pinyinNoToneNoSpaceToken) {
      score += 130;
    } else if (matchPinyin && hasNormalizedTerm && entry.normPinyin.includes(normalizedTerm)) {
      score += 110;
    } else if (matchPinyin && hasToneNumber && hasNormalizedTermNoTone && entry.normPinyin.includes(normalizedTermNoTone)) {
      score += 100;
    }
    if (matchJyutping && hasNormalizedTerm && jyutpingExactToken) {
      score += 130;
    } else if (matchJyutping && hasNormalizedTermNoTone && jyutpingNoToneToken) {
      score += 110;
    } else if (matchJyutping && hasNormalizedTermNoSpace && jyutpingNoSpaceToken) {
      score += 80;
    } else if (matchJyutping && hasNormalizedTermNoTone && jyutpingNoToneNoSpaceToken) {
      score += 70;
    } else if (matchJyutping && hasNormalizedTerm && entry.normJyutping.includes(normalizedTerm)) {
      score += 90;
    } else if (matchJyutping && hasToneNumber && hasNormalizedTermNoTone && entry.normJyutping.includes(normalizedTermNoTone)) {
      score += 80;
    }
    if (matchHsk && hasNormalizedTerm && entry.hskText.includes(normalizedTerm)) {
      score += 60;
    }
  }

  return score;
}

function parseSearchTerms(query: string) {
  return query.split(/\s+/).filter(Boolean);
}

function parseSearchQuery(rawQuery: string): { scope: SearchScope; query: string } {
  const match = rawQuery.trim().match(/^([A-Za-z]+)\s*:\s*(.+)$/);
  if (!match) {
    return { scope: 'all', query: rawQuery };
  }
  const requestedScope = SCOPE_PREFIXES[match[1].toLowerCase()];
  if (!requestedScope) {
    return { scope: 'all', query: rawQuery };
  }
  return { scope: requestedScope, query: match[2] || '' };
}

function parseProbabilitiesForWordSet(probabilities: unknown) {
  if (!Array.isArray(probabilities) || probabilities.length < WORDSET_PARTITIONS.length) {
    return DEFAULT_PARTITION_PROBABILITIES;
  }

  const safe = probabilities.map((value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, value);
    }
    return 0;
  });
  if (!safe.some((value) => value > 0)) {
    return DEFAULT_PARTITION_PROBABILITIES;
  }
  return safe.slice(0, WORDSET_PARTITIONS.length);
}

function getSelectedPartitionIndexes(probabilities: Array<number>) {
  const selected = new Set<number>();
  probabilities.forEach((value, index) => {
    if (value > 0) {
      selected.add(index);
    }
  });
  return selected;
}

function getSearchKeysForScope(scope: SearchScope) {
  switch (scope) {
    case 'all':
      return [
        { name: 't', weight: 1 },
        { name: 's', weight: 0.95 },
        { name: 'definitionsText', weight: 1 },
        { name: 'definitionsNoSpace', weight: 0.75 },
        { name: 'definitionsNoToneNoSpace', weight: 0.85 },
        { name: 'pinyin', weight: 0.85 },
        { name: 'pinyinNoSpace', weight: 0.85 },
        { name: 'pinyinNoToneNoSpace', weight: 0.9 },
        { name: 'jyutping', weight: 0.6 },
        { name: 'jyutpingNoSpace', weight: 0.6 },
        { name: 'jyutpingNoToneNoSpace', weight: 0.65 },
        { name: 'hskText', weight: 0.25 },
      ];
    case 'character':
      return [{ name: 't', weight: 1 }];
    case 'simplified':
      return [{ name: 's', weight: 1 }];
    case 'pinyin':
      return [
        { name: 'pinyin', weight: 1 },
        { name: 'pinyinNoSpace', weight: 1 },
        { name: 'pinyinNoToneNoSpace', weight: 1 },
      ];
    case 'jyutping':
      return [
        { name: 'jyutping', weight: 1 },
        { name: 'jyutpingNoSpace', weight: 1 },
        { name: 'jyutpingNoToneNoSpace', weight: 1 },
      ];
    case 'definition':
      return [
        { name: 'definitionsText', weight: 1 },
        { name: 'definitionsNoSpace', weight: 1.15 },
        { name: 'definitionsNoToneNoSpace', weight: 1.2 },
      ];
    case 'hsk':
      return [{ name: 'hskText', weight: 1 }];
    default:
      return undefined;
  }
}

function tokenMatchesScope(entry: SearchableIndexEntry, token: string, scope: SearchScope) {
  if (!token) {
    return false;
  }

  const normalizedToken = normalizeText(token);
  const noToneToken = normalizedToken.replace(TONE_DIGITS, '');
  const noSpaceToken = normalizedToken.replace(SPACES, '');
  const noToneNoSpaceToken = noToneToken.replace(SPACES, '');
  const hasNormalizedToken = normalizedToken.length > 0;
  const hasNoToneToken = noToneToken.length > 0;
  const hasNoSpaceToken = noSpaceToken.length > 0;
  const hasNoToneNoSpaceToken = noToneNoSpaceToken.length > 0;

  if (scope === 'character') {
    if (!hasNormalizedToken) {
      return false;
    }
    return entry.normT.includes(normalizedToken)
      || entry.normS.includes(normalizedToken);
  }
  if (scope === 'simplified') {
    return hasNormalizedToken && entry.normS.includes(normalizedToken);
  }
  if (scope === 'hsk') {
    return hasNormalizedToken
      && (entry.hskText.includes(normalizedToken)
        || (hasNoSpaceToken && entry.hskText.includes(noSpaceToken)));
  }
  if (scope === 'pinyin') {
    return (
      (hasNoSpaceToken && entry.pinyinNoSpace.includes(noSpaceToken))
      || (hasNoToneNoSpaceToken && entry.pinyinNoToneNoSpace.includes(noToneNoSpaceToken || noToneToken))
      || (hasNormalizedToken && entry.normPinyin.includes(normalizedToken))
      || (hasNoToneToken && entry.normPinyin.includes(noToneToken))
    );
  }
  if (scope === 'jyutping') {
    return (
      (hasNoSpaceToken && entry.jyutpingNoSpace.includes(noSpaceToken))
      || (hasNoToneNoSpaceToken && entry.jyutpingNoToneNoSpace.includes(noToneNoSpaceToken || noToneToken))
      || (hasNormalizedToken && entry.normJyutping.includes(normalizedToken))
      || (hasNoToneToken && entry.normJyutping.includes(noToneToken))
    );
  }
  if (scope === 'definition') {
    return (hasNormalizedToken && entry.normDefinitionsText.includes(normalizedToken))
      || (hasNoSpaceToken && entry.definitionsNoSpace.includes(noSpaceToken))
      || (hasNoToneNoSpaceToken && entry.definitionsNoToneNoSpace.includes(noToneNoSpaceToken));
  }

  return (hasNormalizedToken && (
    entry.normT.includes(normalizedToken)
    || entry.normS.includes(normalizedToken)
    || entry.normPinyin.includes(normalizedToken)
    || entry.normJyutping.includes(normalizedToken)
    || entry.hskText.includes(normalizedToken)
  ))
    || (hasNoSpaceToken && (
      entry.definitionsNoSpace.includes(noSpaceToken)
      || entry.pinyinNoSpace.includes(noSpaceToken)
      || entry.jyutpingNoSpace.includes(noSpaceToken)
      || entry.hskText.includes(noSpaceToken)
    ))
    || (hasNoToneNoSpaceToken && (
      entry.definitionsNoToneNoSpace.includes(noToneNoSpaceToken)
      || entry.pinyinNoToneNoSpace.includes(noToneNoSpaceToken || noToneToken)
      || entry.jyutpingNoToneNoSpace.includes(noToneNoSpaceToken || noToneToken)
    ));
}

function matchesSearchTerms(entry: SearchableIndexEntry, terms: Array<string>, scope: SearchScope) {
  if (terms.length === 0) {
    return true;
  }
  return terms.every((term) => tokenMatchesScope(entry, term, scope));
}

function getDirectMatchCandidates(
  searchScope: SearchScope,
  filter: string,
  searchableEntries: Array<SearchableIndexEntry>,
  terms: Array<string>,
) {
  const normalized = filter;
  if (!normalized || !terms.length) {
    return [];
  }

  const { noSpace, noTone, noToneNoSpace } = buildSearchVariants(filter);
  const normalizedNoSpace = noSpace;
  const normalizedNoTone = noTone;
  const normalizedNoToneNoSpace = noToneNoSpace;

  if (searchScope === 'all') {
    return searchableEntries.filter((entry) => (
      entry.normT.includes(normalized)
      || entry.normS.includes(normalized)
      || entry.normDefinitionsText.includes(normalized)
      || entry.definitionsNoSpace.includes(normalizedNoSpace)
      || entry.definitionsNoToneNoSpace.includes(normalizedNoTone)
      || entry.definitionsNoToneNoSpace.includes(normalizedNoToneNoSpace)
      || entry.normDefinitionsText.includes(normalizedNoSpace)
      || (normalizedNoSpace && entry.pinyinNoSpace.includes(normalizedNoSpace))
      || (normalizedNoToneNoSpace && entry.pinyinNoToneNoSpace.includes(normalizedNoToneNoSpace))
      || (normalizedNoSpace && entry.jyutpingNoSpace.includes(normalizedNoSpace))
      || (normalizedNoToneNoSpace && entry.jyutpingNoToneNoSpace.includes(normalizedNoToneNoSpace))
      || entry.normPinyin.includes(normalized)
      || entry.normJyutping.includes(normalized)
      || entry.hskText.includes(normalized)
    ));
  }

  if (!LETTERS_AND_NUMBERS.test(normalizedNoSpace)) {
    return [];
  }

  return searchableEntries.filter((entry) => {
    if (searchScope === 'character') {
      return entry.normT.includes(normalizedNoSpace) || entry.normS.includes(normalizedNoSpace);
    }
    if (searchScope === 'simplified') {
      return entry.normS.includes(normalizedNoSpace);
    }
    if (searchScope === 'hsk') {
      return entry.hskText.includes(normalizedNoSpace);
    }
    if (searchScope === 'pinyin') {
      return (
        entry.pinyinNoSpace.includes(normalizedNoSpace)
        || entry.pinyinNoToneNoSpace.includes(normalizedNoSpace)
        || (normalizedNoToneNoSpace && entry.pinyinNoToneNoSpace.includes(normalizedNoToneNoSpace))
      );
    }
    if (searchScope === 'jyutping') {
      return (
        entry.jyutpingNoSpace.includes(normalizedNoSpace)
        || entry.jyutpingNoToneNoSpace.includes(normalizedNoSpace)
        || (normalizedNoToneNoSpace && entry.jyutpingNoToneNoSpace.includes(normalizedNoToneNoSpace))
      );
    }
    if (searchScope === 'definition') {
      return terms.every((term) => entry.normDefinitionsText.includes(term));
    }
    return false;
  });
}

function createEmptyStats() {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    strength: 0,
    lastLearnedAt: 0,
    lastReviewedAt: 0,
  };
}

function formatDate(value: number | undefined): string {
  if (!value) {
    return '—';
  }
  return STATS_DATE_FORMAT.format(new Date(value));
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightTextNode(container: HTMLElement, rawValue: string, terms: Array<string>) {
  const filteredTerms = Array.from(new Set(terms))
    .map((term) => term.trim())
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 0)
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length);

  if (filteredTerms.length === 0) {
    container.textContent = rawValue;
    return;
  }

  const pattern = new RegExp(`(${filteredTerms.join('|')})`, 'giu');
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(rawValue)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(rawValue.slice(lastIndex, match.index)));
    }

    const matchSpan = document.createElement('span');
    matchSpan.className = 'stats-match-highlight';
    matchSpan.textContent = match[0];
    container.appendChild(matchSpan);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < rawValue.length) {
    container.appendChild(document.createTextNode(rawValue.slice(lastIndex)));
  }

  if (lastIndex === 0) {
    container.textContent = rawValue;
  }
}

function createHighlightedTextCell(value: string | number, terms: Array<string>, label?: string) {
  const rawValue = String(value);
  const cell = document.createElement('div');
  const valueNode = document.createElement('span');
  cell.className = 'stats-card-field';
  valueNode.className = 'stats-cell-value';
  cell.title = rawValue;
  valueNode.title = rawValue;
  if (rawValue === '—' || rawValue.trim() === '') {
    cell.classList.add('stats-cell-empty');
  }
  if (label) {
    cell.dataset.label = label;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'stats-card-field-label';
    labelSpan.textContent = label;
    cell.appendChild(labelSpan);
  }

  highlightTextNode(valueNode, rawValue, terms);
  cell.appendChild(valueNode);
  return cell;
}

function formatStrength(value: number | undefined): string {
  if (!value || value < 0 || !Number.isFinite(value)) {
    return '0%';
  }
  return `${Math.round(value * 100)}%`;
}

function getCalculatedStrength(stats: any): number {
  if (!stats || !stats.attempts || stats.attempts <= 0) {
    return 0;
  }
  const successes = stats.successes || 0;
  const attempts = stats.attempts;
  const accuracy = successes / attempts;
  const volumeFactor = Math.min(1, successes / 5);
  return accuracy * volumeFactor;
}

function formatHsk(entry: PartitionElement) {
  if (!entry.h || entry.h <= 0) {
    return '';
  }
  return String(entry.h);
}

function ensureStats(entry: PartitionElement) {
  if (!entry.stats) {
    entry.stats = createEmptyStats();
  }
  return entry.stats;
}

function normalizeBuckets(raw: unknown): Array<PartitionElement[]> {
  const buckets: Array<PartitionElement[]> = [];

  if (!raw) {
    return buckets;
  }

  const values = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>);
  for (const bucket of values) {
    if (Array.isArray(bucket)) {
      buckets.push(bucket as PartitionElement[]);
    }
  }
  return buckets;
}

function mergeEntriesByCharacter(buckets: Array<PartitionElement[]>) {
  const merged = new Map<string, PartitionElement>();
  for (const bucket of buckets) {
    for (const entry of bucket) {
      if (!entry || !entry.t) {
        continue;
      }

      const existing = merged.get(entry.t);
      if (!existing) {
        merged.set(entry.t, entry);
        continue;
      }

      const existingActivity = Math.max(existing.stats?.lastReviewedAt || 0, existing.stats?.lastLearnedAt || 0);
      const entryActivity = Math.max(entry.stats?.lastReviewedAt || 0, entry.stats?.lastLearnedAt || 0);
      if (entryActivity > existingActivity) {
        merged.set(entry.t, entry);
      }
    }
  }
  return merged;
}

function makeSearchText(entry: PartitionElement, queued?: Set<string>) {
  const definitions = Array.isArray(entry.d) ? entry.d : [entry.d];
  return normalizeText([
    statusFor(entry, queued),
    entry.t,
    entry.s,
    entry.p.join(' '),
    entry.j.join(' '),
    entry.h ? `hsk ${entry.h}` : '',
    `hsk:${entry.h || 0}`,
    ...definitions
  ].join(' ')
    .trim());
}

function formatPageLabel(visible: number, total: number) {
  if (total <= 0) {
    return 'No words';
  }
  return `Showing ${visible} of ${total}`;
}

function statusFor(entry: PartitionElement, queued?: Set<string>): 'learned' | 'learning' | 'unlearned' {
  const isQueued = queued ? queued.has(entry.t) : false;
  if (isQueued) {
    return 'learning';
  }
  const isLearned = (entry.correct !== undefined && entry.correct >= 2)
    || (entry.stats?.lastLearnedAt || 0) > 0;
  if (isLearned) {
    return 'learned';
  }
  const attempts = entry.stats?.attempts || 0;
  if (attempts > 0) {
    return 'learning';
  }
  return 'unlearned';
}

function isVisibleWithoutSearch(entry: PartitionElement, queued?: Set<string>) {
  return statusFor(entry, queued) !== 'unlearned';
}

function matchStateFilter(entry: SearchablePartitionElement, filter: StateFilter, queued: Set<string>, isSelected: (entry: SearchablePartitionElement) => boolean) {
  if (filter === 'all') {
    return true;
  }

  if (filter === 'selected') {
    return isSelected(entry);
  }

  if (filter === 'learned') {
    return statusFor(entry, queued) === 'learned';
  }

  if (filter === 'learning') {
    return statusFor(entry, queued) === 'learning';
  }

  return statusFor(entry, queued) === 'unlearned';
}

function statusLabel(entry: PartitionElement, queued?: Set<string>): string {
  switch (statusFor(entry, queued)) {
    case 'learned':
      return 'Learned';
    case 'learning':
      return 'Learning';
    default:
      return 'Unlearned';
  }
}

function createTextCell(value: string | number, terms: Array<string> = [], label?: string, className?: string) {
  const cell = createHighlightedTextCell(value, terms, label);
  if (className) {
    cell.classList.add(className);
  }
  return cell;
}

function createDefinitionCell(value: string | number, terms: Array<string> = [], label?: string, className?: string) {
  const highlightedCell = createHighlightedTextCell(value, terms, label);
  highlightedCell.classList.add('stats-definition-cell');
  if (className) {
    highlightedCell.classList.add(className);
  }
  return highlightedCell;
}

function getDefinitions(entry: PartitionElement) {
  return Array.isArray(entry.d) ? entry.d : [entry.d];
}

function getQueueState(
  entry: PartitionElement,
  inQueue: boolean,
  isInSelectedSet: boolean,
): QueueState {
  if (inQueue) {
    return 'queued';
  }
  if (isInSelectedSet || statusFor(entry) === 'learned') {
    return 'selected';
  }
  return 'add';
}

function getQueueStateLabel(state: QueueState, isLearned: boolean) {
  switch (state) {
    case 'selected':
      return isLearned ? 'Learned' : 'Selected';
    case 'queued':
      return 'Queued';
    default:
      return 'Add';
  }
}

function createQueueStateBadge(state: QueueState, isLearned: boolean) {
  const label = getQueueStateLabel(state, isLearned);
  const badge = document.createElement('span');
  badge.className = `stats-state-badge stats-state-badge--${state}`;
  badge.textContent = label;
  badge.title = label;
  return badge;
}

function createActionButton(
  entry: PartitionElement,
  state: QueueState,
  onAdd: (entry: PartitionElement) => Promise<boolean>,
  isLearned: boolean,
  onStateChange?: (nextState: QueueState) => void,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mdc-icon-button mdc-icon-button--touch stats-queue-button';
  button.classList.add(`stats-queue-button--${state}`);
  const icon = document.createElement('span');
  icon.className = 'mdc-icon-button__icon material-icons';
  icon.setAttribute('aria-hidden', 'true');
  button.dataset.state = state;

  const isSelected = state === 'selected';
  const selectedLabel = isLearned ? 'Learned' : 'Selected word';
  const selectedIconFallback = isLearned ? 'check_circle' : 'bookmark';
  switch (state) {
    case 'selected':
      button.setAttribute('aria-label', selectedLabel);
      icon.textContent = selectedIconFallback;
      button.disabled = isLearned;
      break;
    case 'queued':
      button.setAttribute('aria-label', 'In queue');
      icon.textContent = 'queue';
      button.disabled = true;
      break;
    default:
      button.setAttribute('aria-label', 'Add to queue');
      icon.textContent = 'add';
      button.disabled = false;
  }

  button.title = button.getAttribute('aria-label') || 'Queue state';
  button.appendChild(icon);
  button.insertAdjacentHTML('beforeend', '<span class="mdc-icon-button__ripple"></span><span class="mdc-icon-button__touch"></span>');
  const selectedIcon = isSelected ? icon.textContent || selectedIconFallback : null;
  const secondaryLabel = document.createElement('span');
  secondaryLabel.className = 'stats-queue-button__assistive';
  secondaryLabel.textContent = state === 'add' ? 'Add to queue' : getQueueStateLabel(state, isLearned);
  button.appendChild(secondaryLabel);

  button.addEventListener('click', async () => {
    if (button.disabled) {
      return;
    }
    button.disabled = true;
    icon.textContent = 'hourglass_empty';

    try {
      const added = await onAdd(entry);
      if (added) {
        onStateChange?.('queued');
        button.disabled = true;
        icon.textContent = 'queue';
        button.setAttribute('aria-label', 'In queue');
        button.title = 'In queue';
        secondaryLabel.textContent = 'In queue';
      } else {
        button.disabled = isLearned;
        icon.textContent = selectedIcon || 'add';
        button.setAttribute('aria-label', isSelected ? selectedLabel : 'Add to queue');
        button.title = isSelected ? selectedLabel : 'Add to queue';
      }
    } catch (error) {
      console.error(error);
      button.disabled = false;
      icon.textContent = selectedIcon || 'add';
      button.setAttribute('aria-label', isSelected ? selectedLabel : 'Add to queue');
      button.title = isSelected ? selectedLabel : 'Add to queue';
    }
  });

  return button;
}

function createStrengthCell(value: number | undefined, label?: string, className?: string) {
  const cell = document.createElement('div');
  cell.className = 'stats-card-field';
  if (label) {
    cell.dataset.label = label;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'stats-card-field-label';
    labelSpan.textContent = label;
    cell.appendChild(labelSpan);
  }
  if (className) {
    cell.classList.add(className);
  }

  cell.classList.add('stats-strength-cell');

  const container = document.createElement('div');
  container.className = 'stats-strength-container';

  const wrapper = document.createElement('div');
  const strengthText = document.createElement('span');
  const ratio = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
  const pct = `${ratio}%`;

  wrapper.className = 'stats-strength-bar mdc-linear-progress';
  wrapper.setAttribute('role', 'img');
  wrapper.setAttribute('aria-label', `Strength ${pct}`);
  strengthText.className = 'stats-strength-value';
  strengthText.textContent = pct;

  wrapper.style.display = 'inline-block';

  const fill = document.createElement('div');
  fill.style.height = '100%';
  fill.style.width = `${ratio}%`;
  fill.style.background = 'var(--mdc-theme-primary)';
  
  fill.style.transition = 'width 180ms linear';
  fill.setAttribute('aria-hidden', 'true');
  wrapper.title = `${ratio}%`;
  wrapper.appendChild(fill);
  container.append(wrapper, strengthText);
  cell.appendChild(container);

  return cell;
}

function createStatRows(
  entry: PartitionElement,
  queueState: QueueState,
  onAdd: (entry: PartitionElement) => Promise<boolean>,
  isLearned: boolean,
  searchTerms: Array<string>,
) {
  const cellContainer = document.createElement('div');
  cellContainer.className = 'mdc-layout-grid__cell mdc-layout-grid__cell--span-4';

  const card = document.createElement('div');
  card.className = 'mdc-card stats-card';
  card.classList.add(`stats-row--${queueState}`);
  if (isLearned) {
    card.classList.add('stats-row--learned');
  }

  const stats = ensureStats(entry);

  const charCell = createTextCell(entry.t, searchTerms, undefined, 'stats-char-cell');
  
  const valueNode = charCell.querySelector('.stats-cell-value') as HTMLElement;
  if (entry.s && entry.s !== entry.t && valueNode) {
    valueNode.appendChild(document.createTextNode(' '));
    const simpSpan = document.createElement('span');
    simpSpan.className = 'stats-simplified-text';
    highlightTextNode(simpSpan, entry.s, searchTerms);
    valueNode.appendChild(simpSpan);
  }

  charCell.appendChild(createQueueStateBadge(queueState, isLearned));
  const statusBadge = charCell.querySelector('.stats-state-badge') as HTMLElement | null;

  const updateQueueStateVisuals = (nextState: QueueState) => {
    card.classList.remove('stats-row--selected', 'stats-row--queued', 'stats-row--add');
    card.classList.add(`stats-row--${nextState}`);

    if (statusBadge) {
      const nextLabel = getQueueStateLabel(nextState, isLearned);
      statusBadge.textContent = nextLabel;
      statusBadge.title = nextLabel;
      statusBadge.className = `stats-state-badge stats-state-badge--${nextState}`;
    }

    const selectedLabel = isLearned ? 'Learned' : 'Selected word';
    const fallbackIcon = isLearned ? 'check_circle' : 'bookmark';
    const actionButton = actionButtonRef;

    if (!actionButton) {
      return;
    }
    const secondaryLabel = actionButton.querySelector('.stats-queue-button__assistive') as HTMLSpanElement | null;
    actionButton.classList.remove('stats-queue-button--add', 'stats-queue-button--selected', 'stats-queue-button--queued');
    actionButton.classList.add(`stats-queue-button--${nextState}`);
    actionButton.dataset.state = nextState;
    const nextLabelVal = nextState === 'selected'
      ? selectedLabel
      : nextState === 'queued'
        ? 'Remove from queue'
        : 'Add to queue';
    actionButton.title = nextLabelVal;
    actionButton.setAttribute('aria-label', nextLabelVal);
    if (secondaryLabel) {
      secondaryLabel.textContent = nextLabelVal;
    }

    const actionButtonIcon = actionButton.querySelector('.mdc-icon-button__icon');
    if (actionButtonIcon) {
      actionButtonIcon.textContent = nextState === 'selected'
        ? (isLearned ? 'check_circle' : fallbackIcon)
        : nextState === 'queued'
          ? 'queue'
          : 'add';
    }
  };

  let actionButtonRef: HTMLButtonElement | null = null;

  card.appendChild(charCell);
  card.appendChild(createTextCell(entry.s || '—', searchTerms, 'Simplified', 'stats-simplified-cell'));
  card.appendChild(createTextCell(entry.p.join(', ') || '—', searchTerms, 'Pinyin', 'stats-pinyin-cell'));
  card.appendChild(createTextCell(entry.j.join(', ') || '—', searchTerms, 'Jyutping', 'stats-jyutping-cell'));
  card.appendChild(createDefinitionCell(getDefinitions(entry).join(' · ') || '—', searchTerms, 'Definition', 'stats-definition-cell-primary'));
  card.appendChild(createTextCell(formatHsk(entry) || '—', searchTerms, 'HSK', 'stats-hsk-cell'));
  card.appendChild(createStrengthCell(getCalculatedStrength(stats), 'Strength', 'stats-strength-cell'));
  card.appendChild(createTextCell(formatDate(stats.lastLearnedAt), [], 'Last learned', 'stats-meta-cell'));
  card.appendChild(createTextCell(formatDate(stats.lastReviewedAt), [], 'Last reviewed', 'stats-meta-cell'));

  const actionCell = document.createElement('div');
  actionCell.className = 'stats-card-field stats-action-cell';
  actionCell.dataset.label = 'Queue';
  const actionButton = createActionButton(entry, queueState, onAdd, isLearned, updateQueueStateVisuals);
  actionButtonRef = actionButton;
  actionCell.appendChild(actionButton);
  card.appendChild(actionCell);

  cellContainer.appendChild(card);
  return cellContainer;
}

function normalizeQuery(value: string) {
  return normalizeText(value);
}

function clearChildren(node: HTMLElement) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

async function addToLearningQueue(db: IDBPDatabase<DB>, entry: PartitionElement) {
  const tx = db.transaction(['partitions', 'partition-lengths'], 'readwrite');
  const partitionStore = tx.objectStore('partitions');
  const lengthStore = tx.objectStore('partition-lengths');

  const buffer = (await partitionStore.get('buffer')) as Array<PartitionElement> | undefined;
  const next = buffer || [];
  const alreadyQueued = next.some((item) => item.t === entry.t);
  if (alreadyQueued) {
    await tx.done;
    return false;
  }

  const clone: PartitionElement = {
    ...entry,
    t: entry.t,
    s: entry.s,
    p: [...entry.p],
    j: [...entry.j],
    d: Array.isArray(entry.d)
      ? [...entry.d]
      : [entry.d],
    correct: 0,
    stats: {
      ...ensureStats(entry),
    },
  };

  next.push(clone);
  await partitionStore.put(next, 'buffer');
  await lengthStore.put(next.length, 'buffer');
  await tx.done;

  return true;
}

function sortEntries<T extends PartitionElement>(
  entries: Array<T>,
  queuedSet?: Set<string>,
  selectedSet?: Set<string>,
) {
  return entries.sort((a, b) => {
    // 1. Sort by queued state
    if (queuedSet) {
      const aQueued = queuedSet.has(a.t);
      const bQueued = queuedSet.has(b.t);
      if (aQueued !== bQueued) {
        return aQueued ? -1 : 1;
      }
    }

    // 2. Sort by selected state
    if (selectedSet) {
      const aSelected = selectedSet.has(a.t);
      const bSelected = selectedSet.has(b.t);
      if (aSelected !== bSelected) {
        return aSelected ? -1 : 1;
      }
    }

    // 3. Fallback to last reviewed/learned timestamp
    const aLast = Math.max(a.stats?.lastReviewedAt || 0, a.stats?.lastLearnedAt || 0);
    const bLast = Math.max(b.stats?.lastReviewedAt || 0, b.stats?.lastLearnedAt || 0);
    if (aLast !== bLast) {
      return bLast - aLast;
    }
    return a.t.localeCompare(b.t);
  }) as Array<T>;
}

async function main() {
  const dbObj = await Database.build();
  const db = dbObj.db!;
  
  try {
    const themeColor = await db.get('config', 'color');
    if (themeColor) {
      const color = Color(themeColor).hsv();
      const colors = {
        stroke: color.lightness(40).hex(),
        background: color.lightness(95).hex(),
        outline: color.lightness(80).hex(),
        highlight: color.lightness(90).hex(),
        primary: color.lightness(20).hex()
      };
      document.documentElement.style.setProperty('--mdc-theme-primary', colors.primary);
      document.documentElement.style.setProperty('--mdc-theme-secondary', colors.stroke);
      document.documentElement.style.setProperty('--mdc-theme-background', colors.background);
      document.documentElement.style.setProperty('--mdc-theme-surface', colors.outline);
    }
  } catch (err) {
    console.error('Failed to update theme color:', err);
  }
  
  const rawProbabilities = await db.get('config', 'probabilities');
  const probabilities = parseProbabilitiesForWordSet(rawProbabilities);
  const selectedPartitionIndexes = getSelectedPartitionIndexes(probabilities);
  const tx = db.transaction('partitions', 'readonly');
  const rawBuckets = await Promise.all(
    WORDSET_PARTITIONS.map((partitionKey) => tx.objectStore('partitions').get(partitionKey) as Promise<Array<PartitionElement> | undefined>)
  );
  await tx.done;
  const buffer = (await db.get('partitions', 'buffer')) as Array<PartitionElement> | undefined;

  const queuedEntries = normalizeBuckets([buffer || []]).flat();
  const partitionEntries = rawBuckets.map((bucket) => normalizeBuckets([bucket || []]).flat());
  const allWordsFromSelectedPartitions = new Set<string>();
  partitionEntries.forEach((bucket, index) => {
    if (selectedPartitionIndexes.has(index)) {
      for (const entry of bucket) {
        allWordsFromSelectedPartitions.add(entry.t);
      }
    }
  });
  const queuedSet = new Set((buffer || []).map((entry) => entry.t));
  const mergedEntries = Array.from(mergeEntriesByCharacter([
    ...partitionEntries,
    queuedEntries,
  ]).values()).map((entry) => {
    const searchable = makeSearchText(entry, queuedSet);
    return {
      ...entry,
      searchText: searchable,
    };
  });

  const allEntries = sortEntries(mergedEntries, queuedSet, allWordsFromSelectedPartitions);
  const allWordCount = allEntries.length;
  const selectedWordCount = allWordsFromSelectedPartitions.size;
  const isEntrySelected = (entry: SearchablePartitionElement) => allWordsFromSelectedPartitions.has(entry.t);
  const searchableEntries: Array<SearchableIndexEntry> = allEntries.map((entry) => {
    const status = statusLabel(entry, queuedSet);
    const pinyin = entry.p.join(' ');
    const jyutping = entry.j.join(' ');
    const definitionsText = getDefinitions(entry).join(' · ');
    const normalizedDefinitions = normalizeText(definitionsText);
    const pinyinNoSpace = normalizeText(pinyin).replace(SPACES, '');
    const jyutpingNoSpace = normalizeText(jyutping).replace(SPACES, '');
    const pinyinNoToneNoSpace = normalizeText(pinyin).replace(TONE_DIGITS, '').replace(SPACES, '');
    const jyutpingNoToneNoSpace = normalizeText(jyutping).replace(TONE_DIGITS, '').replace(SPACES, '');
    return {
      ...entry,
      pinyin,
      jyutping,
      pinyinNoSpace,
      jyutpingNoSpace,
      pinyinNoToneNoSpace,
      jyutpingNoToneNoSpace,
      definitionsText,
      definitionsNoSpace: normalizedDefinitions.replace(SPACES, ''),
      definitionsNoToneNoSpace: normalizedDefinitions.replace(TONE_DIGITS, '').replace(SPACES, ''),
      hskText: `hsk ${entry.h || ''} ${entry.h ? `hsk${entry.h}` : ''}`.trim(),
      status,
      normT: normalizeText(entry.t),
      normS: normalizeText(entry.s),
      normPinyin: normalizeText(pinyin),
      normJyutping: normalizeText(jyutping),
      normDefinitionsText: normalizedDefinitions,
    };
  });
  const searchIndex = new Fuse<SearchableIndexEntry>(searchableEntries, {
    keys: [
      { name: 'definitionsText', weight: 1 },
      { name: 't', weight: 0.8 },
      { name: 's', weight: 0.8 },
      { name: 'pinyin', weight: 0.85 },
      { name: 'pinyinNoSpace', weight: 0.85 },
      { name: 'pinyinNoToneNoSpace', weight: 0.9 },
      { name: 'jyutping', weight: 0.55 },
      { name: 'jyutpingNoSpace', weight: 0.55 },
      { name: 'jyutpingNoToneNoSpace', weight: 0.6 },
      { name: 'hskText', weight: 0.2 },
    ],
    includeScore: true,
    threshold: 0.16,
    ignoreLocation: true,
    shouldSort: true,
    minMatchCharLength: 1,
    isCaseSensitive: false,
    useExtendedSearch: false,
    distance: 100,
  });
  const queued = new Set((buffer || []).map((entry) => entry.t));
  const body = document.getElementById('learned-stats-grid') as HTMLDivElement;
  const summary = document.getElementById('stats-summary')!;
  const empty = document.getElementById('stats-empty')!;
  const emptyState = document.getElementById('stats-empty-state') as HTMLDivElement | null;
  const emptySuggestion = document.getElementById('stats-empty-suggestion') as HTMLParagraphElement | null;
  const search = document.getElementById('stats-search-input') as HTMLInputElement;
  const clearSearch = document.getElementById('stats-clear-search') as HTMLButtonElement | null;
  const pageInfo = document.getElementById('stats-page-info')!;
  const tableContainer = document.getElementById('learned-stats-grid-container') as HTMLDivElement;
  const scopeChips = document.getElementById('stats-search-scope-chips') as HTMLDivElement | null;
  const stateFilterChips = document.getElementById('stats-state-filters') as HTMLDivElement | null;
  const searchStatus = document.getElementById('stats-search-status') as HTMLParagraphElement | null;
  const prefixChips = document.getElementById('stats-search-prefixes') as HTMLDivElement | null;
  const activeStateBadge = document.getElementById('stats-active-state') as HTMLSpanElement | null;
  const activeScopeBadge = document.getElementById('stats-active-scope') as HTMLSpanElement | null;
  const activeQueryBadge = document.getElementById('stats-active-query') as HTMLSpanElement | null;
  const activeResetButton = document.getElementById('stats-reset-filters') as HTMLButtonElement | null;
  const metricAll = document.getElementById('stats-metric-all')!;
  const metricSelected = document.getElementById('stats-metric-selected')!;
  const metricLearned = document.getElementById('stats-metric-learned')!;
  const metricLearning = document.getElementById('stats-metric-learning')!;
  const statsPage = document.getElementById('learned-stats-page') as HTMLDivElement | null;
  const chipSetNodes = document.querySelectorAll('.mdc-evolution-chip-set');

  chipSetNodes.forEach((chipSet) => {
    new MDCChipSet(chipSet);
  });

  const updateSearchClearVisibility = (query: string) => {
    if (!clearSearch) {
      return;
    }
    const hasQuery = query.trim().length > 0;
    clearSearch.hidden = !hasQuery;
  };

  const updateSummary = (length: number, learned: number, learning: number) => {
    summary.textContent = `Showing ${length} matching words`;
    metricAll.textContent = String(allWordCount);
    metricSelected.textContent = String(selectedWordCount);
    metricLearned.textContent = String(learned);
    metricLearning.textContent = String(learning);
  };

  const updateSearchScopePlaceholder = (scope: SearchScope) => {
    if (!search) {
      return;
    }
    search.placeholder = `Search ${SEARCH_PLACEHOLDERS[scope]}`;
  };

  const computeCounts = (entries: SearchablePartitionElement[]) => ({
    learned: entries.filter((entry) => statusFor(entry, queued) === 'learned').length,
    learning: entries.filter((entry) => statusFor(entry, queued) === 'learning').length,
  });

  const updateActiveScopeChip = (scope: SearchScope) => {
    if (!scopeChips) {
      return;
    }
    const buttons = Array.from(scopeChips.querySelectorAll<HTMLButtonElement>('button[data-scope]'));
    buttons.forEach((button) => {
      const isActive = button.getAttribute('data-scope') === scope;
      button.classList.toggle('stats-chip--selected', isActive);
      button.classList.toggle('mdc-chip--selected', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  };

  const applySearchScope = (scope: SearchScope) => {
    activeSearchScope = scope;
    updateSearchScopePlaceholder(scope);
    updateActiveScopeChip(scope);
    applyFilter(search.value);
  };

  let activeSearchTerms: Array<string> = [];
  let activeSearchQuery = '';
  let activeSearchScope: SearchScope = 'all';
  let activeStateFilter: StateFilter = 'all';

  const isEntryVisibleForActiveStateFilter = (
    entry: SearchablePartitionElement,
    includeUnlearned = false,
  ) => {
    if (activeStateFilter === 'all') {
      return includeUnlearned
        ? true
        : isVisibleWithoutSearch(entry)
          || queued.has(entry.t)
          || isEntrySelected(entry);
    }
    return matchStateFilter(entry, activeStateFilter, queued, isEntrySelected);
  };

  const updateActiveStateFilterChip = (filter: StateFilter) => {
    if (!stateFilterChips) {
      return;
    }
    const buttons = Array.from(stateFilterChips.querySelectorAll<HTMLButtonElement>('button[data-state-filter]'));
    buttons.forEach((button) => {
      const isActive = button.getAttribute('data-state-filter') === filter;
      button.classList.toggle('stats-chip--selected', isActive);
      button.classList.toggle('mdc-chip--selected', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  };

  const scopeHint: Record<SearchScope, string> = {
    all: 'all',
    character: 'character',
    simplified: 'simplified',
    pinyin: 'p:',
    jyutping: 'j:',
    definition: 'e:',
    hsk: 'h:',
  };
  const scopeLabel: Record<SearchScope, string> = {
    all: 'all fields',
    character: 'character',
    simplified: 'simplified',
    pinyin: 'pinyin',
    jyutping: 'jyutping',
    definition: 'definitions',
    hsk: 'HSK',
  };

  const formatFilterLabel = (filter: StateFilter) => filter[0].toUpperCase() + filter.slice(1);

  const updateActiveFiltersSummary = (query: string, scope: SearchScope, filter: StateFilter) => {
    if (activeStateBadge) {
      activeStateBadge.textContent = `State: ${formatFilterLabel(filter)}`;
    }
    if (activeScopeBadge) {
      activeScopeBadge.textContent = `Scope: ${scopeLabel[scope]}`;
    }
    if (activeQueryBadge) {
      const trimmed = query.trim();
      if (!trimmed) {
        activeQueryBadge.textContent = 'No query';
      } else {
        const compactQuery = trimmed.length > 28
          ? `${trimmed.slice(0, 28)}…`
          : trimmed;
        activeQueryBadge.textContent = `Query: ${compactQuery}`;
      }
    }

    if (activeResetButton) {
      const isDefault = !query.trim() && scope === 'all' && filter === 'all';
      activeResetButton.hidden = isDefault;
      activeResetButton.disabled = isDefault;
      activeResetButton.setAttribute('aria-label', isDefault
        ? 'Search filters are at defaults'
        : 'Reset search filters');
    }
  };

  const setEmptyState = (state: { searching: boolean; query: string; results: number; scope: SearchScope }) => {
    const isSearching = state.searching;
    const hasQuery = state.query.trim().length > 0;
    const prettyQuery = state.query.trim();
    const hasScopePrefixOnly = /^[a-zA-Z]+:\s*$/.test(prettyQuery);
    if (emptyState) {
      emptyState.hidden = !isSearching && state.results > 0;
    }
    empty.hidden = !isSearching && state.results > 0;
    if (emptySuggestion) {
      emptySuggestion.textContent = '';
      emptySuggestion.hidden = true;
    }

    if (isSearching) {
      empty.textContent = 'Searching…';
      if (searchStatus) {
        searchStatus.textContent = prettyQuery.length > 0
          ? `Searching ${scopeLabel[state.scope]} for “${prettyQuery}”…`
          : `Searching ${scopeLabel[state.scope]}…`;
      }
      return;
    }

    if (state.results > 0) {
      empty.textContent = '';
      if (searchStatus) {
        if (prettyQuery) {
          searchStatus.textContent = `${state.results} result${state.results === 1 ? '' : 's'} in ${scopeLabel[state.scope]}`;
        } else {
          searchStatus.textContent = '';
        }
      }
      return;
    }

    if (!hasQuery) {
      empty.textContent = 'No matching words.';
      if (searchStatus) {
        searchStatus.textContent = 'No words match your current filters.';
      }
      if (emptySuggestion) {
        emptySuggestion.textContent = 'Try adding filters like "selected" or "queued" from the legend when needed.';
        emptySuggestion.hidden = false;
      }
      return;
    }

    if (hasScopePrefixOnly) {
      const match = prettyQuery.match(/^([a-zA-Z]+):\s*$/);
      const scopeHintText = match ? SCOPE_PREFIXES[match[1].toLowerCase()] : null;
      const scopeReadable = scopeHintText ? scopeLabel[scopeHintText] : 'selected field';
      empty.textContent = `Type a search term after “${prettyQuery.trim()}”.`;
      if (searchStatus) {
        searchStatus.textContent = `Choose a value for ${scopeReadable} scope.`;
      }
      if (emptySuggestion) {
        const suggestion = scopeHintText === 'pinyin'
          ? 'Try: bian, bai, xiangjiao, lai2'
          : scopeHintText === 'definition'
            ? 'Try: banana, river, hello'
            : scopeHintText === 'jyutping'
              ? 'Try: maa1, gong2, saam1'
              : scopeHintText === 'hsk'
                ? 'Try: 1, 2, 3'
                : 'Use a word, phrase, or number.';
        emptySuggestion.textContent = `Example: ${suggestion}`;
        emptySuggestion.hidden = false;
      }
      return;
    }

    const escaped = state.query.trim().replace(/"/g, '\"');
    empty.textContent = `No matching words for "${escaped}".`;

    if (emptySuggestion) {
      const scopeSuggestion = scopeHint[state.scope] === 'all'
        ? 'Try searching a specific scope with p:/j:/e:/h: prefixes, or switch to All fields.'
        : `Try switching to "All fields" or another scope such as "${scopeHint[state.scope]}".`;
      emptySuggestion.textContent = scopeSuggestion;
      emptySuggestion.hidden = false;
    }

    if (searchStatus) {
      searchStatus.textContent = `No results for “${prettyQuery}” in ${scopeLabel[state.scope]}`;
    }
  };

  const applySearchPrefix = (prefix: string) => {
    if (!search) {
      return;
    }
    const trimmed = search.value.trim();
    const existingMatch = trimmed.match(/^[a-zA-Z]+\s*:\s*(.*)$/);
    search.value = `${prefix}${existingMatch ? existingMatch[1] : trimmed}`;
    updateSearchClearVisibility(search.value);
    applyFilter(search.value);
    search.focus();
  };

  const defaultEntries = allEntries.filter((entry) => (
    isVisibleWithoutSearch(entry, queued)
    || queued.has(entry.t)
    || isEntrySelected(entry)
  ));
  const defaultCounts = computeCounts(defaultEntries);
  const totalLearnedCount = defaultCounts.learned;
  const totalLearningCount = defaultCounts.learning;

  let searchTimeout: any = null;
  let visibleCount = PAGE_SIZE;
  let filtered: SearchablePartitionElement[] = defaultEntries;
  let learnedCount = totalLearnedCount;
  let learningCount = totalLearningCount;
  let searchRunId = 0;
  let scanning = false;
  let renderedCount = 0;
  let activeRenderRun = 0;
  let lastLoadMoreAt = 0;
  let renderedEntryKeys = new Set<string>();

  const renderRows = (runId = activeRenderRun) => {
    if (runId !== activeRenderRun) {
      return;
    }
    scanning = true;

    const visibleEntries = filtered.slice(0, visibleCount);
    setEmptyState({
      searching: false,
      query: activeSearchQuery,
      results: filtered.length,
      scope: activeSearchScope,
    });
    updateSummary(filtered.length, learnedCount, learningCount);
    pageInfo.textContent = formatPageLabel(visibleEntries.length, filtered.length);

    try {
      if (filtered.length === 0) {
        clearChildren(body);
        renderedCount = 0;
        renderedEntryKeys.clear();
        return;
      }

      if (renderedCount === 0) {
        clearChildren(body);
        renderedEntryKeys.clear();
      }

      if (renderedCount >= visibleEntries.length) {
        renderedCount = visibleEntries.length;
        return;
      }

      const start = renderedCount;
      let addedThisRender = 0;
      const fragment = document.createDocumentFragment();
      for (let i = start; i < visibleEntries.length; i++) {
        const entry = visibleEntries[i];
        if (renderedEntryKeys.has(entry.t)) {
          continue;
        }
        renderedEntryKeys.add(entry.t);
        addedThisRender += 1;
        const state = getQueueState(entry, queued.has(entry.t), isEntrySelected(entry));
        const isLearned = statusFor(entry, queued) === 'learned';
        fragment.appendChild(createStatRows(entry, state, async () => {
          const added = await addToLearningQueue(db, entry);
          if (added) {
            queued.add(entry.t);
            const counts = computeCounts(filtered);
            learningCount = counts.learning;
            updateSummary(filtered.length, learnedCount, learningCount);
          }
          return added;
        }, isLearned, activeSearchTerms));
      }

      if (addedThisRender > 0) {
        body.appendChild(fragment);
      }
      renderedCount += addedThisRender;
      renderedCount = Math.min(renderedCount, visibleEntries.length);
      if (addedThisRender === 0 && visibleEntries.length > renderedCount) {
        renderedCount = visibleEntries.length;
      }
      empty.hidden = true;
    } finally {
      scanning = false;
    }
  };

  const loadMoreRows = () => {
    if (!tableContainer || scanning) {
      return;
    }
    if (visibleCount >= filtered.length) {
      return;
    }
    const now = performance.now();
    if (now - lastLoadMoreAt < 120) {
      return;
    }

    const isContainerScrollable = tableContainer.scrollHeight > tableContainer.clientHeight + 2;
    if (isContainerScrollable) {
      const distanceToBottom = tableContainer.scrollHeight - tableContainer.scrollTop - tableContainer.clientHeight;
      if (distanceToBottom > 80) {
        return;
      }
    } else {
      const tableRect = tableContainer.getBoundingClientRect();
      if (tableRect.bottom > window.innerHeight + 120) {
        return;
      }
    }

    visibleCount = Math.min(filtered.length, visibleCount + PAGE_SIZE);
    lastLoadMoreAt = now;
    renderRows(activeRenderRun);
  };

  let pendingScrollFrame = 0;
  const handleScrollForRows = () => {
    if (pendingScrollFrame) {
      return;
    }
    pendingScrollFrame = window.requestAnimationFrame(() => {
      pendingScrollFrame = 0;
      loadMoreRows();
    });
  };

  const showSearchingState = (query: string) => {
    const parsed = parseSearchQuery(query);
    const searchScope = parsed.scope === 'all' ? activeSearchScope : parsed.scope;
    setEmptyState({
      searching: true,
      query,
      results: 0,
      scope: searchScope,
    });
  };

  const resetListScroll = () => {
    if (tableContainer) {
      tableContainer.scrollTop = 0;
    }
    if (statsPage) {
      statsPage.scrollTop = 0;
    }
  };

  const searchEntriesForQuery = (searchScope: SearchScope, filter: string, terms: Array<string>) => {
    const scopeSearchKeys = getSearchKeysForScope(searchScope);
    const queryVariants = buildSearchVariants(filter);
    const searchNeedles = new Set<string>([queryVariants.query]);

    if (queryVariants.noTone) {
      searchNeedles.add(queryVariants.noTone);
    }
    if (queryVariants.noSpace) {
      searchNeedles.add(queryVariants.noSpace);
    }
    if (
      queryVariants.noToneNoSpace
      && queryVariants.noToneNoSpace !== queryVariants.noSpace
      && queryVariants.noToneNoSpace !== queryVariants.query
    ) {
      searchNeedles.add(queryVariants.noToneNoSpace);
    }

    const resultByT = new Map<string, { item: SearchableIndexEntry; score: number }>();
    const directMatchCandidates = getDirectMatchCandidates(searchScope, filter, searchableEntries, terms);
    const directMatchSet = new Set<string>();
    for (const item of directMatchCandidates) {
      directMatchSet.add(item.t);
      const key = item.t;
      const directFuzzyScore = 0.03;
      const existing = resultByT.get(key);
      if (!existing || directFuzzyScore < existing.score) {
        resultByT.set(key, { item, score: directFuzzyScore });
      }
    }

    for (const needle of searchNeedles) {
      const searchOptions = scopeSearchKeys
        ? { limit: SEARCH_RESULT_LIMIT, keys: scopeSearchKeys as unknown as Array<{ name: string; weight: number }> }
        : { limit: SEARCH_RESULT_LIMIT };
      const results = searchIndex.search(needle, searchOptions);
      for (const result of results) {
        const key = result.item.t;
        const score = result.score ?? 1;
        const existing = resultByT.get(key);
        if (!existing || score < existing.score) {
          resultByT.set(key, { item: result.item, score });
        }
      }
    }

    const ranked = Array.from(resultByT.values())
      .map((result) => {
        const item = result.item;
        const termScore = buildSearchTermScore(item, terms, searchScope);
        return {
          entry: item,
          termScore,
          fuzzyScore: result.score ?? 1,
        };
      })
      .filter((result) => matchesSearchTerms(result.entry, terms, searchScope));

    const highConfidenceMatches = ranked.filter((entry) => entry.termScore >= SEARCH_TERM_SCORE_FOR_MATCH);
    const hasDirectMatches = directMatchSet.size > 0
      && queryVariants.query.length >= SEARCH_DIRECT_MATCH_MIN_LENGTH;

    let ordered = hasDirectMatches
      ? ranked.filter((entry) => directMatchSet.has(entry.entry.t))
      : (highConfidenceMatches.length > 0
        ? highConfidenceMatches
        : ranked.filter((entry) => entry.termScore > 0 && entry.fuzzyScore <= SEARCH_FUZZY_LIMIT));

    const isShortQuery = filter.length < SEARCH_DIRECT_MATCH_MIN_LENGTH;
    const shouldFallbackByTerms = ordered.length === 0 && isShortQuery && terms.length <= 2;
    if (shouldFallbackByTerms) {
      for (const item of searchableEntries) {
        if (resultByT.has(item.t) || !matchesSearchTerms(item, terms, searchScope)) {
          continue;
        }
        ordered.push({
          entry: item,
          termScore: buildSearchTermScore(item, terms, searchScope),
          fuzzyScore: 1,
        });
      }
    }

    ordered.sort((a, b) => {
      if (a.termScore !== b.termScore) {
        return b.termScore - a.termScore;
      }
      return a.fuzzyScore - b.fuzzyScore;
    });
    if (ordered.length > SEARCH_RESULT_LIMIT) {
      ordered = ordered.slice(0, SEARCH_RESULT_LIMIT);
    }

    const nextFiltered: SearchablePartitionElement[] = [];
    let nextLearned = 0;
    let nextLearning = 0;

    for (const item of ordered) {
      const entry = item.entry as SearchablePartitionElement;
      if (!isEntryVisibleForActiveStateFilter(entry, true)) {
        continue;
      }
      nextFiltered.push(entry);
      if (entry.correct !== undefined && entry.correct >= 2) {
        nextLearned += 1;
      }
      if (statusFor(entry, queued) === 'learning') {
        nextLearning += 1;
      }
    }

    return {
      nextFiltered,
      nextLearned,
      nextLearning,
    };
  };

  const applyFilter = (query = '') => {
    const parsed = parseSearchQuery(query);
    const scopeFromUi = activeSearchScope;
    const searchScope = parsed.scope === 'all' ? scopeFromUi : parsed.scope;
    activeSearchScope = searchScope;
    updateActiveScopeChip(searchScope);
    updateActiveStateFilterChip(activeStateFilter);
    updateSearchScopePlaceholder(searchScope);
    updateActiveFiltersSummary(query, searchScope, activeStateFilter);
    const filter = normalizeQuery(parsed.query);
    const terms = parseSearchTerms(filter);
    activeSearchQuery = query;
    activeSearchTerms = terms;
    searchRunId += 1;
    const thisRun = searchRunId;

    if (!filter) {
      if (query.trim() && parsed.scope !== 'all' && !filter) {
        filtered = [];
        learnedCount = 0;
        learningCount = 0;
        visibleCount = Math.min(PAGE_SIZE, filtered.length);
        renderedCount = 0;
        renderedEntryKeys.clear();
        resetListScroll();
        activeRenderRun = thisRun;
        scanning = false;
        renderRows(thisRun);
        setEmptyState({ searching: false, query, results: filtered.length, scope: searchScope });
        return;
      }

      filtered = allEntries.filter((entry) => isEntryVisibleForActiveStateFilter(entry));
      const filteredCounts = computeCounts(filtered);
      learnedCount = filteredCounts.learned;
      learningCount = filteredCounts.learning;
      visibleCount = Math.min(PAGE_SIZE, filtered.length);
      renderedCount = 0;
      renderedEntryKeys.clear();
      resetListScroll();
      activeRenderRun = thisRun;
      scanning = false;
      renderRows(thisRun);
      setEmptyState({ searching: false, query, results: filtered.length, scope: searchScope });
      return;
    }

    const { nextFiltered, nextLearned, nextLearning } = searchEntriesForQuery(searchScope, filter, terms);
    filtered = nextFiltered;
    learnedCount = nextLearned;
    learningCount = nextLearning;
    visibleCount = Math.min(PAGE_SIZE, filtered.length);
    renderedCount = 0;
    renderedEntryKeys.clear();
    resetListScroll();
    activeRenderRun = thisRun;
    scanning = false;
    renderRows(thisRun);
    setEmptyState({
      searching: false,
      query,
      results: filtered.length,
      scope: searchScope,
    });
  };

  search?.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    showSearchingState(target.value);
    if (searchTimeout !== null) {
      window.clearTimeout(searchTimeout);
    }
    updateSearchClearVisibility(target.value);
    searchTimeout = window.setTimeout(() => {
      applyFilter(target.value);
      searchTimeout = null;
    }, 120);
  });

  search?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    if (search.value.length === 0) {
      return;
    }
    event.preventDefault();
    search.value = '';
    updateSearchClearVisibility('');
    applyFilter('');
  });

  clearSearch?.addEventListener('click', () => {
    search.value = '';
    updateSearchClearVisibility('');
    applyFilter('');
    search.focus();
  });

  activeResetButton?.addEventListener('click', () => {
    search.value = '';
    updateSearchClearVisibility('');
    activeStateFilter = 'all';
    updateActiveStateFilterChip(activeStateFilter);
    applySearchScope('all');
  });

  stateFilterChips?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('button[data-state-filter]');
    if (!button) {
      return;
    }
    const filter = button.getAttribute('data-state-filter') as StateFilter | null;
    if (!filter) {
      return;
    }
    activeStateFilter = filter;
    updateActiveStateFilterChip(activeStateFilter);
    applyFilter(search.value);
  });

  scopeChips?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('button[data-scope]');
    if (!button) {
      return;
    }
    const scope = button.getAttribute('data-scope') as SearchScope | null;
    if (!scope) {
      return;
    }
    applySearchScope(scope);
  });

  prefixChips?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('.stats-prefix-chip[data-prefix]');
    const prefix = button?.dataset.prefix;
    if (!prefix) {
      return;
    }
    applySearchPrefix(prefix);
  });

  tableContainer?.addEventListener('scroll', handleScrollForRows, { passive: true });
  statsPage?.addEventListener('scroll', handleScrollForRows, { passive: true });
  window.addEventListener('scroll', handleScrollForRows, { passive: true });
  window.addEventListener('resize', () => {
    handleScrollForRows();
  }, { passive: true });

  updateSearchScopePlaceholder(activeSearchScope);
  updateActiveScopeChip(activeSearchScope);
  updateActiveStateFilterChip(activeStateFilter);
  updateActiveFiltersSummary('', activeSearchScope, activeStateFilter);

  activeRenderRun = ++searchRunId;
  renderRows(activeRenderRun);
}

main().catch(console.error);
