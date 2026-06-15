import HanziWriter, { CharDataLoaderFn } from 'hanzi-writer';
import Color from 'color';
import { MDCLinearProgress } from '@material/linear-progress';
import Database, { DB, PartitionElement } from './database';
import { LearningStats } from './dict';
import { IDBPDatabase } from 'idb';
import { weightedRandom, sample } from './util';
import {MDCDialog} from '@material/dialog';
import {MDCCheckbox} from '@material/checkbox';
import { MDCTextField } from '@material/textfield';
import Panel from './panel';
import { signInWithGoogle, signOut, onAuthChanged, getCurrentUser } from './firebase';
import { SyncEngine, SyncStatus } from './sync';

const linearProgress = new MDCLinearProgress(document.querySelector('.mdc-linear-progress')!);
const probabilityFields = ['dictionary', 'hsk-1', 'hsk-2', 'hsk-3', 'hsk-4', 'hsk-5', 'hsk-6', 'hsk-7', 'learned'] as const;
const defaultProbabilities = probabilityFields.map(() => 1 / probabilityFields.length);

function parseProbabilityInputs() {
  const probabilities: Array<number> = [];
  for (const name of probabilityFields) {
    const input = document.getElementById(`probability-${name}`)! as HTMLInputElement;
    probabilities.push(input.checked ? 1 : 0);
  }
  return probabilities;
}

function initializeProbabilityCheckboxes() {
  for (const name of probabilityFields) {
    const input = document.getElementById(`probability-${name}`)! as HTMLInputElement;
    new MDCCheckbox(input.closest('.mdc-checkbox')!);
  }
}


class App {
  char_queue: Array<string>;
  color: string;
  entry: PartitionElement|null;
  enable_outline: boolean;
  writer: HanziWriter;
  db: IDBPDatabase<DB>;
  charDataLoader: CharDataLoaderFn;
  defaultCharDataLoader: CharDataLoaderFn;
  panel: Panel;
  partitions: Array<Array<PartitionElement>>;
  partition_lengths: Array<number>;
  probabilities: Array<number>;
  type: 't'|'s';
  buffer_size: number;
  totalMistakes: number;
  currentCharacter: string | null;
  fallbackChar: string | null;
  syncEngine: SyncEngine;

