# FIDELYA Print Bridge

Mini-agente local que corre en la PC donde están conectadas las impresoras térmicas. Mantiene una conexión persistente con cada impresora (USB o Ethernet), administra una cola de impresión por impresora, y reintenta automáticamente cuando hay errores. El frontend de FIDELYA habla con él vía `http://127.0.0.1:9100` en vez de pelearse con WebUSB.

## Por qué existe

WebUSB desde el browser es frágil para impresoras de cocina:
- El endpoint USB se duerme y aparece "Impresora atascada".
- `device.reset()` desde el browser no resetea de verdad.
- No se puede usar Ethernet.

Este bridge corre fuera del browser con libusb a nivel sistema, así puede `reset()` de verdad, retomar el control después de errores, y manejar tanto USB como Ethernet con la misma API.

## Endpoints

Todos en `http://127.0.0.1:9100`. CORS abierto para FIDELYA.

| Método | Path | Qué hace |
|---|---|---|
| `GET` | `/health` | Status del bridge + lista de impresoras conocidas. El frontend lo usa para detectar si está corriendo. |
| `GET` | `/printers` | Enumera USB en vivo + network guardadas. |
| `POST` | `/printers/network` | Body: `{ host, port, name? }`. Guarda una impresora Ethernet. |
| `DELETE` | `/printers/network/:id` | Elimina una network. |
| `POST` | `/print` | Body: `{ printerId, bytes, label? }`. `bytes` es ESC/POS en base64. Sync — responde cuando imprimió o agotó reintentos. |

## Instalación (dev)

```bash
npm install
npm run dev
```

Esto arranca el bridge en modo desarrollo (`ts-node-dev`). Va a escuchar en `127.0.0.1:9100`.

## Build producción

```bash
npm run build    # TypeScript → dist/
npm start        # Corre dist/index.js
```

## Binarios single-file

Para distribuir a los locales sin que tengan que instalar Node:

```bash
npm run build:binaries
```

Esto produce ejecutables para macOS arm64, macOS x64, y Windows x64 en `bin/`. El cocinero baja el correcto, doble click, y queda corriendo. No requiere Node instalado.

## Permisos USB por sistema operativo

### macOS

Funciona sin drivers. Si la impresora aparece en "Impresoras y escáneres" del sistema, **quitarla de ahí** — si no, CUPS se la pelea al bridge y va a fallar el claim.

### Windows

El device necesita el driver **WinUSB** (no el de impresora del sistema). Si nunca se usó WebUSB con esta impresora, instalar [Zadig](https://zadig.akeo.ie/) y reemplazar el driver por WinUSB. Si ya se vinculó alguna vez por WebUSB, ya está listo.

Tampoco debe estar agregada como impresora del sistema en "Dispositivos e impresoras".

### Linux

Instalar libusb: `sudo apt install libusb-1.0-0-dev`. Crear una regla udev para permitir acceso sin sudo:

```
# /etc/udev/rules.d/99-fidelya-bridge.rules
SUBSYSTEM=="usb", ATTRS{idVendor}=="*", MODE="0666"
```

Después `sudo udevadm control --reload`.

## Logs

Todo va a stdout en formato `[ISO timestamp] event ...args`. Si lo corrés como servicio con `systemd` / `launchd`, redirigí a `~/.fidelya/print-bridge.log`.

## Config

| Env | Default | Qué hace |
|---|---|---|
| `FIDELYA_BRIDGE_PORT` | `9100` | Puerto HTTP del bridge. |

Las impresoras de red se persisten en `~/.fidelya/network-printers.json`.

## Troubleshooting

**`No se pudo tomar la impresora USB. unable to claim interface`** — el OS tiene tomada la impresora. Quitala de la lista de impresoras del sistema (mac: Impresoras y escáneres → eliminar; win: Dispositivos e impresoras → eliminar; linux: `sudo modprobe -r usblp`).

**El frontend dice "bridge no encontrado"** — verificá que el bridge esté corriendo (`curl http://127.0.0.1:9100/health`) y que el puerto no esté ocupado por otra app.

**La impresora aparece en `/printers` pero no imprime** — fijate los logs. Si dice `LIBUSB_ERROR_PIPE` o `LIBUSB_ERROR_IO`, desenchufala 10 segundos y vuelve a enchufarla. Si pasa todo el tiempo, hay un problema de hardware o de driver — probá reemplazar el cable USB.
