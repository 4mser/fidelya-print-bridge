/**
 * Transport TCP raw — para impresoras ethernet que escuchan en :9100.
 * Casi todas las impresoras térmicas con RJ45 soportan este protocolo
 * (también llamado JetDirect).
 */

import * as net from 'net';
import type { NetworkPrinterRef } from './types';

const CONNECT_TIMEOUT_MS = 4000;
const WRITE_TIMEOUT_MS = 8000;

export class NetTransport {
  private socket: net.Socket | null = null;

  constructor(private readonly ref: NetworkPrinterRef) {}

  async ensureOpen(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      const s = new net.Socket();
      let settled = false;
      const onErr = (err: Error) => {
        if (settled) return;
        settled = true;
        try { s.destroy(); } catch {}
        reject(err);
      };
      const timer = setTimeout(() => onErr(new Error('Timeout conectando a la impresora de red')), CONNECT_TIMEOUT_MS);
      s.once('error', onErr);
      s.connect(this.ref.port, this.ref.host, () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        s.removeListener('error', onErr);
        this.socket = s;
        // Reconexión auto si el otro lado cierra
        s.on('close', () => {
          if (this.socket === s) this.socket = null;
        });
        s.on('error', () => {
          if (this.socket === s) this.socket = null;
          try { s.destroy(); } catch {}
        });
        resolve();
      });
    });
  }

  async write(data: Buffer): Promise<void> {
    await this.ensureOpen();
    const socket = this.socket!;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout escribiendo a la impresora de red')), WRITE_TIMEOUT_MS);
      socket.write(data, (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    await new Promise<void>((resolve) => {
      try { s.end(() => resolve()); } catch { resolve(); }
      setTimeout(resolve, 500); // safety
    });
    try { s.destroy(); } catch {}
  }
}
