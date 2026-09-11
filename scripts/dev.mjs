// Runs the API server (tsx watch) and the Vite dev server together. Ctrl-C stops both.
import { spawn } from 'node:child_process';
import 'dotenv/config';

const procs = [
  spawn('npm', ['run', 'dev:server'], { stdio: 'inherit', env: { ...process.env, PORT: process.env.PORT ?? '8080' } }),
  spawn('npm', ['run', 'dev:client'], { stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exit(code); } }));
