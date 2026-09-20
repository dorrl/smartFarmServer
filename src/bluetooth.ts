import noble from '@abandonware/noble';
import { Pico, picoList } from './pico.js';
import { PicoState } from './types.js';

// active BLE connections: maps picoId to noble Peripheral
const connectedPeripherals = new Map<string, any>();
const connectingPeripherals = new Set<string>();
const pollingTimers = new Map<string, ReturnType<typeof setInterval>>();
let scanning = false;

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
 * 3. Key-value string: temp:23.4, moist:50, light:120 (single updates are merged with current state)
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
  } catch (e) {
    // Ignore JSON parse errors
  }

  // 2. Try parsing key-value string (e.g. temp:23.4, moist:50, light:120 or t=23.4, m=50, l=120)
  const result = { ...currentState };
  let matchFound = false;
  const kvRegex = /(temp(?:erature)?|moist(?:ure)?|light|t|m|l)\s*[:=]\s*(-?\d+(?:\.\d+)?)/gi;
  let match;
  while ((match = kvRegex.exec(str)) !== null) {
    const key = match[1].toLowerCase();
    const val = parseFloat(match[2]);
    if (!isNaN(val)) {
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
  if (matchFound) {
    return result;
  }

  // 3. Try parsing comma- or space-separated numbers
  const parts = str.split(/[\s,]+/);
  if (parts.length === 3) {
    const temperature = parseFloat(parts[0]);
    const moisture = parseFloat(parts[1]);
    const light = parseFloat(parts[2]);
    if (!isNaN(temperature) && !isNaN(moisture) && !isNaN(light)) {
      return { temperature, moisture, light };
    }
  }

  // 4. Try parsing binary format (3 floats of 4 bytes each = 12 bytes)
  if (data.length === 12) {
    try {
      const temperature = data.readFloatLE(0);
      const moisture = data.readFloatLE(4);
      const light = data.readFloatLE(8);
      return { temperature, moisture, light };
    } catch (e) { }
  }

  // 5. Try parsing binary format (3 int16 of 2 bytes each = 6 bytes)
  if (data.length === 6) {
    try {
      const temperature = data.readInt16LE(0);
      const moisture = data.readInt16LE(2);
      const light = data.readInt16LE(4);
      return { temperature, moisture, light };
    } catch (e) { }
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

// Noble state change handler
noble.on('stateChange', async (state) => {
  if (state === 'poweredOn') {
    await startScanning();
  } else {
    for (const timer of pollingTimers.values()) clearInterval(timer);
    pollingTimers.clear();
    connectedPeripherals.clear();
    connectingPeripherals.clear();
    await stopScanning();
  }
});
// Device discovery handler
noble.on('discover', async (peripheral) => {
  const localName = peripheral.advertisement.localName;
  const rawId = peripheral.address || peripheral.id;
  if (!rawId) return;

  const picoId = rawId.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Check if we already have an active or pending connection to this device
  if (connectingPeripherals.has(picoId) || connectedPeripherals.has(picoId)) {
    return;
  }

  // Check if the device is a Pico based on the name keywords
  const isPico = localName && PICO_NAME_KEYWORDS.some(keyword => localName.toLowerCase().includes(keyword));

  if (!isPico) {
    // If not matching keywords, skip this device
    return;
  }

  // Start connection attempt
  connectingPeripherals.add(picoId);
  try {
    // Scanning and connecting concurrently is unreliable on some adapters.
    await stopScanning();
    await peripheral.connectAsync();

    // Setup Pico instance in picoList
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
      if (localName) {
        pico.name = localName;
      }
    }

    connectedPeripherals.set(picoId, peripheral);
    connectingPeripherals.delete(picoId);

    // Register disconnect listener
    peripheral.once('disconnect', () => {
      pico.setConnected(false);
      connectedPeripherals.delete(picoId);
      connectingPeripherals.delete(picoId);
      const timer = pollingTimers.get(picoId);
      if (timer) {
        clearInterval(timer);
        pollingTimers.delete(picoId);
      }

      // Auto-restart scanning to allow re-discovery
      startScanning();
    });

    // Discover services and characteristics
    const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();

    let subscribedOrPolled = false;


    // 1. Subscribe to Notify/Indicate characteristics
    for (const characteristic of characteristics) {
      const props = characteristic.properties;
      if (props.includes('notify') || props.includes('indicate')) {
        let pendingData = '';
        characteristic.on('data', (dataBuffer: Buffer) => {
          const chunk = dataBuffer.toString('utf-8');
          pendingData += chunk;

          // A notification can contain only part of a JSON line. Recover complete
          // object frames from the byte stream instead of parsing each packet.
          while (true) {
            const start = pendingData.indexOf('{');
            if (start < 0) {
              pendingData = '';
              break;
            }
            if (start > 0) pendingData = pendingData.slice(start);

            const end = pendingData.indexOf('}');
            if (end < 0) break;

            const message = pendingData.slice(0, end + 1);
            pendingData = pendingData.slice(end + 1).replace(/^\r?\n/, '');
            applyPicoState(pico, Buffer.from(message, 'utf-8'), characteristic.uuid, 'notification');
          }
        });
        characteristic.on('error', (error: Error) => {
          console.error(`[Bluetooth Subscription] Error on characteristic [${characteristic.uuid}] for Pico [${picoId}]:`, error);
        });

        await characteristic.subscribeAsync();
        subscribedOrPolled = true;
      }
    }

    // 2. If no notification characteristics are available, fall back to polling
    // readable-only characteristics. Reading a notify characteristic as well as
    // subscribing to it can return partial UART frames and race the BLE stack.
    const readableChars = characteristics.filter(c =>
      c.properties.includes('read') &&
      !c.properties.includes('notify') &&
      !c.properties.includes('indicate')
    );
    if (readableChars.length > 0) {
      const lastPolledValues = new Map<string, string>();
      const pollInterval = setInterval(async () => {
        if (!connectedPeripherals.has(picoId)) {
          clearInterval(pollInterval);
          return;
        }

        try {
          for (const char of readableChars) {
            const dataBuffer = await char.readAsync();
            const rawValue = dataBuffer.toString('utf-8');
            if (lastPolledValues.get(char.uuid) === rawValue) continue;
            lastPolledValues.set(char.uuid, rawValue);

            applyPicoState(pico, dataBuffer, char.uuid, 'polling');
          }
        } catch (e: any) {
          console.error(`[Bluetooth Polling] Error polling Pico [${picoId}] characteristic [${readableChars.map(char => char.uuid).join(', ')}]:`, e.message || e);
        }
      }, subscribedOrPolled ? 5000 : 1000);
      pollingTimers.set(picoId, pollInterval);

      subscribedOrPolled = true;
    }

    if (!subscribedOrPolled) {
      console.warn(`[Bluetooth Warning] Pico [${picoId}] has no Notify, Indicate, or Read characteristics!`);
    }

    // Keep scanning so additional Picos can connect while this one remains connected.
    await startScanning();

  } catch (err) {
    console.error(`[Bluetooth Connection] Error during connection flow for Pico [${picoId}]:`, err);
    connectedPeripherals.delete(picoId);
    connectingPeripherals.delete(picoId);
    const timer = pollingTimers.get(picoId);
    if (timer) {
      clearInterval(timer);
      pollingTimers.delete(picoId);
    }

    // Attempt to disconnect if partially connected
    try {
      await peripheral.disconnectAsync();
    } catch (_) { }
    await startScanning();
  }
});

