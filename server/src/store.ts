import { MongoClient, type Collection, type Db } from 'mongodb';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Run, RunSummary } from '../../shared/types';

/**
 * Two storage backends behind one interface.
 *
 * Atlas is the production target, but the Atlas Data API reached end-of-life in
 * September 2025, so there is no browser path to Mongo - this server is the only
 * way in. The file store exists so the game is fully runnable locally, and on the
 * day, so a database outage degrades the demo instead of ending it.
 */
export interface RunStore {
  readonly kind: 'mongo' | 'file';
  list(trackId: string, limit: number): Promise<RunSummary[]>;
  get(id: string): Promise<Run | null>;
  topWithPaths(trackId: string, limit: number): Promise<Run[]>;
  byIds(ids: string[]): Promise<Run[]>;
  insert(run: Run): Promise<string>;
  matchmake(trackId: string, projectedTime: number, limit: number, excludeName?: string): Promise<Run[]>;
  bestFor(trackId: string, playerName: string): Promise<RunSummary | null>;
  reset(trackId: string, keepSynthetic: boolean): Promise<number>;
  count(trackId: string): Promise<number>;
  close(): Promise<void>;
}

const stripPath = (r: Run): RunSummary => {
  const { path, ...rest } = r;
  return rest as RunSummary;
};

// ---------------------------------------------------------------------------
// MongoDB Atlas
// ---------------------------------------------------------------------------
export class MongoStore implements RunStore {
  readonly kind = 'mongo' as const;
  private client: MongoClient;
  private db: Db;
  private runs: Collection<Run>;

  private constructor(client: MongoClient, dbName: string) {
    this.client = client;
    this.db = client.db(dbName);
    this.runs = this.db.collection<Run>('runs');
  }

