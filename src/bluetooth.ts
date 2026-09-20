import noble from '@abandonware/noble';
import { Pico, picoList } from './pico.js';
import { PicoState } from './types.js';

// active BLE connections: maps picoId to noble Peripheral
const connectedPeripherals = new Map<string, any>();
const connectingPeripherals = new Set<string>();
const pollingTimers = new Map<string, ReturnType<typeof setInterval>>();
let scanning = false;
let connectionQueueRunning = false;
const connectionQueue: Array<{ peripheral: any; picoId: string; localName?: string }> = [];

async function startScanning() {
  if (scanning) return;
  try {
    await noble.startScanningAsync([], true);
    scanning = true;
  } catch (error) {
    console.error('[Bluetooth Scanner] Error starting scan:', error);
  }
}

async function stopScanning() {
  if (!scanning) return;
  try {
    await noble.stopScanningAsync();
  } catch (error) {
    console.error('[Bluetooth Scanner] Error stopping scan:', error);
  } finally {
    scanning = false;
  }
}

// Scan filtering: we can connect to any device whose name contains these keywords
const PICO_NAME_KEYWORDS = ['pico', 'smartfarm', 'mydevice', 'farm'];

/**
 * Parses received BLE buffer into PicoState.
 * Supports:
 * 1. JSON string: {"temperature":25,"moisture":45,"light":120}
 * 2. Comma/space-separated values: 25.5,45,120 (temp,moist,light)
 * 3. Key-value string: temp:23.4, moist:50, light:120
 * 4. Binary float: 12 bytes = 3 floats (LE)
 * 5. Binary int16: 6 bytes = 3 int16 (LE)
 */
function parsePicoState(data: Buffer, currentState: PicoState): PicoState | null {
  const str = data.toString('utf-8').trim();

  // 1. Try parsing JSON
  try {
    const parsed = JSON.parse(str);
    const result = { ...currentState };
    let changed = false;
    if (typeof parsed.temperature === 'number') { result.temperature = parsed.temperature; changed = true; }
    if (typeof parsed.moisture === 'number') { result.moisture = parsed.moisture; changed = true; }
    if (typeof parsed.light === 'number') { result.light = parsed.light; changed = true; }
    if (changed) return result;
  } catch (_) {
    // Ignore JSON parse errors
  }

  // 2. Try parsing key-value string
  const result = { ...currentState };
  let matchFound = false;
  const kvRegex = /(temp(?:erature)?|moist(?:ure)?|light|t|m|l)\s*[:=]\s*(-?\d+(?:\.\d+)?)/gi;
  let match;
  while ((match = kvRegex.exec(str)) !== null) {
    const key = match[1].toLowerCase();
    const val = parseFloat(match[2]);
    if (!Number.isNaN(val)) {
      if (key.startsWith('t')) {
        result.temperature = val;
        matchFound = true;
      } else if (key.startsWith('m')) {
        result.moisture = val;
        matchFound = true;
      } else if (key.startsWith('l')) {
        result.light = val;
        matchFound = true;
      }
    }
  }
  if (matchFound) return result;

  // 3. Try parsing comma- or space-separated numbers
  const parts = str.split(/[\s,]+/);
  if (parts.length === 3) {
    const temperature = parseFloat(parts[0]);
    const moisture = parseFloat(parts[1]);
    const light = parseFloat(parts[2]);
    if (!Number.isNaN(temperature) && !Number.isNaN(moisture) && !Number.isNaN(light)) {
      return { temperature, moisture, light };
    }
  }

  // 4. Binary float: 3 floats x 4 bytes
  if (data.length === 12) {
    try {
      return {
        temperature: data.readFloatLE(0),
        moisture: data.readFloatLE(4),
        light: data.readFloatLE(8)
      };
    } catch (_) { }
  }

  // 5. Binary int16: 3 int16 x 2 bytes
  if (data.length === 6) {
    try {
      return {
        temperature: data.readInt16LE(0),
        moisture: data.readInt16LE(2),
        light: data.readInt16LE(4)
      };
    } catch (_) { }
  }

  return null;
}

function applyPicoState(
  pico: Pico,
  data: Buffer,
  characteristicUuid: string,
  source: 'notification' | 'polling'
) {
  const updatedState = parsePicoState(data, pico.state);
  if (!updatedState) return;

  try {
    pico.setState(updatedState);
  } catch (error) {
    const rawValue = data.toString('utf-8').trim();
    console.error(
      `[Bluetooth ${source}] Ignoring invalid sensor payload from Pico [${pico.id}] characteristic [${characteristicUuid}] value [${rawValue}]`,
      error instanceof Error ? error.message : error
    );
  }
}

