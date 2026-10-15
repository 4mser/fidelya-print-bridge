# FIDELYA Print Bridge

A small local agent that runs on the PC where the thermal printers are connected. It keeps a persistent connection to each printer over USB or Ethernet, runs a print queue per printer, and retries automatically on errors. The FIDELYA frontend talks to it at `http://127.0.0.1:9100` instead of using WebUSB.

[Leer en español](README.es.md)

## Why it exists

WebUSB in the browser is fragile for kitchen printers:

- The USB endpoint goes to sleep and the printer shows up as "jammed".
- `device.reset()` from the browser doesn't actually reset the device.
- Ethernet printers aren't supported.

The bridge runs outside the browser with system-level libusb. That lets it do a real `reset()`, recover control after errors, and handle USB and Ethernet behind the same API.

## Endpoints

All of them are served at `http://127.0.0.1:9100`, with CORS open for FIDELYA.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Bridge status and the list of known printers. The frontend uses it to detect whether the bridge is running. |
| `GET` | `/printers` | Lists live USB printers and saved network printers. |
| `POST` | `/printers/network` | Body: `{ host, port, name? }`. Saves an Ethernet printer. |
| `DELETE` | `/printers/network/:id` | Removes a network printer. |
| `POST` | `/print` | Body: `{ printerId, bytes, label? }`, where `bytes` is base64 ESC/POS. It's synchronous and responds once the job prints or all retries are used up. |

## Development

```bash
npm install
npm run dev
```

This starts the bridge in development mode (`ts-node-dev`), listening on `127.0.0.1:9100`.

## Production build

```bash
npm run build    # TypeScript → dist/
npm start        # runs dist/index.js
```

## Single-file binaries

These let stores run the bridge without installing Node:

```bash
npm run build:binaries
```

This builds executables for macOS arm64, macOS x64 and Windows x64 in `bin/`. Download the right one and double-click it. Node isn't required.

## USB permissions by OS

### macOS

No drivers are needed. If the printer is listed under *Printers & Scanners*, **remove it**. Otherwise CUPS competes with the bridge and the claim fails.

### Windows

The device needs the **WinUSB** driver, not the system printer driver. If the printer has never been used through WebUSB, use [Zadig](https://zadig.akeo.ie/) to replace its driver with WinUSB. If it was paired through WebUSB before, it's already set up.

The printer also shouldn't be added as a system printer under *Devices and Printers*.

### Linux

Install libusb with `sudo apt install libusb-1.0-0-dev`, then add a udev rule to allow access without sudo:

```
# /etc/udev/rules.d/99-fidelya-bridge.rules
SUBSYSTEM=="usb", ATTRS{idVendor}=="*", MODE="0666"
```

Then run `sudo udevadm control --reload`.

## Logs

Logs go to stdout as `[ISO timestamp] event ...args`. When running as a `systemd` or `launchd` service, redirect them to `~/.fidelya/print-bridge.log`.

## Configuration

| Env | Default | Description |
|---|---|---|
| `FIDELYA_BRIDGE_PORT` | `9100` | HTTP port of the bridge. |

Network printers are persisted in `~/.fidelya/network-printers.json`.

## Troubleshooting

**`No se pudo tomar la impresora USB. unable to claim interface`**: the OS is holding the printer. Remove it from the system printer list. On macOS, go to *Printers & Scanners* and remove it. On Windows, remove it under *Devices and Printers*. On Linux, run `sudo modprobe -r usblp`.

**The frontend reports "bridge no encontrado"**: check that the bridge is running with `curl http://127.0.0.1:9100/health`, and that no other app is using the port.

**The printer shows up in `/printers` but doesn't print**: check the logs. If you see `LIBUSB_ERROR_PIPE` or `LIBUSB_ERROR_IO`, unplug the printer for 10 seconds and plug it back in. If it keeps happening, it's likely a hardware or driver problem, so try another USB cable.