  static async connect(uri: string, dbName: string): Promise<MongoStore> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const store = new MongoStore(client, dbName);
    await store.runs.createIndex({ trackId: 1, totalTime: 1 });
    await store.runs.createIndex({ trackId: 1, createdAt: -1 });
    await store.runs.createIndex({ trackId: 1, playerName: 1, totalTime: 1 });
    return store;
  }

  async list(trackId: string, limit: number): Promise<RunSummary[]> {
    return (await this.runs
      .find({ trackId }, { projection: { path: 0 } })
      .sort({ totalTime: 1 })
      .limit(limit)
      .toArray()) as unknown as RunSummary[];
  }

  async get(id: string): Promise<Run | null> {
    const { ObjectId } = await import('mongodb');
    if (!ObjectId.isValid(id)) return null;
    return (await this.runs.findOne({ _id: new ObjectId(id) as any })) as Run | null;
  }

  async topWithPaths(trackId: string, limit: number): Promise<Run[]> {
    return (await this.runs.find({ trackId }).sort({ totalTime: 1 }).limit(limit).toArray()) as Run[];
  }

  async byIds(ids: string[]): Promise<Run[]> {
    const { ObjectId } = await import('mongodb');
    const oids = ids.filter((i) => ObjectId.isValid(i)).map((i) => new ObjectId(i));
    if (!oids.length) return [];
    return (await this.runs.find({ _id: { $in: oids as any } }).toArray()) as Run[];
  }

  async insert(run: Run): Promise<string> {
    const res = await this.runs.insertOne(run as any);
    return String(res.insertedId);
  }

  /**
   * Matchmaking: rank stored runs by how close their total time is to the
   * player's projected time. Racing the outright fastest ghost means losing by
   * 40 seconds in the first corner; this is what makes every demo finish close.
   */
  async matchmake(trackId: string, projectedTime: number, limit: number, excludeName?: string): Promise<Run[]> {
    const pipeline: any[] = [
      { $match: { trackId } },
      ...(excludeName ? [{ $match: { playerName: { $ne: excludeName } } }] : []),
      { $addFields: { delta: { $abs: { $subtract: ['$totalTime', projectedTime] } } } },
      { $sort: { delta: 1 } },
      { $limit: limit },
    ];
    let out = (await this.runs.aggregate(pipeline).toArray()) as Run[];
    if (out.length < limit && excludeName) {
      // Not enough other people have played yet - fall back to including our own.
      const relaxed: any[] = [
        { $match: { trackId } },
        { $addFields: { delta: { $abs: { $subtract: ['$totalTime', projectedTime] } } } },
        { $sort: { delta: 1 } },
        { $limit: limit },
      ];
      out = (await this.runs.aggregate(relaxed).toArray()) as Run[];
    }
    return out;
  }

  async bestFor(trackId: string, playerName: string): Promise<RunSummary | null> {
    const r = await this.runs
      .find({ trackId, playerName }, { projection: { path: 0 } })
      .sort({ totalTime: 1 })
      .limit(1)
      .toArray();
    return (r[0] as unknown as RunSummary) ?? null;
  }

  async reset(trackId: string, keepSynthetic: boolean): Promise<number> {
    const filter: any = { trackId };
    if (keepSynthetic) filter.synthetic = { $ne: true };
    const res = await this.runs.deleteMany(filter);
    return res.deletedCount ?? 0;
  }

  async count(trackId: string): Promise<number> {
    return this.runs.countDocuments({ trackId });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

// ---------------------------------------------------------------------------
// File-backed fallback
// ---------------------------------------------------------------------------
export class FileStore implements RunStore {
  readonly kind = 'file' as const;
  private runs: Run[] = [];
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private file: string) {}

  private async ensure(): Promise<void> {
    if (this.loaded) return;
    try {
      this.runs = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      this.runs = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.runs);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, snapshot);
    });
    return this.writing;
  }

  async list(trackId: string, limit: number): Promise<RunSummary[]> {
    await this.ensure();
    return this.runs
      .filter((r) => r.trackId === trackId)
      .sort((a, b) => a.totalTime - b.totalTime)
      .slice(0, limit)
      .map(stripPath);
  }

  async get(id: string): Promise<Run | null> {
    await this.ensure();
    return this.runs.find((r) => r._id === id) ?? null;
  }

  async topWithPaths(trackId: string, limit: number): Promise<Run[]> {
    await this.ensure();
    return this.runs
      .filter((r) => r.trackId === trackId)
      .sort((a, b) => a.totalTime - b.totalTime)
      .slice(0, limit);
  }

  async byIds(ids: string[]): Promise<Run[]> {
    await this.ensure();
    return this.runs.filter((r) => r._id && ids.includes(r._id));
  }

  async insert(run: Run): Promise<string> {
    await this.ensure();
    const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.runs.push({ ...run, _id: id });
    await this.persist();
    return id;
  }

  async matchmake(trackId: string, projectedTime: number, limit: number, excludeName?: string): Promise<Run[]> {
    await this.ensure();
    const rank = (pool: Run[]) =>
      [...pool]
        .sort((a, b) => Math.abs(a.totalTime - projectedTime) - Math.abs(b.totalTime - projectedTime))
        .slice(0, limit);
    const all = this.runs.filter((r) => r.trackId === trackId);
    const others = excludeName ? all.filter((r) => r.playerName !== excludeName) : all;
    const picked = rank(others);
    return picked.length < limit ? rank(all) : picked;
  }

  async bestFor(trackId: string, playerName: string): Promise<RunSummary | null> {
    await this.ensure();
    const r = this.runs
      .filter((x) => x.trackId === trackId && x.playerName === playerName)
      .sort((a, b) => a.totalTime - b.totalTime)[0];
    return r ? stripPath(r) : null;
  }

  async reset(trackId: string, keepSynthetic: boolean): Promise<number> {
    await this.ensure();
    const before = this.runs.length;
    this.runs = this.runs.filter((r) => {
      if (r.trackId !== trackId) return true;
      return keepSynthetic && r.synthetic === true;
    });
    await this.persist();
    return before - this.runs.length;
  }

  async count(trackId: string): Promise<number> {
    await this.ensure();
    return this.runs.filter((r) => r.trackId === trackId).length;
  }

  async close(): Promise<void> {
    await this.writing;
  }
}

export async function createStore(): Promise<RunStore> {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    try {
      const store = await MongoStore.connect(uri, process.env.MONGODB_DB ?? 'ghostrace');
      console.log('[store] connected to MongoDB Atlas');
      return store;
    } catch (err) {
      // A database problem must not stop the demo from running.
      console.error('[store] Atlas connection failed, falling back to file store:', (err as Error).message);
    }
  } else {
    console.log('[store] MONGODB_URI not set, using file store');
  }
  return new FileStore(process.env.DATA_FILE ?? 'data/runs.json');
}
