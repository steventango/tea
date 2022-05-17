import HanziWriter from 'hanzi-writer';
import { CharDataLoaderFn } from 'hanzi-writer';
import Color from 'color';
import { MDCLinearProgress } from '@material/linear-progress';
import Database from './database';
import { DB, PartionElement } from './database';
import { IDBPDatabase } from 'idb';
import { randomp, sample } from './util';
import {MDCDialog} from '@material/dialog';
import {MDCSlider} from '@material/slider';
import { MDCTextField } from '@material/textfield';
import Panel from './panel';


const linearProgress = new MDCLinearProgress(document.querySelector('.mdc-linear-progress')!);


class App {
  char_queue: Array<string>;
  color: string;
  entry: PartionElement|null;
  enable_outline: boolean;
  writer: HanziWriter;
  db: IDBPDatabase<DB>;
  charDataLoader: CharDataLoaderFn;
  defaultCharDataLoader: CharDataLoaderFn;
  panel: Panel;
  partitions: Array<Array<PartionElement>>;
  partition_lengths: Array<number>;
  probabilities: Array<number>;
  type: 't'|'s';
  buffer_size: number;
  totalMistakes: number;

  constructor(db: IDBPDatabase<DB>) {
    this.enable_outline = false;
    const target = document.getElementById('target')!;
    const size = Math.min(target.clientWidth, target.clientHeight);
    this.db = db;
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
              const error = new Error(`Couldn't find the requested char ${char} in hanzi-writer-data.`)
              onError(error);
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
        this.writer._options!.onComplete!({
          character: this.writer._char!,
          totalMistakes: 0
        });
      }
    });
    this.defaultCharDataLoader = this.writer._options!.charDataLoader!;
    this.writer._options.charDataLoader = this.charDataLoader;
    window.addEventListener('resize', () => {
      this.resize();
    });
    console.log(this);
  }

  updateEntry() {
    this.panel.phrase = '\xa0';
    this.char_queue.push(...this.entry![this.type].split('').reverse());
    this.panel.pinyin = this.entry!.p.join(', ');
    this.panel.jyutping = this.entry!.j.join(', ') || '\xa0';

    const definitions = [];
    for (const definition of this.entry!.d) {
      definitions.push(definition
        .replaceAll(new RegExp(`[${this.entry!.t}]`, 'g'), '')
        .replaceAll(new RegExp(`[${this.entry!.s}]`, 'g'), '')
      );
    }
    if (this.entry!.h) {
      definitions.push('HSK ' + this.entry!.h);
    }
    this.panel.definitions = definitions;
  }

  async nextEntry() {
    if (this.entry) {
      if (this.totalMistakes <= 1) {
        const tx = this.db!.transaction('partitions', 'readwrite');
        const promises = [];
        if (!this.entry.correct) {
          this.entry.correct = 1;
        } else {
          this.entry.correct++;
        }
        if (this.entry!.correct >= 2) {
          this.partitions[8].push(this.entry!);
          promises.push(tx.store.put(this.partitions[8], 'learned'));
        } else if (this.entry!.correct >= 1) {
          const index = 0;
          this.partitions[9].splice(index, 0, this.entry!);
        } else {
          const index = Math.floor(this.partitions[9].length * 0.8);
          this.partitions[9].splice(index, 0, this.entry!);
        }
        promises.push(tx.store.put(this.partitions[9], 'buffer'));
        promises.push(tx.done);
      } else {
        this.entry.correct = 0;
        const index = Math.floor(this.partitions[9].length * 0.8);
        this.partitions[9].splice(index, 0, this.entry!);
        this.db.put('partitions', this.partitions[9], 'buffer');
      }
    }

    let probabilities = [];
    let remainder = 1;
    for (let i = 0; i < this.partitions[9].length; i++) {
      probabilities.push(remainder / 2);
      remainder /= 2;
    }
    probabilities = probabilities.reverse();
    const r = randomp(probabilities);
    const entry = this.partitions[9][r];
    this.partitions[9].splice(r);
    this.entry = entry;
    this.totalMistakes = 0;
  }

  updateProgress() {
    const total = this.partition_lengths
      .filter((v, i) => this.probabilities[i] > 0 ? v : 0)
      .reduce((a, b) => a + b, 0);
    const notdone = this.partitions
      .map((partition) => partition.length)
      .filter((v, i) => this.probabilities[i] > 0 ? v : 0)
      .reduce((a, b) => a + b, 0) +
    this.partitions[9]
      .filter((v) => v.h ? (this.probabilities[v.h] > 0 ? 1 : 0) : (this.probabilities[0] > 0 ? 1 : 0))
      .length;
      console.log(notdone, total);
    linearProgress.progress = 1 - notdone / total;
  }

  async load() {
    const tx = this.db.transaction(['partitions', 'partition-lengths'], 'readonly');
    const promises: [Promise<PartionElement[]>, Promise<number>][] = [];
    for (let i = 0; i <= 7; i++) {
      promises.push([
        tx.objectStore('partitions').get(i.toString()) as Promise<PartionElement[]>,
        tx.objectStore('partition-lengths').get(i.toString()) as Promise<number>,
      ]);
    }
    promises.push([
      tx.objectStore('partitions').get('learned') as Promise<PartionElement[]>,
      tx.objectStore('partition-lengths').get('learned') as Promise<number>
    ]);
    promises.push([
      tx.objectStore('partitions').get('buffer') as Promise<PartionElement[]>,
      tx.objectStore('partition-lengths').get('buffer') as Promise<number>
    ]);
    const partitions = await Promise.all(promises.map(async (p) => await Promise.all(p)));
    this.partitions = partitions.map(([p, ]) => p);
    this.partition_lengths = partitions.map(([, l]) => l);
    this.buffer_size = await this.db.get('config', 'buffer_size');
    await Promise.all([
      this.updateProbability(),
      this.updateType(),
      this.updateTheme()
    ]);
  }

  async updateProbability() {
    this.probabilities = await this.db.get('config', 'probabilities');
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

    this.writer.updateColor('strokeColor', colors.stroke);
    this.writer.updateColor('highlightColor', colors.highlight);
    this.writer.updateColor('outlineColor', colors.outline);
    this.writer.updateColor('drawingColor', colors.primary);
  }

  async updateBuffer() {
    if (this.partitions[9].length < this.buffer_size) {
      const changed = new Set<number>();
      while (this.partitions[9].length < this.buffer_size) {
        const partitioni = randomp(this.probabilities);
        const partition = this.partitions[partitioni];
        const word = sample(partition);
        if (word) {
          this.partitions[9].push(word);
          changed.add(partitioni);
        }
      }

      const tx = this.db!.transaction('partitions', 'readwrite');
      const promises = []
      for (const c of changed) {
        promises.push(tx.store.put(this.partitions[c], c.toString()));
      }
      promises.push(tx.store.put(this.partitions[9], 'buffer'));
      promises.push(tx.done);
      Promise.all(promises);
    }
  }

  async flushBuffer() {
    const changed = new Set<number>();
    while (this.partitions[9].length > 0) {
      const item = this.partitions[9].pop()!;
      let partition = -1;
      if (item.h) {
        this.partitions[item.h].push(item);
        partition = item.h;
      } else if (item.correct) {
        if (item.correct > 1) {

        }
      }
      changed.add(partition);
    }

    const tx = this.db!.transaction('partitions', 'readwrite');
    const promises = []
    for (const c of changed) {
      promises.push(tx.store.put(this.partitions[c], c.toString()));
    }
    promises.push(tx.store.put(this.partitions[9], 'buffer'));
    promises.push(tx.done);
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
        this.updateEntry();
        this.updateProgress();
      }
      try {
        this.writer.setCharacter(this.char_queue.pop()!);
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

  resize() {
    const target = document.getElementById('target')!;
    const size = Math.min(target.clientWidth, target.clientHeight);
    this.writer.updateDimensions({
      width: size,
      height: size
    });
  }
}

