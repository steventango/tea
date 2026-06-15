import {
  collection,
  doc,
  getDocs,
  writeBatch,
  Firestore,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import { firestore, getCurrentUser } from './firebase';
import { PartitionElement } from './database';
import { LearningStats } from './dict';

export interface WordProgress {
  t: string;
  correct: number;
  stats: Required<LearningStats>;
  updatedAt: number;
}

/** Encode a word's traditional character as a safe Firestore document ID */
function encodeWordId(t: string): string {
  return encodeURIComponent(t);
}

function decodeWordId(id: string): string {
  return decodeURIComponent(id);
}

function entryToWordProgress(entry: PartitionElement): WordProgress {
  const now = Date.now();
  return {
    t: entry.t,
    correct: entry.correct ?? 0,
    stats: {
      attempts: entry.stats?.attempts ?? 0,
      successes: entry.stats?.successes ?? 0,
      failures: entry.stats?.failures ?? 0,
      strength: entry.stats?.strength ?? 0,
      lastLearnedAt: entry.stats?.lastLearnedAt ?? 0,
      lastReviewedAt: entry.stats?.lastReviewedAt ?? 0,
      updatedAt: entry.stats?.updatedAt ?? now,
    },
    updatedAt: entry.stats?.updatedAt ?? now,
  };
}

function hasProgress(entry: PartitionElement): boolean {
  if (entry.correct && entry.correct > 0) return true;
  if (!entry.stats) return false;
  return (entry.stats.attempts ?? 0) > 0
    || (entry.stats.lastLearnedAt ?? 0) > 0
    || (entry.stats.lastReviewedAt ?? 0) > 0;
}

/**
 * Merge a cloud WordProgress into a local PartitionElement.
 * Returns true if the local entry was modified.
 */
function mergeCloudIntoLocal(local: PartitionElement, cloud: WordProgress): boolean {
  const localUpdatedAt = local.stats?.updatedAt ?? 0;
  const cloudUpdatedAt = cloud.updatedAt ?? 0;

  if (cloudUpdatedAt <= localUpdatedAt && hasProgress(local)) {
    // Local is newer or same age and has data — keep local
    return false;
  }

  if (!hasProgress(local)) {
    // Local has no progress — take cloud wholesale
    local.correct = cloud.correct;
    local.stats = { ...cloud.stats };
    return true;
  }

  // Both have progress — merge by taking the better values
  if (!local.stats) {
    local.stats = {
      attempts: 0,
      successes: 0,
      failures: 0,
      strength: 0,
      lastLearnedAt: 0,
      lastReviewedAt: 0,
      updatedAt: 0,
    };
  }

  let changed = false;

  // Take the higher correct count
  const bestCorrect = Math.max(local.correct ?? 0, cloud.correct ?? 0);
  if (bestCorrect !== (local.correct ?? 0)) {
    local.correct = bestCorrect;
    changed = true;
  }

  // Merge stats: take max of cumulative values
  const mergedAttempts = Math.max(local.stats.attempts ?? 0, cloud.stats.attempts ?? 0);
  const mergedSuccesses = Math.max(local.stats.successes ?? 0, cloud.stats.successes ?? 0);
  const mergedFailures = Math.max(local.stats.failures ?? 0, cloud.stats.failures ?? 0);
  const mergedStrength = Math.max(local.stats.strength ?? 0, cloud.stats.strength ?? 0);
  const mergedLastLearnedAt = Math.max(local.stats.lastLearnedAt ?? 0, cloud.stats.lastLearnedAt ?? 0);
  const mergedLastReviewedAt = Math.max(local.stats.lastReviewedAt ?? 0, cloud.stats.lastReviewedAt ?? 0);
  const mergedUpdatedAt = Math.max(localUpdatedAt, cloudUpdatedAt);

  if (mergedAttempts !== (local.stats.attempts ?? 0)) { local.stats.attempts = mergedAttempts; changed = true; }
  if (mergedSuccesses !== (local.stats.successes ?? 0)) { local.stats.successes = mergedSuccesses; changed = true; }
  if (mergedFailures !== (local.stats.failures ?? 0)) { local.stats.failures = mergedFailures; changed = true; }
  if (mergedStrength !== (local.stats.strength ?? 0)) { local.stats.strength = mergedStrength; changed = true; }
  if (mergedLastLearnedAt !== (local.stats.lastLearnedAt ?? 0)) { local.stats.lastLearnedAt = mergedLastLearnedAt; changed = true; }
  if (mergedLastReviewedAt !== (local.stats.lastReviewedAt ?? 0)) { local.stats.lastReviewedAt = mergedLastReviewedAt; changed = true; }
  if (mergedUpdatedAt !== localUpdatedAt) { local.stats.updatedAt = mergedUpdatedAt; changed = true; }

  return changed;
}

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error';
type SyncStatusListener = (status: SyncStatus) => void;

export class SyncEngine {
  private uploadQueue: Map<string, WordProgress> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushIntervalMs = 5000;
  private status: SyncStatus = 'idle';
  private statusListeners: Set<SyncStatusListener> = new Set();

  constructor() {
    // Flush on page unload
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.flushSync();
      });
      // Also use visibilitychange for mobile
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.flushSync();
        }
      });
    }
  }

  onStatusChange(listener: SyncStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: SyncStatus) {
    this.status = status;
    for (const listener of this.statusListeners) {
      try { listener(status); } catch (e) { console.error(e); }
    }
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Queue a changed entry for upload. Will be flushed after the debounce interval.
   */
  queueUpload(entry: PartitionElement): void {
    const user = getCurrentUser();
    if (!user) return;

    const progress = entryToWordProgress(entry);
    this.uploadQueue.set(entry.t, progress);

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushAsync();
    }, this.flushIntervalMs);
  }

  private async flushAsync(): Promise<void> {
    const user = getCurrentUser();
    if (!user || this.uploadQueue.size === 0) return;

    this.setStatus('syncing');
    try {
      await this.batchUpload(user, Array.from(this.uploadQueue.values()));
      this.uploadQueue.clear();
      this.setStatus('synced');
    } catch (error) {
      console.error('Sync upload failed:', error);
      this.setStatus('error');
    }
  }

  /** Synchronous-safe flush for beforeunload — uses navigator.sendBeacon fallback isn't practical with Firestore, so we just do our best */
  private flushSync(): void {
    // Can't do async in beforeunload reliably, but attempt it
    this.flushAsync().catch(console.error);
  }

  /**
   * Upload a batch of word progress to Firestore.
   * Firestore batch writes are limited to 500 operations.
   */
  private async batchUpload(user: User, entries: WordProgress[]): Promise<void> {
    const BATCH_SIZE = 500;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const chunk = entries.slice(i, i + BATCH_SIZE);
      const batch = writeBatch(firestore);

      for (const entry of chunk) {
        const docRef = doc(firestore, 'users', user.uid, 'progress', encodeWordId(entry.t));
        batch.set(docRef, {
          t: entry.t,
          correct: entry.correct,
          stats: entry.stats,
          updatedAt: entry.updatedAt,
        });
      }

      await batch.commit();
    }
  }

  /**
   * Download all progress from Firestore for the current user.
   */
  async downloadProgress(user: User): Promise<Map<string, WordProgress>> {
    const progressCol = collection(firestore, 'users', user.uid, 'progress');
    const snapshot = await getDocs(progressCol);

    const result = new Map<string, WordProgress>();
    for (const docSnap of snapshot.docs) {
      const data = docSnap.data() as WordProgress;
      if (data.t) {
        result.set(data.t, data);
      }
    }
    return result;
  }

  /**
   * Perform a full bidirectional sync.
   * Returns the set of partition keys that were modified locally.
   */
  async fullSync(
    partitions: Array<Array<PartitionElement>>,
    getPartitionKey: (index: number) => string,
  ): Promise<Set<string>> {
    const user = getCurrentUser();
    if (!user) return new Set();

    this.setStatus('syncing');
    try {
      // 1. Download cloud progress
      const cloudProgress = await this.downloadProgress(user);

      // 2. Build a lookup from traditional character to [partitionIndex, entryIndex]
      const localIndex = new Map<string, { pi: number; ei: number }>();
      for (let pi = 0; pi < partitions.length; pi++) {
        const partition = partitions[pi];
        for (let ei = 0; ei < partition.length; ei++) {
          localIndex.set(partition[ei].t, { pi, ei });
        }
      }

      const modifiedPartitions = new Set<string>();
      const toUpload: WordProgress[] = [];

      // 3. For each cloud entry, merge into local
      for (const [t, cloudEntry] of cloudProgress) {
        const localRef = localIndex.get(t);
        if (localRef) {
          const localEntry = partitions[localRef.pi][localRef.ei];
          const wasModified = mergeCloudIntoLocal(localEntry, cloudEntry);
          if (wasModified) {
            modifiedPartitions.add(getPartitionKey(localRef.pi));
          }
          // If local is newer, queue for upload
          const localUpdatedAt = localEntry.stats?.updatedAt ?? 0;
          if (localUpdatedAt > (cloudEntry.updatedAt ?? 0)) {
            toUpload.push(entryToWordProgress(localEntry));
          }
        }
        // Words in cloud but not in local partitions are ignored
        // (they may be from a different version of partitions.json)
      }

      // 4. For each local entry with progress that's not in cloud, upload it
      for (let pi = 0; pi < partitions.length; pi++) {
        for (const entry of partitions[pi]) {
          if (hasProgress(entry) && !cloudProgress.has(entry.t)) {
            toUpload.push(entryToWordProgress(entry));
          }
        }
      }

      // 5. Upload local-only entries
      if (toUpload.length > 0) {
        await this.batchUpload(user, toUpload);
      }

      // 6. Clear the upload queue (full sync supersedes pending changes)
      this.uploadQueue.clear();
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }

      this.setStatus('synced');
      return modifiedPartitions;
    } catch (error) {
      console.error('Full sync failed:', error);
      this.setStatus('error');
      return new Set();
    }
  }
}
