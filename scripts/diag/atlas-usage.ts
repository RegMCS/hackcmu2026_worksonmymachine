/** Reports Atlas storage usage against the M0 free-tier limit. */
import '../../server/src/env';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }

const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.MONGODB_DB ?? 'ghostrace');
const stats = await db.command({ collStats: 'runs' });
const count = stats.count ?? 0;
const size = stats.size ?? 0;
const storage = stats.storageSize ?? 0;
const indexes = stats.totalIndexSize ?? 0;

const M0 = 512 * 1024 * 1024;
const avg = count ? size / count : 0;

console.log(`documents        : ${count}`);
console.log(`avg document     : ${(avg / 1024).toFixed(1)} KB`);
console.log(`data size        : ${(size / 1024 / 1024).toFixed(2)} MB`);
console.log(`storage + indexes: ${((storage + indexes) / 1024 / 1024).toFixed(2)} MB`);
console.log(`M0 free tier     : 512 MB`);
console.log(`used             : ${(((storage + indexes) / M0) * 100).toFixed(3)}%`);
console.log(`runs that fit    : ~${avg ? Math.floor(M0 / avg).toLocaleString() : 'n/a'}`);
console.log(`indexes          : ${(await db.collection('runs').indexes()).map((i) => i.name).join(', ')}`);

await client.close();
