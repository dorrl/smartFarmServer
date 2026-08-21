# SmartFarm Server

The server receives Pico sensor readings over BLE UART, stores them locally, and makes them available to the mobile app.

## Sensor schedule and retention

- Default measurement interval: **60 minutes**
- Default retention period: **6 months**
- Change both values in the app's Settings screen for each registered server.
- The server sends the current interval to every connected Pico immediately after a setting change and whenever it reconnects.
- Every received reading is appended to `data/smartfarm-state.json`; old readings are removed automatically according to the retention period.

## BLE UART protocol

The Pico must provide a writable BLE characteristic and a Notify/Indicate characteristic. The server sends newline-delimited JSON commands:

```json
{"command":"setMeasurementInterval","minutes":60}
```

```json
{"command":"measureNow"}
```

The Pico returns a newline-delimited sensor reading:

```json
{"temperature":24.3,"moisture":48,"light":320}
```

## Run

```powershell
npm install
$env:SMARTFARM_API_KEY = "change-this-to-a-long-secret"
npm run start
```

## API

- `GET /state` — current Pico states
- `GET /settings` — measurement interval and retention period
- `POST /settings` — update settings (requires `X-API-Key`)
- `GET /picos/:id/readings?limit=100` — stored readings
- `GET /notifications` — threshold and connection alerts
- `DELETE /data` — delete all saved readings and alerts (requires `X-API-Key`; Pico registration and settings are kept)
- `POST /setPico` — authenticated maintenance/gateway endpoint
