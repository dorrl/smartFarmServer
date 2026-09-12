# SmartFarm Server

The server receives Pico sensor readings over BLE UART, stores them locally, and makes them available to the mobile app.

## Sensor schedule and retention

- Fixed Pico measurement and BLE transmission interval: **1 minute**
- Default server storage and app refresh interval: **5 minutes**
- Default retention period: **6 months**
- Change the server storage and app refresh interval, plus the retention period, in the app's Settings screen for each registered server. The Pico measurement interval is fixed in firmware.
- The server holds the newest BLE reading in memory, then saves a snapshot of every connected Pico at the configured storage interval. Old readings are removed automatically according to the retention period.

## BLE UART protocol

The Pico W advertises the Nordic UART BLE service. The server subscribes to its Notify characteristic for newline-delimited JSON sensor readings.

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
- `GET /settings` — fixed measurement interval and retention period
- `POST /settings` — update retention period (requires `X-API-Key`)
- `GET /picos/:id/readings?limit=100` — stored readings
- `GET /notifications` — threshold and connection alerts
- `DELETE /data` — delete all saved readings and alerts (requires `X-API-Key`; Pico registration and settings are kept)
- `POST /setPico` — authenticated maintenance/gateway endpoint