  constructor(db: IDBPDatabase<DB>) {
    this.enable_outline = false;
    this.syncEngine = new SyncEngine();
    const target = document.getElementById('target')!;
    const size = Math.min(target.clientWidth, target.clientHeight);
    this.db = db;
    this.currentCharacter = null;
    this.fallbackChar = null;
    this.charDataLoader = (char, onLoad, onError) => {
      const p0 = performance.now()
      if (this.db.version > 0) {
        this.db.get('hanzi-writer-data', char)
          .then((data) => {
            if (data) {
              onLoad(data);
              const p1 = performance.now()
              console.debug(`Load ${char} from db: ${p1 - p0} ms`);
            } else {
              onError(new Error(`Couldn't find the requested char ${char} in hanzi-writer-data.`))
            }
          })
          .catch((error) => {
            onError(error);
          });
      } else {
        this.defaultCharDataLoader(char, onLoad, onError);
      }
    }
    this.char_queue = [];
    this.partitions = [];
    this.partition_lengths = [];
    this.probabilities = [];
    this.buffer_size = 0;
    this.type = 't';
    this.color = '';
    this.panel = new Panel();
    this.entry = null;
    this.totalMistakes = 0;
    this.writer = HanziWriter.create(target.id, '一', {
      width: size,
      height: size,
      showCharacter: false,
      showOutline: false,
      showHintAfterMisses: 1,
      leniency: 1.5,
      highlightOnComplete: true,
      renderer: 'svg',
      onLoadCharDataError: (error) => {
        console.warn(error);
        const char = this.currentCharacter || this.writer._char || '一';
        this.showFallbackInput(char);
      }
    });
    this.defaultCharDataLoader = this.writer._options.charDataLoader!;
    this.writer._options.charDataLoader = this.charDataLoader;

    const fallbackInput = document.getElementById('fallback-input') as HTMLInputElement;
    if (fallbackInput) {
      const handleFallbackSubmit = () => {
        const val = fallbackInput.value.trim();
        if (val && val === this.fallbackChar) {
          fallbackInput.classList.add('success');
          this.panel.phrase += this.fallbackChar;
          setTimeout(() => {
            fallbackInput.classList.remove('success');
            fallbackInput.value = '';
            this.hideFallbackInput();
            this.update_writer().catch(console.error);
          }, 500);
        }
      };

      fallbackInput.addEventListener('input', handleFallbackSubmit);
      fallbackInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          handleFallbackSubmit();
        }
      });
    }

    const skipBtn = document.getElementById('fallback-skip-btn');
    if (skipBtn) {
      skipBtn.addEventListener('click', () => {
        if (this.fallbackChar) {
          this.panel.phrase += this.fallbackChar;
          this.hideFallbackInput();
          this.update_writer().catch(console.error);
        }
      });
    }

    window.addEventListener('resize', () => {
      this.resize();
    });
    console.log(this);
  }

  private getLearningStats(entry: PartitionElement): Required<LearningStats> {
    const base: Required<LearningStats> = {
      attempts: 0,
      successes: 0,
      failures: 0,
      strength: 0,
      lastLearnedAt: 0,
      lastReviewedAt: 0,
      updatedAt: 0,
    };
    if (!entry.stats) {
      entry.stats = base;
      return base;
    }
    return {
      attempts: Number.isFinite(entry.stats.attempts) ? Math.max(0, Math.floor(entry.stats.attempts)) : 0,
      successes: Number.isFinite(entry.stats.successes) ? Math.max(0, Math.floor(entry.stats.successes)) : 0,
      failures: Number.isFinite(entry.stats.failures) ? Math.max(0, Math.floor(entry.stats.failures)) : 0,
      strength: Number.isFinite(entry.stats.strength) ? Math.max(0, Math.min(1, entry.stats.strength)) : 0,
      lastLearnedAt: Number.isFinite(entry.stats.lastLearnedAt) ? Math.max(0, Math.floor(entry.stats.lastLearnedAt)) : 0,
      lastReviewedAt: Number.isFinite(entry.stats.lastReviewedAt) ? Math.max(0, Math.floor(entry.stats.lastReviewedAt)) : 0,
      updatedAt: Number.isFinite(entry.stats.updatedAt) ? Math.max(0, Math.floor(entry.stats.updatedAt as number)) : 0,
    };
  }

  private recordEntryAttempt(entry: PartitionElement, success: boolean) {
    const stats = this.getLearningStats(entry);
    const now = Date.now();
    stats.attempts += 1;
    if (success) {
      stats.successes += 1;
    } else {
      stats.failures += 1;
    }
    stats.lastReviewedAt = now;
    stats.updatedAt = now;
    const accuracy = stats.attempts > 0 ? stats.successes / stats.attempts : 0;
    const volumeFactor = Math.min(1, stats.successes / 5);
    stats.strength = accuracy * volumeFactor;
    entry.stats = stats;
    // Queue for cloud sync
    this.syncEngine.queueUpload(entry);
  }

  updateEntry() {
    this.panel.phrase = '\xa0';
    this.char_queue.push(...this.entry![this.type].split('').reverse());
    this.panel.pinyin = this.entry!.p.join(', ');
    this.panel.jyutping = this.entry!.j.join(', ') || '\xa0';

    const definitions = Array.isArray(this.entry!.d)
      ? this.entry!.d
      : [this.entry!.d];

    const normalizedDefinitions = [] as Array<string>;
    for (const definition of definitions) {
      normalizedDefinitions.push(definition
        .replaceAll(new RegExp(`[${this.entry!.t}]`, 'g'), '')
        .replaceAll(new RegExp(`[${this.entry!.s}]`, 'g'), '')
      );
    }
    if (this.entry!.h) {
      normalizedDefinitions.push('HSK ' + this.entry!.h);
    }

    this.panel.definitions = normalizedDefinitions;
  }

  getPartitionKey(index: number): string {
    if (index === 8) {
      return 'learned';
    }
    if (index === 9) {
      return 'buffer';
    }
    return index.toString();
  }

  async nextEntry() {
    if (this.entry) {
      const now = Date.now();
      const success = this.totalMistakes <= 1;
      this.recordEntryAttempt(this.entry, success);

      if (this.totalMistakes <= 1) {
        const tx = this.db.transaction('partitions', 'readwrite');
        const promises = [];
        if (!this.entry.correct) {
          this.entry.correct = 1;
        } else {
          this.entry.correct++;
        }
        if (this.entry.correct >= 2) {
          if (!this.entry.stats?.lastLearnedAt) {
            this.entry.stats!.lastLearnedAt = now;
          }
          this.partitions[8].push(this.entry);
          promises.push(tx.store.put(this.partitions[8], 'learned'));
        } else if (this.entry.correct >= 1) {
          const index = 0;
          this.partitions[9].splice(index, 0, this.entry);
        } else {
          const index = Math.floor(this.partitions[9].length * 0.8);
          this.partitions[9].splice(index, 0, this.entry);
        }
        promises.push(tx.store.put(this.partitions[9], 'buffer'));
        promises.push(tx.done);
        await Promise.all(promises);
      } else {
        this.entry.correct = 0;
        const index = Math.floor(this.partitions[9].length * 0.8);
        this.partitions[9].splice(index, 0, this.entry);
        await this.db.put('partitions', this.partitions[9], 'buffer');
      }
    }

    if (!this.partitions[9] || this.partitions[9].length === 0) {
      this.entry = null;
      this.totalMistakes = 0;
      return;
    }

    let probabilities = [];
    let remainder = 1;
    for (let i = 0; i < this.partitions[9].length; i++) {
      probabilities.push(remainder / 2);
      remainder /= 2;
    }
    probabilities = probabilities.reverse();
    const r = weightedRandom(this.getNormalizedProbabilities(probabilities));
    const entry = this.partitions[9].splice(r, 1)[0] || null;
    this.entry = entry;
    this.totalMistakes = 0;
  }

  updateProgress() {
    const total = this.partition_lengths
      .filter((v, i) => this.probabilities[i] > 0 ? v : 0)
      .reduce((a, b) => a + b, 0);
    const notDone = this.partitions
      .map((partition) => partition.length)
      .filter((v, i) => this.probabilities[i] > 0 ? v : 0)
      .reduce((a, b) => a + b, 0) +
    this.partitions[9]
      .filter((v) => v.h ? (this.probabilities[v.h] > 0 ? 1 : 0) : (this.probabilities[0] > 0 ? 1 : 0))
      .length;
      console.log(notDone, total);
    linearProgress.progress = 1 - notDone / total;
  }

  async load() {
    const tx = this.db.transaction(['partitions', 'partition-lengths'], 'readwrite');
    
    // Backwards compatibility: load and merge legacy key '8' if it exists in partitions or partition-lengths
    const legacyPartitionsPromise = tx.objectStore('partitions').get('8') as Promise<PartitionElement[] | undefined>;
    const legacyLengthsPromise = tx.objectStore('partition-lengths').get('8') as Promise<number | undefined>;
    const learnedPartitionsPromise = tx.objectStore('partitions').get('learned') as Promise<PartitionElement[] | undefined>;
    
    const [legacyPart, legacyLen, learnedPart] = await Promise.all([
      legacyPartitionsPromise,
      legacyLengthsPromise,
      learnedPartitionsPromise,
    ]);

    let mergedLearned = learnedPart || [];
    if (legacyPart && legacyPart.length > 0) {
      const existing = new Set(mergedLearned.map(e => e.t));
      for (const entry of legacyPart) {
        if (!existing.has(entry.t)) {
          mergedLearned.push(entry);
        }
      }
      await tx.objectStore('partitions').put(mergedLearned, 'learned');
      await tx.objectStore('partition-lengths').put(mergedLearned.length, 'learned');
      await tx.objectStore('partitions').delete('8');
      await tx.objectStore('partition-lengths').delete('8');
    }

    const promises: [Promise<PartitionElement[]>, Promise<number>][] = [];
    for (let i = 0; i <= 7; i++) {
      promises.push([
        tx.objectStore('partitions').get(i.toString()) as Promise<PartitionElement[]>,
        tx.objectStore('partition-lengths').get(i.toString()) as Promise<number>,
      ]);
    }
    promises.push([
      Promise.resolve(mergedLearned),
      Promise.resolve(mergedLearned.length)
    ]);
    promises.push([
      tx.objectStore('partitions').get('buffer') as Promise<PartitionElement[]>,
      tx.objectStore('partition-lengths').get('buffer') as Promise<number>
    ]);
    
    const partitions = await Promise.all(promises.map(async (p) => await Promise.all(p)));
    this.partitions = partitions.map(([partition, ]) => partition || []);
    this.partition_lengths = partitions.map(([, length]) => length || 0);
    this.buffer_size = (await this.db.get('config', 'buffer_size')) || 100;
    
    await tx.done;

    await Promise.all([
      this.updateProbability(),
      this.updateType(),
      this.updateTheme()
    ]);
  }

  async updateProbability() {
    const probabilities = await this.db.get('config', 'probabilities');
    if (!probabilities || probabilities.length !== probabilityFields.length) {
      this.probabilities = defaultProbabilities;
      return;
    }
    const parsedProbabilities = probabilities.map((value: any) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, value);
      }
      return 0;
    });
    const hasProbabilities = parsedProbabilities.some((probability: number) => probability > 0);
    this.probabilities = hasProbabilities ? parsedProbabilities : defaultProbabilities;
  }

  async updateType() {
    switch (await this.db.get('config', 'type')) {
      case 'simplified':
        this.type = 's';
        break;
      case 'traditional':
      default:
        this.type = 't';
        break;
    }
  }

  async updateTheme() {
    this.color = await this.db.get('config', 'color');
    const color = Color(this.color).hsv();
    const colors = {
      stroke: color.lightness(40).hex(),
      background: color.lightness(95).hex(),
      outline: color.lightness(80).hex(),
      highlight: color.lightness(90).hex(),
      primary: color.lightness(20).hex()
    }

    document.documentElement.style.setProperty('--mdc-theme-primary', colors.primary);
    document.documentElement.style.setProperty('--mdc-theme-secondary', colors.stroke);
    document.documentElement.style.setProperty('--mdc-theme-background', colors.background);
    document.documentElement.style.setProperty('--mdc-theme-surface', colors.outline);

    if (this.writer && (this.writer as any)._character) {
      try {
        this.writer.updateColor('strokeColor', colors.stroke);
        this.writer.updateColor('highlightColor', colors.highlight);
        this.writer.updateColor('highlightCompleteColor', this.color);
        this.writer.updateColor('outlineColor', colors.outline);
        this.writer.updateColor('drawingColor', colors.primary);
      } catch (error) {
        console.warn('Skipping HanziWriter color updates until character data is loaded:', error);
      }
    } else if (this.writer) {
      const opts = (this.writer as any)._options;
      if (opts) {
        opts.strokeColor = colors.stroke;
        opts.highlightColor = colors.highlight;
        opts.highlightCompleteColor = this.color;
        opts.outlineColor = colors.outline;
        opts.drawingColor = colors.primary;
      }
    }
  }

  async updateBuffer() {
    if (this.partitions[9].length < this.buffer_size) {
      const changed = new Set<number>();
      while (this.partitions[9].length < this.buffer_size) {
        const partitioni = weightedRandom(this.getNormalizedProbabilities());
        const partition = this.partitions[partitioni];
        const word = sample(partition);
        if (word) {
          word.correct = 0; // Reset consecutive correct attempts upon entering the queue
          this.partitions[9].push(word);
          changed.add(partitioni);
        }
      }

      const tx = this.db!.transaction('partitions', 'readwrite');
      const promises = []
      for (const c of changed) {
        promises.push(tx.store.put(this.partitions[c], this.getPartitionKey(c)));
      }
      promises.push(tx.store.put(this.partitions[9], 'buffer'));
      promises.push(tx.done);
      await Promise.all(promises);
    }
  }

  private getNormalizedProbabilities(probabilities: Array<number> = this.probabilities) {
    const sanitized = probabilities.map((probability) => {
      if (Number.isFinite(probability) && probability >= 0) {
        return probability;
      }
      return 0;
    });
    const sum = sanitized.reduce((total, probability) => total + probability, 0);
    if (sanitized.length === 0 || sum <= 0) {
      return defaultProbabilities;
    }
    return sanitized.map((probability) => probability / sum);
  }

  async flushBuffer() {
    const changed = new Set<number>();
    while (this.partitions[9].length > 0) {
      const item = this.partitions[9].pop()!;
      let partition = -1;
      const isLearned = (item.correct !== undefined && item.correct >= 2) || (item.stats?.lastLearnedAt || 0) > 0;
      if (isLearned) {
        this.partitions[8].push(item);
        partition = 8;
      } else {
        const pIndex = item.h || 0;
        this.partitions[pIndex].push(item);
        partition = pIndex;
      }
      changed.add(partition);
    }

    const tx = this.db!.transaction('partitions', 'readwrite');
    const promises = []
    for (const c of changed) {
      if (c >= 0) {
        promises.push(tx.store.put(this.partitions[c], this.getPartitionKey(c)));
      }
    }
    promises.push(tx.store.put(this.partitions[9], 'buffer'));
    promises.push(tx.done);
    await Promise.all(promises);
  }

  async render() {
    this.resize();
    await this.updateBuffer();
    await this.nextEntry();
    this.updateEntry();
    linearProgress.determinate = true;
    this.updateProgress();
    this.update_writer();


    this.writer.quiz({
      onComplete: async (summaryData) => {
        this.panel.phrase += summaryData.character;
        this.totalMistakes += summaryData.totalMistakes;
        setTimeout(() => {
          this.update_writer();
        }, 1000);
      }
    });
  }

  async update_writer() {
    while (true) {
      if (this.char_queue.length === 0) {
        await this.nextEntry();
        await this.updateBuffer();
        if (!this.entry) {
          await this.nextEntry();
        }
        if (!this.entry) {
          return;
        }
        this.updateEntry();
        this.updateProgress();
      }
      try {
        const char = this.char_queue.pop()!;
        this.currentCharacter = char;
        this.hideFallbackInput();
        this.writer.setCharacter(char);
        if (this.entry?.correct && this.entry?.correct > 0) {
          this.writer.hideOutline();
        } else {
          this.writer.showOutline();
        }
        break;
      } catch (error) {
        console.error(error);
      }
    }
    this.writer.quiz();
  }

  showFallbackInput(char: string) {
    const container = document.getElementById('fallback-container')!;
    const input = document.getElementById('fallback-input')! as HTMLInputElement;

    const svg = document.querySelector('#target svg') as HTMLElement;
    if (svg) {
      svg.style.display = 'none';
    }

    input.value = '';
    input.placeholder = char;
    container.style.display = 'flex';
    this.fallbackChar = char;

    setTimeout(() => {
      input.focus();
    }, 50);
  }

  hideFallbackInput() {
    const container = document.getElementById('fallback-container')!;
    const input = document.getElementById('fallback-input')! as HTMLInputElement;

    container.style.display = 'none';
    input.value = '';
    this.fallbackChar = null;

    const svg = document.querySelector('#target svg') as HTMLElement;
    if (svg) {
      svg.style.display = '';
    }
  }

  resize() {
    const target = document.getElementById('target')!;
    const size = Math.min(target.clientWidth, target.clientHeight);
    this.writer.updateDimensions({
      width: size,
      height: size
    });
  }
}

