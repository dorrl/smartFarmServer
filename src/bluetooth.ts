import noble from '@abandonware/noble';
import { Pico, picoList } from './pico.js';
import { PicoState } from './types.js';

const connectedPeripherals = new Map<string, any>();
const connectingPeripherals = new Set<string>();
const pollingTimers = new Map<string, ReturnType<typeof setInterval>>();
let scanning = false;
let connectionQueueRunning = false;
const connectionQueue: Array<{ peripheral: any; picoId: string; localName?: string }> = [];

const PICO_NAME_KEYWORDS = ['smartfarm-pico'];
const CONNECT_TIMEOUT_MS = 12_000;
const CONNECT_RETRY_COUNT = 2;
const CONNECT_RETRY_DELAY_MS = 1_000;

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

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectWithTimeout(peripheral: any, picoId: string) {
  for (let attempt = 1; attempt <= CONNECT_RETRY_COUNT; attempt++) {
    console.log(`[BLE] Connecting: ${picoId} (attempt ${attempt}/${CONNECT_RETRY_COUNT})`);

    try {
      await Promise.race([
        peripheral.connectAsync(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`connection timeout after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)
        )
      ]);
      console.log(`[BLE] Connected: ${picoId}`);
      return;
    } catch (error) {
      console.error(`[BLE] Connection attempt failed: ${picoId}`, error instanceof Error ? error.message : error);
      try {
        await peripheral.disconnectAsync();
      } catch (_) {
        // Ignore cleanup errors.
      }

      if (attempt < CONNECT_RETRY_COUNT) {
        await delay(CONNECT_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`failed to connect after ${CONNECT_RETRY_COUNT} attempts`);
}

function parsePicoState(data: Buffer, currentState: PicoState): PicoState | null {
  const str = data.toString('utf-8').trim();

  try {
    const parsed = JSON.parse(str);
    const result = { ...currentState };
    let changed = false;
    if (typeof parsed.temperature === 'number') { result.temperature = parsed.temperature; changed = true; }
    if (typeof parsed.moisture === 'number') { result.moisture = parsed.moisture; changed = true; }
    if (typeof parsed.light === 'number') { result.light = parsed.light; changed = true; }
    if (changed) return result;
  } catch (_) {}

  const result = { ...currentState };
  let matchFound = false;
  const kvRegex = /(temp(?:erature)?|moist(?:ure)?|light|t|m|l)\s*[:=]\s*(-?\d+(?:\.\d+)?)/gi;
  let match;
  while ((match = kvRegex.exec(str)) !== null) {
    const key = match[1].toLowerCase();
    const val = parseFloat(match[2]);
    if (!Number.isNaN(val)) {
      if (key.startsWith('t')) result.temperature = val;
      else if (key.startsWith('m')) result.moisture = val;
      else if (key.startsWith('l')) result.light = val;
      matchFound = true;
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
      return { temperature: data.readFloatLE(0), moisture: data.readFloatLE(4), light: data.readFloatLE(8) };
    } catch (_) {}
  }

  if (data.length === 6) {
    try {
      return { temperature: data.readInt16LE(0), moisture: data.readInt16LE(2), light: data.readInt16LE(4) };
    } catch (_) {}
  }

  return null;
}

function applyPicoState(pico: Pico, data: Buffer, characteristicUuid: string, source: 'notification' | 'polling') {
  const updatedState = parsePicoState(data, pico.state);
  if (!updatedState) return;

  try {
    pico.setState(updatedState);
  } catch (error) {
    const rawValue = data.toString('utf-8').trim();
    console.error(`[Bluetooth ${source}] Ignoring invalid sensor payload from Pico [${pico.id}] characteristic [${characteristicUuid}] value [${rawValue}]`, error instanceof Error ? error.message : error);
  }
}

function clearPicoPolling(picoId: string) {
  const timer = pollingTimers.get(picoId);
  if (timer) {
    clearInterval(timer);
    pollingTimers.delete(picoId);
  }
}

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
      if (!connectingPeripherals.has(picoId) || connectedPeripherals.has(picoId)) continue;

      try {
        await stopScanning();
        await connectWithTimeout(peripheral, picoId);

        let pico = picoList[picoId];
        if (!pico) {
          pico = new Pico({ id: picoId, name: localName || `Pico-${picoId}`, connected: true, state: { temperature: 0, moisture: 0, light: 0 } });
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
          console.log(`[BLE] Disconnected: ${picoId}`);
          void startScanning();
        });

        const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
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

            const chunk = dataBuffer.toString('utf-8');
            pendingText += chunk;

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
                if (trimmed) applyPicoState(pico!, Buffer.from(trimmed, 'utf-8'), characteristic.uuid, 'notification');
              }
            }
          });

          characteristic.on('error', (error: Error) => {
            console.error(`[Bluetooth Subscription] Error on characteristic [${characteristic.uuid}] for Pico [${picoId}]:`, error);
          });
          await characteristic.subscribeAsync();
          hasSubscription = true;
        }

        const readableChars = characteristics.filter((c: any) => c.properties.includes('read') && !c.properties.includes('notify') && !c.properties.includes('indicate'));
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
              console.error(`[Bluetooth Polling] Error polling Pico [${picoId}] characteristic [${readableChars.map((char: any) => char.uuid).join(', ')}]:`, error?.message || error);
            } finally {
              pollInProgress = false;
            }
          }, hasSubscription ? 5000 : 1000);
          pollingTimers.set(picoId, pollInterval);
        }

        if (!hasSubscription && readableChars.length === 0) {
          console.warn(`[Bluetooth Warning] Pico [${picoId}] has no Notify, Indicate, or Read characteristics!`);
        }
      } catch (error) {
        console.error(`[Bluetooth Connection] Error during connection flow for Pico [${picoId}]:`, error);
        connectedPeripherals.delete(picoId);
        connectingPeripherals.delete(picoId);
        clearPicoPolling(picoId);
        const pico = picoList[picoId];
        if (pico) pico.setConnected(false);
        try { await peripheral.disconnectAsync(); } catch (_) {}
      } finally {
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
  if (connectingPeripherals.has(picoId) || connectedPeripherals.has(picoId)) return;

  const isPico = !!localName && PICO_NAME_KEYWORDS.some(keyword => localName.toLowerCase().includes(keyword));
  if (!isPico) return;

  connectingPeripherals.add(picoId);
  connectionQueue.push({ peripheral, picoId, localName });
  void processConnectionQueue();
});
