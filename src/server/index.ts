import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { openDatabase } from './db';
import { Repo } from './repo';
import { SyncService } from './sync';

// Paths resolve from the working directory, not import.meta.url — esbuild flattens the
// module into one file, so import.meta.url would point at dist/ in dev and / in Docker.
const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
const staticDir = path.resolve(process.cwd(), process.env.STATIC_DIR ?? 'dist/public');
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

const repo = new Repo(openDatabase(dataDir));

if (process.env.FORTNYT_TZ) {
  const s = repo.getSettings();
  if (!repo.getMeta('settings')) repo.saveSettings({ ...s, timezone: process.env.FORTNYT_TZ });
}

const sync = new SyncService({ repo, secret: process.env.FORTNYT_SECRET || undefined });
const app = createApp({
  repo,
  sync,
  staticDir,
  password: process.env.APP_PASSWORD || undefined,
  user: process.env.APP_USER || undefined,
  todayOverride: process.env.FORTNYT_TODAY || undefined,
});

if (process.env.SYNC_SCHEDULER !== 'off') sync.startScheduler();

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`fortnyt listening on http://${host}:${info.port} (data: ${dataDir})`);
  if (!process.env.FORTNYT_SECRET) {
    console.log('FORTNYT_SECRET is not set: the SimpleFIN access URL will be stored unencrypted in the database.');
  }
  if (!process.env.APP_PASSWORD) {
    console.log('APP_PASSWORD is not set: anyone who can reach this port can see your finances.');
  }
});

const shutdown = () => {
  sync.stopScheduler();
  server.close(() => {
    repo.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