function updateAuthUI(user: import('firebase/auth').User | null, status: SyncStatus) {
  const authBtn = document.getElementById('auth-button');
  const authAvatar = document.getElementById('auth-avatar') as HTMLImageElement | null;
  const syncDot = document.getElementById('sync-status-dot');

  if (syncDot) {
    syncDot.className = 'sync-status-dot';
    switch (status) {
      case 'syncing': syncDot.classList.add('sync-status--syncing'); syncDot.title = 'Syncing…'; break;
      case 'synced': syncDot.classList.add('sync-status--synced'); syncDot.title = 'Synced'; break;
      case 'error': syncDot.classList.add('sync-status--error'); syncDot.title = 'Sync error'; break;
      default: syncDot.classList.add('sync-status--idle'); syncDot.title = 'Not synced'; break;
    }
  }

  if (user) {
    if (authBtn) authBtn.style.display = 'none';
    if (authAvatar) {
      authAvatar.src = user.photoURL || '';
      authAvatar.alt = user.displayName || 'User';
      authAvatar.style.display = '';
    }
  } else {
    if (authBtn) authBtn.style.display = '';
    if (authAvatar) authAvatar.style.display = 'none';
  }
}

async function main() {
  linearProgress.determinate = false;
  const dialog = new MDCDialog(document.querySelector('.mdc-dialog')!);
  const button = document.getElementById('button')!;

  const db = (await Database.build()).db!;
  const app = new App(db);
  (window as any).app = app;
  await app.load();
  initializeProbabilityCheckboxes();
  app.render();

  // --- Auth UI wiring ---
  let currentSyncStatus: SyncStatus = 'idle';

  app.syncEngine.onStatusChange((status) => {
    currentSyncStatus = status;
    updateAuthUI(getCurrentUser(), status);
  });

  const authBtn = document.getElementById('auth-button');
  const authAvatar = document.getElementById('auth-avatar');

  if (authBtn) {
    authBtn.addEventListener('click', async () => {
      await signInWithGoogle();
    });
  }

  if (authAvatar) {
    authAvatar.addEventListener('click', async () => {
      if (confirm('Sign out?')) {
        await signOut();
      }
    });
  }

  onAuthChanged(async (user) => {
    updateAuthUI(user, currentSyncStatus);
    if (user) {
      // Full sync on sign-in
      const modifiedKeys = await app.syncEngine.fullSync(app.partitions, (i) => app.getPartitionKey(i));
      if (modifiedKeys.size > 0) {
        const tx = db.transaction('partitions', 'readwrite');
        for (const key of modifiedKeys) {
          const pi = key === 'learned' ? 8 : key === 'buffer' ? 9 : parseInt(key, 10);
          if (pi >= 0 && pi < app.partitions.length) {
            await tx.store.put(app.partitions[pi], key);
          }
        }
        await tx.done;
      }
    }
  });

  // Initialize auth UI state
  updateAuthUI(getCurrentUser(), currentSyncStatus);

  const sourceInputs = probabilityFields.map((name) =>
    document.getElementById(`probability-${name}`)! as HTMLInputElement
  );
  const sourceControls = sourceInputs.map((input) => input.closest('.probability-control')!);

  const setSourceSelectionError = (hasError: boolean) => {
    for (const control of sourceControls) {
      control.classList.toggle('mdc-text-field--invalid', hasError);
    }
  };

  const hasSelectedSource = () => sourceInputs.some((input) => input.checked);

  sourceInputs.forEach((input) => {
    input.addEventListener('change', () => {
      setSourceSelectionError(!hasSelectedSource());
    });
  });

  button.addEventListener('click', () => {
    dialog.open();
    // read config, write config
    const radio_t = document.getElementById('radio-t')! as HTMLInputElement;
    const radio_s = document.getElementById('radio-s')! as HTMLInputElement;
    if (app.type === 't') {
      radio_t.checked = true;
      radio_s.checked = false;
    } else {
      radio_t.checked = false;
      radio_s.checked = true;
    }
    setTimeout(() => {
      setSourceSelectionError(false);
      for (const [index, name] of probabilityFields.entries()) {
        const checkbox = document.getElementById(`probability-${name}`)! as HTMLInputElement;
        const value = app.probabilities[index] ?? defaultProbabilities[index];
        checkbox.checked = value > 0;
      }
      const textfield_tolerance = new MDCTextField(document.getElementById('tolerance-textfield')!);
      const textfield_color = new MDCTextField(document.getElementById('color-textfield')!);
      textfield_color.value = app.color;
    }, 500);
  });

  const applySettings = async () => {
    const radio_t = document.getElementById('radio-t')! as HTMLInputElement;
    const probabilities = parseProbabilityInputs();
    const selectedAnySource = probabilities.some((value) => value > 0);
    if (!selectedAnySource) {
      setSourceSelectionError(true);
      return false;
    }
    setSourceSelectionError(false);

    const tx = db.transaction('config', 'readwrite');
    const hadType = app.type;
    const textfield_color = new MDCTextField(document.getElementById('color-textfield')!);
    const promises = [];
    if (radio_t.checked) {
      if (app.type !== 't') {
        app.type = 't';
        promises.push(tx.store.put('t', 'traditional'));
      }
    } else if (app.type !== 's') {
      app.type = 's';
      promises.push(tx.store.put('t', 'simplified'));
    }

    if (textfield_color.value !== app.color) {
      promises.push(tx.store.put(textfield_color.value, 'color'));
    }

    const hadProbabilityChange = probabilities.some((value, index) => value !== app.probabilities[index]);
    app.probabilities = probabilities;
    promises.push(tx.store.put(probabilities, 'probabilities'));
    if (promises.length > 0) {
      promises.push(tx.done);
      await Promise.all(promises);
      if (app.color !== textfield_color.value || hadType !== app.type) {
        await app.updateTheme();
      }
      if (hadProbabilityChange) {
        await app.flushBuffer();
        app.char_queue = [];
        app.entry = null;
        app.totalMistakes = 0;
        await app.updateBuffer();
        await app.update_writer();
      }
    }

    return true;
  };

  const close_button = dialog.root.querySelector('.mdc-dialog__close')! as HTMLElement;
  close_button.addEventListener('click', () => {
    dialog.close();
  });
  const ok_button = dialog.root.querySelector('.mdc-dialog__button')! as HTMLElement;
  ok_button.addEventListener('click', () => {
    dialog.close();
  });
  dialog.listen('MDCDialog:closing', async (event: Event) => {
    const shouldPersistSettings = await applySettings();
    if (!shouldPersistSettings) {
      event.preventDefault();
    }
  });


  // const learned = await db.get('partitions', 'learned');
  // document.write(JSON.stringify(learned?.map(v=>v.t)));

  if (process.env.NODE_ENV === 'production') {
    if ('serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js')
        console.log('Service worker registration succeeded:', registration);
      } catch (error) {
        console.log('Service worker registration failed:', error);
      }

    } else {
      console.log('Service workers are not supported.');
    }
  }
}


main();
