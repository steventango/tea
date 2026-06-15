export interface DICT_entry {
  t: string;
  s: string;
  p: Array<string>;
  j: Array<string>;
  h?: number;
  d: string | Array<string>;
}

export interface LearningStats {
  attempts: number;
  successes: number;
  failures: number;
  strength: number;
  lastLearnedAt: number;
  lastReviewedAt: number;
  updatedAt?: number;
}