function clearPicoPolling(picoId: string) {
  const timer = pollingTimers.get(picoId);
  if (timer) {
    clearInterval(timer);
    pollingTimers.delete(picoId);
  }
}

// Noble state change handler
noble.on('stateChange', async (state) => {
  if (state === 'poweredOn') {
    await startScanning();
  } else {
    for (const timer of pollingTimers.values()) clearInterval(timer);
    pollingTimers.clear();
    connectedPeripherals.clear();
    connectingPeripherals.clear();
    connectionQueue.length = 0;
    await stopScanning();
  }
});

async function processConnectionQueue() {
  if (connectionQueueRunning) return;
  connectionQueueRunning = true;

  try {
    while (connectionQueue.length > 0) {
      const item = connectionQueue.shift();
      if (!item) continue;

      const { peripheral, picoId, localName } = item;

      // The device may have disconnected or been handled while it was queued.
      if (!connectingPeripherals.has(picoId) || connectedPeripherals.has(picoId)) {
        continue;
      }

      try {
        // Only one connection attempt runs at a time. This is much safer for
        // adapters that do not behave well when scanning and connecting overlap.
        console.log(`[Bluetooth] Connecting: ${picoId} (${localName ?? '(no name)'})`);
        await stopScanning();
        console.log(`[Bluetooth] Scan stopped for connection: ${picoId}`);
        await peripheral.connectAsync();
        console.log(`[Bluetooth] Connected: ${picoId}`);

        let pico = picoList[picoId];
        if (!pico) {
          pico = new Pico({
            id: picoId,
            name: localName || `Pico-${picoId}`,
            connected: true,
            state: { temperature: 0, moisture: 0, light: 0 }
          });
          picoList[picoId] = pico;
        } else {
          pico.setConnected(true);
          if (localName) pico.name = localName;
        }

        connectedPeripherals.set(picoId, peripheral);
        connectingPeripherals.delete(picoId);

        peripheral.once('disconnect', () => {
          pico!.setConnected(false);
          connectedPeripherals.delete(picoId);
          connectingPeripherals.delete(picoId);
          clearPicoPolling(picoId);

          // Allow this device to be discovered again after disconnect.
          console.log(`[Bluetooth] Disconnected: ${picoId}`);
          void startScanning();
        });

        console.log(`[Bluetooth] Discovering services: ${picoId}`);
        const { characteristics } =
          await peripheral.discoverAllServicesAndCharacteristicsAsync();
        console.log(
          `[Bluetooth] Services discovered: ${picoId}, characteristics=${characteristics.length}`
        );

        let hasSubscription = false;

        // 1. Subscribe to Notify/Indicate characteristics.
        for (const characteristic of characteristics) {
          const props = characteristic.properties;
          if (!props.includes('notify') && !props.includes('indicate')) continue;

          // Keep byte data intact. JSON may be fragmented across notifications,
          // while binary sensor packets should be parsed as complete packets.
          let pendingText = '';

          characteristic.on('data', (dataBuffer: Buffer) => {
            // Binary sensor packets are complete BLE notifications in the
            // supported 6-byte/12-byte formats.
            if (dataBuffer.length === 6 || dataBuffer.length === 12) {
              applyPicoState(pico!, dataBuffer, characteristic.uuid, 'notification');
              return;
            }

            const chunk = dataBuffer.toString('utf-8');
            pendingText += chunk;

            // Handle complete JSON objects split across notifications.
            while (true) {
              const start = pendingText.indexOf('{');

              if (start < 0) {
                // If this is plain text rather than JSON, keep only a small
                // amount of data so malformed input cannot grow forever.
                if (pendingText.length > 4096) pendingText = pendingText.slice(-1024);
                break;
              }

              if (start > 0) pendingText = pendingText.slice(start);

              const end = pendingText.indexOf('}');
              if (end < 0) break;

              const message = pendingText.slice(0, end + 1);
              pendingText = pendingText.slice(end + 1);
              applyPicoState(
                pico!,
                Buffer.from(message, 'utf-8'),
                characteristic.uuid,
                'notification'
              );
            }

            // Plain text payloads such as "25.5,45,120" can be newline framed.
            const lines = pendingText.split(/\r?\n/);
            if (lines.length > 1) {
              pendingText = lines.pop() ?? '';
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) {
                  applyPicoState(
                    pico!,
                    Buffer.from(trimmed, 'utf-8'),
                    characteristic.uuid,
                    'notification'
                  );
                }
              }
            }
          });

          characteristic.on('error', (error: Error) => {
            console.error(
              `[Bluetooth Subscription] Error on characteristic [${characteristic.uuid}] for Pico [${picoId}]:`,
              error
            );
          });

          console.log(
            `[Bluetooth] Subscribing: Pico=${picoId} characteristic=${characteristic.uuid}`
          );
          await characteristic.subscribeAsync();
          hasSubscription = true;
          console.log(
            `[Bluetooth] Subscribed: Pico=${picoId} characteristic=${characteristic.uuid}`
          );
        }

        // 2. Poll readable-only characteristics when Notify/Indicate is absent.
        const readableChars = characteristics.filter((c: any) =>
          c.properties.includes('read') &&
          !c.properties.includes('notify') &&
          !c.properties.includes('indicate')
        );

        if (readableChars.length > 0) {
          const lastPolledValues = new Map<string, string>();
          let pollInProgress = false;

          const pollInterval = setInterval(async () => {
            if (!connectedPeripherals.has(picoId)) {
              clearInterval(pollInterval);
              pollingTimers.delete(picoId);
              return;
            }

            // Never start a second polling cycle before the previous one ends.
            if (pollInProgress) return;
            pollInProgress = true;

            try {
              for (const char of readableChars) {
                const dataBuffer = await char.readAsync();
                const rawValue = dataBuffer.toString('base64');

                if (lastPolledValues.get(char.uuid) === rawValue) continue;
                lastPolledValues.set(char.uuid, rawValue);

                applyPicoState(pico!, dataBuffer, char.uuid, 'polling');
              }
            } catch (error: any) {
              console.error(
                `[Bluetooth Polling] Error polling Pico [${picoId}] characteristic [${readableChars.map((char: any) => char.uuid).join(', ')}]:`,
                error?.message || error
              );
            } finally {
              pollInProgress = false;
            }
          }, hasSubscription ? 5000 : 1000);

          pollingTimers.set(picoId, pollInterval);
        }

        if (!hasSubscription && readableChars.length === 0) {
          console.warn(
            `[Bluetooth Warning] Pico [${picoId}] has no Notify, Indicate, or Read characteristics!`
          );
        }

        console.log(`[Bluetooth] Connection flow complete: ${picoId}`);
      } catch (error) {
        console.error(
          `[Bluetooth Connection] Error during connection flow for Pico [${picoId}]:`,
          error
        );

        connectedPeripherals.delete(picoId);
        connectingPeripherals.delete(picoId);
        clearPicoPolling(picoId);

        const pico = picoList[picoId];
        if (pico) pico.setConnected(false);

        console.error(`[Bluetooth] Connection flow failed: ${picoId}`);

        try {
          await peripheral.disconnectAsync();
        } catch (_) {
          // Ignore disconnect errors for a failed connection.
        }
      } finally {
        // Resume scanning after each connection attempt so the next Pico can
        // be discovered.
        await startScanning();
      }
    }
  } finally {
    connectionQueueRunning = false;
  }
}

// Device discovery handler
noble.on('discover', (peripheral) => {
  const localName = peripheral.advertisement.localName;
  const rawId = peripheral.address || peripheral.id;

  console.log(
    `[Bluetooth Discover] name=${localName ?? '(no name)'} id=${rawId ?? '(no id)'}`
  );

  if (!rawId) return;

  const picoId = rawId.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (connectingPeripherals.has(picoId) || connectedPeripherals.has(picoId)) {
    return;
  }

  const isPico =
    !!localName &&
    PICO_NAME_KEYWORDS.some(keyword =>
      localName.toLowerCase().includes(keyword)
    );

  if (!isPico) {
    console.log(
      `[Bluetooth Discover] Ignored device: name=${localName ?? '(no name)'}`
    );
    return;
  }

  console.log(`[Bluetooth] Queuing Pico: ${picoId}`);

  // Queue the device instead of starting another connection flow from inside
  // the discover event. This prevents concurrent stopScan/connect/startScan
  // races when several Picos advertise at nearly the same time.
  connectingPeripherals.add(picoId);
  connectionQueue.push({ peripheral, picoId, localName });
  void processConnectionQueue();
});
