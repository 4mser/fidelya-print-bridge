/**
 * Transport USB vía libusb (paquete `usb`).
 *
 * A diferencia de WebUSB, libusb a nivel sistema puede hacer `device.reset()`
 * de verdad, claim/release con semántica completa, y sobrevive estados que
 * el browser no — por eso este bridge resuelve los stalls que en el cliente
 * obligaban a desenchufar la impresora.
 */

import { usb } from 'usb';
import type { Device, Interface as USBInterface, OutEndpoint } from 'usb';
import type { UsbPrinterRef } from './types';

const PRINTER_CLASS = 0x07; // USB class para impresoras
const CHUNK = 1024; // Subimos a 1024 vs los 64 del browser — libusb se banca chunks grandes sin stall

interface OpenedDevice {
  device: Device;
  iface: USBInterface;
  endpointOut: OutEndpoint;
}

function getStringSafe(device: Device, index: number | undefined): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (!index) return resolve(undefined);
    try {
      device.getStringDescriptor(index, (err, value) => {
        if (err || !value) resolve(undefined);
        else resolve(value);
      });
    } catch {
      resolve(undefined);
    }
  });
}

export async function listUsbPrinters(): Promise<UsbPrinterRef[]> {
  const result: UsbPrinterRef[] = [];
  for (const device of usb.getDeviceList()) {
    const desc = device.deviceDescriptor;
    const isPrinter = hasPrinterInterface(device);
    if (!isPrinter) continue;

    let serial: string | undefined;
    let manufacturer: string | undefined;
    let product: string | undefined;
    let opened = false;
    try {
      device.open();
      opened = true;
      [serial, manufacturer, product] = await Promise.all([
        getStringSafe(device, desc.iSerialNumber),
        getStringSafe(device, desc.iManufacturer),
        getStringSafe(device, desc.iProduct),
      ]);
    } catch {
      // device puede estar tomado por el OS — seguimos sin strings
    } finally {
      if (opened) {
        try { device.close(); } catch {}
      }
    }

    const stableId = serial
      ? `usb:${hex(desc.idVendor)}-${hex(desc.idProduct)}-${serial}`
      : `usb:${hex(desc.idVendor)}-${hex(desc.idProduct)}-bus${device.busNumber}.${device.deviceAddress}`;

    const name = product || manufacturer || `USB ${hex(desc.idVendor)}:${hex(desc.idProduct)}`;

    result.push({
      type: 'usb',
      id: stableId,
      vendorId: desc.idVendor,
      productId: desc.idProduct,
      serial,
      manufacturer,
      product,
      name,
    });
  }
  return result;
}

export class UsbTransport {
  private opened: OpenedDevice | null = null;

  constructor(private readonly ref: UsbPrinterRef) {}

  /** Abre el device si está cerrado. Idempotente. */
  async ensureOpen(): Promise<void> {
    if (this.opened) return;
    const device = await findDeviceByRef(this.ref);
    if (!device) throw new Error(`Impresora USB no encontrada (${this.ref.id})`);

    device.open(true); // auto-detach kernel driver donde aplica
    if (!device.interfaces || device.interfaces.length === 0) {
      try { device.close(); } catch {}
      throw new Error('Device sin interfaces USB');
    }

    // Priorizar interfaces vendor-specific (255) > printer (7) > otras.
    const candidates: { ifaceIndex: number; classCode: number }[] = [];
    for (let i = 0; i < device.interfaces.length; i++) {
      candidates.push({
        ifaceIndex: i,
        classCode: device.interfaces[i].descriptor.bInterfaceClass,
      });
    }
    candidates.sort((a, b) => {
      const score = (c: number) => (c === 0xff ? 0 : c === 0x07 ? 1 : 2);
      return score(a.classCode) - score(b.classCode);
    });

    let lastErr: unknown = null;
    for (const c of candidates) {
      const iface = device.interfaces[c.ifaceIndex];
      try {
        if (iface.isKernelDriverActive()) {
          try { iface.detachKernelDriver(); } catch {}
        }
        iface.claim();
        const ep = iface.endpoints.find(
          (e) =>
            e.direction === 'out' &&
            (e as OutEndpoint).transferType === usb.LIBUSB_TRANSFER_TYPE_BULK,
        ) as OutEndpoint | undefined;
        if (!ep) {
          await releaseSafe(iface);
          continue;
        }
        this.opened = { device, iface, endpointOut: ep };
        return;
      } catch (err) {
        lastErr = err;
        await releaseSafe(iface);
      }
    }
    try { device.close(); } catch {}
    throw new Error(
      `No se pudo tomar la impresora USB. ${(lastErr as Error)?.message || 'unable to claim interface'}`,
    );
  }

  async write(data: Buffer): Promise<void> {
    await this.ensureOpen();
    const opened = this.opened!;
    for (let i = 0; i < data.length; i += CHUNK) {
      const slice = data.subarray(i, i + CHUNK);
      await new Promise<void>((resolve, reject) => {
        opened.endpointOut.transfer(slice, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  /** Cierra todo, intenta reset si es posible. */
  async close(): Promise<void> {
    if (!this.opened) return;
    const { device, iface } = this.opened;
    this.opened = null;
    await releaseSafe(iface);
    try {
      await new Promise<void>((resolve, reject) =>
        device.reset((err) => (err ? reject(err) : resolve())),
      );
    } catch {
      // reset puede fallar si el device fue desenchufado — no es fatal
    }
    try { device.close(); } catch {}
  }
}

// ==================== Helpers ====================

async function findDeviceByRef(ref: UsbPrinterRef): Promise<Device | null> {
  for (const d of usb.getDeviceList()) {
    const desc = d.deviceDescriptor;
    if (desc.idVendor !== ref.vendorId || desc.idProduct !== ref.productId) continue;
    if (!ref.serial) return d;
    // Match por serial cuando está disponible
    let serial: string | undefined;
    let opened = false;
    try {
      d.open();
      opened = true;
      serial = await getStringSafe(d, desc.iSerialNumber);
    } catch {
      // si no podemos abrir, fallback a match por vid+pid (mejor que nada)
      return d;
    } finally {
      if (opened) { try { d.close(); } catch {} }
    }
    if (serial === ref.serial) return d;
  }
  return null;
}

function hasPrinterInterface(device: Device): boolean {
  const desc = device.deviceDescriptor;
  if (desc.bDeviceClass === PRINTER_CLASS) return true;
  try {
    const config = device.configDescriptor;
    if (!config) return false;
    for (const iface of config.interfaces) {
      for (const alt of iface) {
        if (alt.bInterfaceClass === PRINTER_CLASS) return true;
        // Vendor-specific también, muchas impresoras se anuncian así
        if (alt.bInterfaceClass === 0xff) {
          const hasOut = alt.endpoints.some(
            (e) =>
              (e.bEndpointAddress & 0x80) === 0 &&
              (e.bmAttributes & 0x03) === 0x02,
          );
          if (hasOut) return true;
        }
      }
    }
  } catch {}
  return false;
}

function releaseSafe(iface: USBInterface): Promise<void> {
  return new Promise((resolve) => {
    try {
      iface.release(true, () => resolve());
    } catch {
      resolve();
    }
  });
}

function hex(n: number): string {
  return n.toString(16).padStart(4, '0');
}
