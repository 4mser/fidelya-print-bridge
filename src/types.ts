/**
 * Tipos compartidos del bridge. Mantener simple — esto es la API pública
 * que consume el frontend FIDELYA.
 */

export type PrinterTransport = 'usb' | 'network';

export interface UsbPrinterRef {
  type: 'usb';
  /** Identificador estable: usb:{vid}-{pid}-{serial|busAddress}. */
  id: string;
  vendorId: number;
  productId: number;
  serial?: string;
  manufacturer?: string;
  product?: string;
  name: string;
}

export interface NetworkPrinterRef {
  type: 'network';
  /** Identificador estable: net:{host}:{port}. */
  id: string;
  host: string;
  port: number;
  name: string;
}

export type PrinterRef = UsbPrinterRef | NetworkPrinterRef;

export interface PrintRequest {
  printerId: string;
  /** ESC/POS en base64. */
  bytes: string;
  /** Opcional — etiqueta para los logs (orderNumber, etc). */
  label?: string;
}

export interface PrintResult {
  ok: boolean;
  jobId: string;
  durationMs: number;
  attempts: number;
  error?: string;
}

export interface PrinterStatus {
  printerId: string;
  connected: boolean;
  queueDepth: number;
  lastErrorAt?: string;
  lastError?: string;
  lastPrintedAt?: string;
}

export interface HealthResponse {
  ok: true;
  version: string;
  pid: number;
  uptimeSec: number;
  printers: PrinterStatus[];
}
