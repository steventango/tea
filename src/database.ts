import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { CharacterJson } from 'hanzi-writer';
import { DICT_entry } from './dict';

export interface PartionElement extends DICT_entry {
  correct?: number;
}

interface Partitions {
  [id: string]: Array<PartionElement>
}

interface HanziWriterData {
  [id: string]: CharacterJson
}

export interface DB extends DBSchema {
  config: {
    value: any;
    key: string;
  },
  partitions: {
    value: Array<PartionElement>;
    key: string;
  },
  'partition-lengths': {
    value: number;
    key: string;
  },
  'hanzi-writer-data': {
    value: CharacterJson
    key: string;
  }
}

export default class Database {
  db: IDBPDatabase<DB> | null;

  constructor() {
    this.db = null;
  }

  static async build() {
    const db = new Database()
    db.db = await openDB<DB>('tea', 1, {
      async upgrade(db, oldVersion, newVersion, transaction) {
        if (oldVersion === 0) {
          db.createObjectStore('config');
          db.createObjectStore('partitions');
          db.createObjectStore('partition-lengths');
          db.createObjectStore('hanzi-writer-data');
        } else {
          console.log('upgrade', oldVersion, newVersion);
        }
      },
      blocked() {
        // …
      },
      blocking() {
        // …
      },
      terminated() {
        // …
      },
    });
    const p0 = performance.now();
    await Promise.all([
      db.setup_config(),
      db.setup_partitions(),
      db.setup_hanzi_writer_data()
    ]);
    // currently blocks until database is written, how to bypass, and use async?
    const pf = performance.now();
    console.log('Loaded data: ' + Math.round((pf - p0)) + 'ms');
    return db;
  }

  async setup_config() {
    if (await this.db!.count('config') < 1) {
      const tx = this.db!.transaction('config', 'readwrite');
      const promises = []
      promises.push(tx.store.add('#b2d1c9', 'color'));
      promises.push(tx.store.add([0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125], 'probabilities'));
      promises.push(tx.store.add(100, 'buffer_size'));
      promises.push(tx.store.add('traditional', 'type'));
      promises.push(tx.done);
      await Promise.all(promises);
    }
  }

  async setup_partitions() {
    if (await this.db!.count('partitions') < 1) {
      let response = await fetch('https://cdn.jsdelivr.net/gh/steventango/tea-data/partitions.json');
      let data = await response.json() as Partitions;

      const tx = this.db!.transaction(['partitions', 'partition-lengths'], 'readwrite');
      const promises = []
      for (const [p, value] of Object.entries(data)) {
        promises.push(
          tx.objectStore('partitions').add(value, p)
          );
        promises.push(
          tx.objectStore('partition-lengths').add(value.length, p)
        );
      }
      promises.push(tx.objectStore('partitions').add([], 'learned'));
      promises.push(tx.objectStore('partition-lengths').add(0, 'learned'));
      promises.push(tx.objectStore('partitions').add([], 'buffer'));
      promises.push(tx.objectStore('partition-lengths').add(0, 'buffer'));
      promises.push(tx.done);
      await Promise.all(promises);
    }
  }

  async setup_hanzi_writer_data() {
    if (await this.db!.count('hanzi-writer-data') < 1) {
      const response = await fetch('https://raw.githubusercontent.com/chanind/hanzi-writer-data/v2.0.1/data/all.json');
      const data = await response.json() as HanziWriterData;

      const tx = this.db!.transaction('hanzi-writer-data', 'readwrite');
      const promises = []
      for (const [char, value] of Object.entries(data)) {
        promises.push(
          tx.store.add(value, char)
        );
      }
      promises.push(tx.done);
      await Promise.all(promises);
    }
  }
}
