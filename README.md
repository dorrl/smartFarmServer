# SmartFarm Server

The server receives newline-delimited JSON sensor readings from a BLE UART device and exposes them to the mobile app.

## BLE UART contract

The Pico's Bluetooth module must be a **BLE UART** module (not classic Bluetooth-only HC-05/HC-06). It must advertise a name containing `pico`, `smartfarm`, `mydevice`, or `farm`, expose a Notify/Indicate characteristic for readings, and a Write/Write Without Response characteristic for commands.

Reading sent by the Pico:

```json
{"temperature":24.3,"moisture":48,"light":320}
```

Watering command sent by the server:

```json
{"command":"water","enabled":true,"durationSeconds":30}
```

## Run

```powershell
npm install
$env:SMARTFARM_API_KEY = "change-this-to-a-long-secret"
npm run start
```

`GET /state`, `GET /notifications`, and `GET /picos/:id/readings` are read-only. All write endpoints require the `X-API-Key` header. Sensor state, history, and alerts persist in `data/smartfarm-state.json`.

## API

- `GET /state` — current Pico status
- `GET /notifications` — automatically generated threshold and disconnect alerts
- `GET /picos/:id/readings?limit=100` — recent sensor history
- `POST /picos/:id/commands` — authenticated watering or ping command
- `POST /setPico` — authenticated maintenance/gateway endpoint
