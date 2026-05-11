/**
 * PrinterManager — orquestador de impresoras.
 *
 * Mapea printerId → transport. Cada printer tiene su propia cola FIFO,
 * así dos jobs simultáneos no se interleavan los bytes. Cada job se
 * reintenta hasta MAX_ATTEMPTS con backoff; entre intentos se hace
 * close()+open() para forzar el handshake limpio (esto es lo que
 * resuelve el "atascada" que en WebUSB requería desenchufar).
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  NetworkPrinterRef,
  PrinterRef,
  PrinterStatus,
  UsbPrinterRef,
} from './types';
import { UsbTransport, listUsbPrinters } from './usb-transport';
import { NetTransport } from './net-transport';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [200, 600, 1500];
const CONFIG_DIR = path.join(os.homedir(), '.fidelya');
const NETWORK_PRINTERS_FILE = path.join(CONFIG_DIR, 'network-printers.json');

type Transport = UsbTransport | NetTransport;

interface PrinterState {
  ref: PrinterRef;
  transport: Transport;
  queue: Array<() => Promise<void>>;
  busy: boolean;
  status: PrinterStatus;
}

export class PrinterManager {
  private printers = new Map<string, PrinterState>();
  private networkRefs: NetworkPrinterRef[] = [];
  private startTime = Date.now();

  async init(): Promise<void> {
    await this.loadNetworkPrinters();
  }

  uptimeSec(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * Devuelve TODO lo conectado: USB enumerado en vivo + network guardadas.
   * El frontend usa esto para mostrar el picker de "Vincular impresora".
   */
  async listAvailable(): Promise<PrinterRef[]> {
    const usbList = await listUsbPrinters();
    return [...usbList, ...this.networkRefs];
  }

  listStatus(): PrinterStatus[] {
    return Array.from(this.printers.values()).map((p) => p.status);
  }

  async addNetworkPrinter(host: string, port: number, name?: string): Promise<NetworkPrinterRef> {
    const ref: NetworkPrinterRef = {
      type: 'network',
      id: `net:${host}:${port}`,
      host,
      port,
      name: name || `${host}:${port}`,
    };
    // Sobrescribe si ya existe el mismo id
    this.networkRefs = this.networkRefs.filter((p) => p.id !== ref.id);
    this.networkRefs.push(ref);
    await this.saveNetworkPrinters();
    return ref;
  }

  async removeNetworkPrinter(id: string): Promise<void> {
    this.networkRefs = this.networkRefs.filter((p) => p.id !== id);
    await this.saveNetworkPrinters();
    const state = this.printers.get(id);
    if (state) {
      try { await state.transport.close(); } catch {}
      this.printers.delete(id);
    }
  }

  /**
   * Encola un job y devuelve una promesa que se resuelve cuando se imprime.
   * Si falla todos los intentos, rejecta.
   */
  async print(printerId: string, data: Buffer, label?: string): Promise<{ attempts: number; durationMs: number }> {
    const state = await this.getOrCreateState(printerId);
    state.status.queueDepth += 1;
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const task = async () => {
        let lastError: unknown = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            await state.transport.write(data);
            state.status.lastPrintedAt = new Date().toISOString();
            state.status.connected = true;
            state.status.queueDepth = Math.max(0, state.status.queueDepth - 1);
            log('print-ok', printerId, label, attempt);
            resolve({ attempts: attempt, durationMs: Date.now() - start });
            return;
          } catch (err) {
            lastError = err;
            state.status.lastError = (err as Error)?.message || String(err);
            state.status.lastErrorAt = new Date().toISOString();
            state.status.connected = false;
            log('print-fail', printerId, label, attempt, state.status.lastError);

            // Reset + reopen entre intentos — la clave del recovery.
            try { await state.transport.close(); } catch {}
            await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
            try {
              await state.transport.ensureOpen();
            } catch (openErr) {
              // si no podemos reopen, el próximo intento lo intentará de nuevo
              state.status.lastError = (openErr as Error)?.message || String(openErr);
            }
          }
        }
        state.status.queueDepth = Math.max(0, state.status.queueDepth - 1);
        reject(new Error((lastError as Error)?.message || 'print failed'));
      };

      state.queue.push(task);
      this.drain(state);
    });
  }

  private drain(state: PrinterState): void {
    if (state.busy) return;
    const next = state.queue.shift();
    if (!next) return;
    state.busy = true;
    next().finally(() => {
      state.busy = false;
      // Si quedan jobs encolados, los procesamos en cascada
      if (state.queue.length > 0) this.drain(state);
    });
  }

  async shutdown(): Promise<void> {
    for (const state of this.printers.values()) {
      try { await state.transport.close(); } catch {}
    }
    this.printers.clear();
  }

  // ==================== private ====================

  private async getOrCreateState(printerId: string): Promise<PrinterState> {
    const existing = this.printers.get(printerId);
    if (existing) return existing;
    const ref = await this.resolveRef(printerId);
    if (!ref) throw new Error(`Impresora desconocida: ${printerId}`);
    const transport = ref.type === 'usb'
      ? new UsbTransport(ref as UsbPrinterRef)
      : new NetTransport(ref as NetworkPrinterRef);
    const state: PrinterState = {
      ref,
      transport,
      queue: [],
      busy: false,
      status: {
        printerId: ref.id,
        connected: false,
        queueDepth: 0,
      },
    };
    this.printers.set(printerId, state);
    return state;
  }

  private async resolveRef(printerId: string): Promise<PrinterRef | null> {
    if (printerId.startsWith('net:')) {
      const net = this.networkRefs.find((p) => p.id === printerId);
      if (net) return net;
      // Permitir net:host:port ad-hoc aunque no esté guardado (parsea del id)
      const match = /^net:(.+):(\d+)$/.exec(printerId);
      if (match) {
        const host = match[1];
        const port = Number(match[2]);
        return { type: 'network', id: printerId, host, port, name: `${host}:${port}` };
      }
      return null;
    }
    // USB — buscar en lo enumerado en vivo
    const usbList = await listUsbPrinters();
    return usbList.find((p) => p.id === printerId) || null;
  }

  private async loadNetworkPrinters(): Promise<void> {
    try {
      const raw = await fs.readFile(NETWORK_PRINTERS_FILE, 'utf8');
      const parsed = JSON.parse(raw) as NetworkPrinterRef[];
      if (Array.isArray(parsed)) this.networkRefs = parsed;
    } catch {
      // archivo no existe → vacío
      this.networkRefs = [];
    }
  }

  private async saveNetworkPrinters(): Promise<void> {
    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      await fs.writeFile(NETWORK_PRINTERS_FILE, JSON.stringify(this.networkRefs, null, 2));
    } catch (err) {
      log('save-net-printers-fail', '', '', 0, (err as Error)?.message);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...args: unknown[]): void {
  // Logging plano a stdout — el shell o el wrapper lo capturan a archivo.
  // Formato: timestamp event ...args
  process.stdout.write(`[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`);
}
