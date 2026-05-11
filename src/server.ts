import express from 'express';
import cors from 'cors';
import type { Request, Response } from 'express';
import type { HealthResponse } from './types';
import { PrinterManager } from './printer-manager';

const VERSION = '0.1.0';

export function createServer(manager: PrinterManager) {
  const app = express();

  app.use(cors({ origin: true }));
  app.use(express.json({ limit: '2mb' }));

  // Health: el frontend lo usa para saber si el bridge está corriendo.
  app.get('/health', (_req: Request, res: Response) => {
    const payload: HealthResponse = {
      ok: true,
      version: VERSION,
      pid: process.pid,
      uptimeSec: manager.uptimeSec(),
      printers: manager.listStatus(),
    };
    res.json(payload);
  });

  // Enumeración en vivo: USB conectadas + network guardadas.
  app.get('/printers', async (_req: Request, res: Response) => {
    try {
      const printers = await manager.listAvailable();
      res.json({ printers });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error)?.message || 'error' });
    }
  });

  // Alta de impresora de red — el frontend manda host + port.
  app.post('/printers/network', async (req: Request, res: Response) => {
    const { host, port, name } = req.body as { host?: string; port?: number; name?: string };
    if (!host || !port) {
      return res.status(400).json({ ok: false, error: 'host y port requeridos' });
    }
    try {
      const ref = await manager.addNetworkPrinter(host, port, name);
      res.json({ printer: ref });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error)?.message || 'error' });
    }
  });

  app.delete('/printers/network/:id', async (req: Request, res: Response) => {
    try {
      await manager.removeNetworkPrinter(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error)?.message || 'error' });
    }
  });

  // Imprimir. Bytes vienen en base64 para sobrevivir JSON.
  // Respuesta sincrónica: 200 cuando la impresora confirmó (o exhausted retries).
  app.post('/print', async (req: Request, res: Response) => {
    const { printerId, bytes, label } = req.body as {
      printerId?: string;
      bytes?: string;
      label?: string;
    };
    if (!printerId || !bytes) {
      return res.status(400).json({ ok: false, error: 'printerId y bytes requeridos' });
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(bytes, 'base64');
    } catch {
      return res.status(400).json({ ok: false, error: 'bytes debe ser base64' });
    }
    if (buffer.length === 0) {
      return res.status(400).json({ ok: false, error: 'bytes vacío' });
    }
    try {
      const result = await manager.print(printerId, buffer, label);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(502).json({ ok: false, error: (err as Error)?.message || 'print failed' });
    }
  });

  return app;
}
