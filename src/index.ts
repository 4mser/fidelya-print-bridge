/**
 * FIDELYA Print Bridge — entrypoint.
 *
 * Single process. Listens on 127.0.0.1:9100 by default (override con env FIDELYA_BRIDGE_PORT).
 * Bind explícito a loopback — no aceptamos conexiones de fuera del equipo.
 */

import { createServer } from './server';
import { PrinterManager } from './printer-manager';

const PORT = Number(process.env.FIDELYA_BRIDGE_PORT) || 9100;
const HOST = '127.0.0.1';

async function main() {
  const manager = new PrinterManager();
  await manager.init();

  const app = createServer(manager);
  const server = app.listen(PORT, HOST, () => {
    process.stdout.write(
      `[${new Date().toISOString()}] FIDELYA Print Bridge corriendo en http://${HOST}:${PORT}\n`,
    );
  });

  const shutdown = async (signal: string) => {
    process.stdout.write(`\n[${new Date().toISOString()}] señal ${signal} — apagando...\n`);
    server.close();
    await manager.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    process.stderr.write(`uncaughtException: ${err.stack || err.message}\n`);
  });
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`unhandledRejection: ${String(err)}\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