async function main() {
  linearProgress.determinate = false;
  const dialog = new MDCDialog(document.querySelector('.mdc-dialog')!);
  const button = document.getElementById('button')!;

  const db = (await Database.build()).db!;
  const app = new App(db);
  await app.load();
  app.render();

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
      for (const [index, name] of ['dictionary', 'hsk-1', 'hsk-2', 'hsk-3', 'hsk-4', 'hsk-5', 'hsk-6', 'hsk-7', 'learned'].entries()) {
        const slider = new MDCSlider(document.getElementById(`probability-${name}`)!);
        slider.setValue(app.probabilities[index]);
      }
      const textfield_tolerance = new MDCTextField(document.getElementById('tolerance-textfield')!);
      const textfield_color = new MDCTextField(document.getElementById('color-textfield')!);
      textfield_color.value = app.color;
    }, 500);
  });
  const close_button = dialog.root.querySelector('.mdc-dialog__close')! as HTMLElement;
  close_button.addEventListener('click', () => {
    dialog.close();
  });

  dialog.listen('MDCDialog:closing', async () => {
    const radio_t = document.getElementById('radio-t')! as HTMLInputElement;
    const tx = db.transaction('config', 'readwrite');
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

    const textfield_color = new MDCTextField(document.getElementById('color-textfield')!);
    if (textfield_color.value !== app.color) {
      promises.push(tx.store.put(textfield_color.value, 'color'));
    }
    if (promises.length > 0) {
      promises.push(tx.done);
      await Promise.all(promises);
      // only if color change
      app.updateTheme();
    }
  });
  // on close write settings


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
