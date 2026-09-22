import noble from '@abandonware/noble';
import { Pico, picoList } from './pico.js';
import { PicoState } from './types.js';

const CONNECT_TIMEOUT_MS = 12_000;
const MAX_CONNECT_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_000;

// Active BLE connections: maps Pico ID to noble Peripheral.
const connectedPeripherals = new Map<string, any>();
const connectingPeripherals = new Set<string>();
const pollingTimers = new Map<string, ReturnType<typeof setInterval>>();
let scanning = false;
let connectionQueueRunning = false;
const connectionQueue: Array<{ peripheral: any; picoId: string; localName?: string }> = [];

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function startScanning() {
  if (scanning) return;

  try {
    await noble.startScanningAsync([], true);
    scanning = true;
  } catch (error) {
    // Noble can report "already scanning" after a rapid stop/start transition.
    // Keep the local flag conservative and let the next discovery/state event retry.
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

const PICO_NAME_KEYWORDS = ['smartfarm-pico'];

function parsePicoState(data: Buffer, currentState: PicoState): PicoState | null {
  const str = data.toString('utf-8').trim();

  try {
    const parsed = JSON.parse(str);
    const result = { ...currentState };
    let changed = false;

    if (typeof parsed.temperature === 'number') {
      result.temperature = parsed.temperature;
      changed = true;
    }
    if (typeof parsed.moisture === 'number') {
      result.moisture = parsed.moisture;
      changed = true;
    }
    if (typeof parsed.light === 'number') {
      result.light = parsed.light;
      changed = true;
    }

    if (changed) return result;
  } catch (_) {
    // Ignore JSON parse errors.
  }

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

  const parts = str.split(/[\s,]+/);
  if (parts.length === 3) {
    const temperature = parseFloat(parts[0]);
    const moisture = parseFloat(parts[1]);
    const light = parseFloat(parts[2]);

    if (!Number.isNaN(temperature) && !Number.isNaN(moisture) && !Number.isNaN(light)) {
      return { temperature, moisture, light };
    }
  }

  if (data.length === 12) {
    try {
      return {
        temperature: data.readFloatLE(0),
        moisture: data.readFloatLE(4),
        light: data.readFloatLE(8)
      };
    } catch (_) {
      // Ignore malformed binary payloads.
    }
  }

  if (data.length === 6) {
    try {
      return {
        temperature: data.readInt16LE(0),
        moisture: data.readInt16LE(2),
        light: data.readInt16LE(4)
      };
    } catch (_) {
      // Ignore malformed binary payloads.
    }
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

function markPicoDisconnected(picoId: string) {
  const pico = picoList[picoId];
  if (pico) pico.setConnected(false);

  connectedPeripherals.delete(picoId);
  connectingPeripherals.delete(picoId);
  clearPicoPolling(picoId);
}

async function disconnectQuietly(peripheral: any) {
  try {
    if (peripheral?.state === 'connected' || peripheral?.connected === true) {
      await peripheral.disconnectAsync();
    }
  } catch (_) {
    // Ignore cleanup errors.
  }
}

async function connectWithTimeout(peripheral: any, picoId: string) {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      peripheral.connectAsync(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`BLE connection timeout after ${CONNECT_TIMEOUT_MS}ms`));
        }, CONNECT_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  if (peripheral.state !== 'connected' && peripheral.connected !== true) {
    throw new Error(`BLE connection completed without connected state for ${picoId}`);
  }
}

noble.on('stateChange', async (state) => {
  if (state === 'poweredOn') {
    await startScanning();
    return;
  }

  for (const timer of pollingTimers.values()) clearInterval(timer);
  pollingTimers.clear();

  for (const picoId of connectedPeripherals.keys()) {
    const pico = picoList[picoId];
    if (pico) pico.setConnected(false);
  }

  connectedPeripherals.clear();
  connectingPeripherals.clear();
  connectionQueue.length = 0;
  await stopScanning();
});

async function processConnectionQueue() {
  if (connectionQueueRunning) return;
  connectionQueueRunning = true;

  try {
    while (connectionQueue.length > 0) {
      const item = connectionQueue.shift();
      if (!item) continue;

      const { peripheral, picoId, localName } = item;

      if (!connectingPeripherals.has(picoId) || connectedPeripherals.has(picoId)) {
        continue;
      }

      let connected = false;

      try {
        for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
          try {
            // Scanning must be stopped before connecting. The scan is restarted
            // after this device finishes so other Picos can be discovered.
            await stopScanning();
            await connectWithTimeout(peripheral, picoId);
            connected = true;
            break;
          } catch (error) {
            console.error(
              `[Bluetooth Connection] Attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed for Pico [${picoId}]:`,
              error instanceof Error ? error.message : error
            );

            await disconnectQuietly(peripheral);

            if (attempt < MAX_CONNECT_ATTEMPTS) {
              await delay(RETRY_DELAY_MS);
            }
          }
        }

        if (!connected) {
          throw new Error(`Unable to connect to Pico after ${MAX_CONNECT_ATTEMPTS} attempts`);
        }

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
          markPicoDisconnected(picoId);
          console.log(`[BLE] Disconnected: ${picoId}`);
          void startScanning();
        });

        let characteristics: any[];
        try {
          const result = await peripheral.discoverAllServicesAndCharacteristicsAsync();
          characteristics = result.characteristics;
        } catch (error) {
          console.error(`[BLE] Service discovery failed: ${picoId}`, error);
          throw error;
        }

        let hasSubscription = false;

        for (const characteristic of characteristics) {
          const props = characteristic.properties;
          if (!props.includes('notify') && !props.includes('indicate')) continue;

          let pendingText = '';

          characteristic.on('data', (dataBuffer: Buffer) => {
            if (dataBuffer.length === 6 || dataBuffer.length === 12) {
              applyPicoState(pico!, dataBuffer, characteristic.uuid, 'notification');
              return;
            }

            pendingText += dataBuffer.toString('utf-8');

            while (true) {
              const start = pendingText.indexOf('{');
              if (start < 0) {
                if (pendingText.length > 4096) pendingText = pendingText.slice(-1024);
                break;
              }

              if (start > 0) pendingText = pendingText.slice(start);

              const end = pendingText.indexOf('}');
              if (end < 0) break;

              const message = pendingText.slice(0, end + 1);
              pendingText = pendingText.slice(end + 1);
              applyPicoState(pico!, Buffer.from(message, 'utf-8'), characteristic.uuid, 'notification');
            }

            const lines = pendingText.split(/\r?\n/);
            if (lines.length > 1) {
              pendingText = lines.pop() ?? '';
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) {
                  applyPicoState(pico!, Buffer.from(trimmed, 'utf-8'), characteristic.uuid, 'notification');
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

          await characteristic.subscribeAsync();
          hasSubscription = true;
        }

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
      } catch (error) {
        console.error(
          `[Bluetooth Connection] Error during connection flow for Pico [${picoId}]:`,
          error instanceof Error ? error.message : error
        );

        markPicoDisconnected(picoId);
        await disconnectQuietly(peripheral);
      } finally {
        // Always return to scanning so another Pico can be discovered, even if
        // this Pico failed to connect or service discovery failed.
        await startScanning();
      }
    }
  } finally {
    connectionQueueRunning = false;
  }
}

noble.on('discover', (peripheral) => {
  const localName = peripheral.advertisement.localName;
  const rawId = peripheral.address || peripheral.id;
  if (!rawId) return;

  const picoId = rawId.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (connectingPeripherals.has(picoId) || connectedPeripherals.has(picoId)) {
    return;
  }

  const isPico =
    !!localName &&
    PICO_NAME_KEYWORDS.some(keyword => localName.toLowerCase().includes(keyword));

  if (!isPico) return;

  connectingPeripherals.add(picoId);
  connectionQueue.push({ peripheral, picoId, localName });
  void processConnectionQueue();
});
