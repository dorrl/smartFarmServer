import noble from '@abandonware/noble';
import { Pico, picoList } from './pico.js';
import { PicoCommand, PicoState } from './types.js';

// active BLE connections: maps picoId to noble Peripheral
const connectedPeripherals = new Map<string, any>();
const connectingPeripherals = new Set<string>();
const writableCharacteristics = new Map<string, any>();

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

// Noble state change handler
noble.on('stateChange', async (state) => {
  console.log(`[Bluetooth State] State changed to: ${state}`);
  if (state === 'poweredOn') {
    console.log('[Bluetooth Scanner] Starting scan for BLE devices...');
    try {
      // Start scanning. Set allowDuplicates to true so we can rediscover devices or scan continuously
      await noble.startScanningAsync([], true);
    } catch (err) {
      console.error('[Bluetooth Scanner] Error starting scan:', err);
    }
  } else {
    console.log('[Bluetooth Scanner] State is not poweredOn, stopping scan...');
    try {
      await noble.stopScanningAsync();
    } catch (err) {
      console.error('[Bluetooth Scanner] Error stopping scan:', err);
    }
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

  console.log(`[Bluetooth Discovery] Found Pico device [${localName}] with ID: [${picoId}]`);

  // Start connection attempt
  connectingPeripherals.add(picoId);
  try {
    console.log(`[Bluetooth Connection] Connecting to Pico [${picoId}]...`);
    await peripheral.connectAsync();
    console.log(`[Bluetooth Connection] Successfully connected to Pico [${picoId}]`);

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
      console.log(`[Bluetooth Connection] Pico [${picoId}] disconnected.`);
      pico.setConnected(false);
      connectedPeripherals.delete(picoId);
      writableCharacteristics.delete(picoId);
      connectingPeripherals.delete(picoId);

      // Auto-restart scanning to allow re-discovery
      noble.startScanningAsync([], true).catch(err => {
        console.error('[Bluetooth Scanner] Error restarting scan on disconnect:', err);
      });
    });

    // Discover services and characteristics
    console.log(`[Bluetooth Services] Discovering services and characteristics for Pico [${picoId}]...`);
    const { services, characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
    console.log(`[Bluetooth Services] Discovered ${characteristics.length} characteristics for Pico [${picoId}]`);

    let subscribedOrPolled = false;

    // BLE UART modules expose a writable characteristic for commands and a
    // notify characteristic for measurements. We intentionally select by
    // capability instead of a vendor UUID so the documented JSON protocol
    // works with common BLE UART modules.
    const writable = characteristics.find(characteristic =>
      characteristic.properties.includes('write') || characteristic.properties.includes('writeWithoutResponse')
    );
    if (writable) writableCharacteristics.set(picoId, writable);

    // 1. Subscribe to Notify/Indicate characteristics
    for (const characteristic of characteristics) {
      const props = characteristic.properties;
      if (props.includes('notify') || props.includes('indicate')) {
        console.log(`[Bluetooth Subscription] Subscribing to characteristic [${characteristic.uuid}] on Pico [${picoId}]`);

        characteristic.on('data', (dataBuffer: Buffer) => {
          const rawString = dataBuffer.toString('utf-8').trim();
          console.log(`[Bluetooth Data] Pico [${picoId}] Notify data (RAW): ${rawString}`);

          const updatedState = parsePicoState(dataBuffer, pico.state);
          if (updatedState) {
            pico.setState(updatedState);
            console.log(`[Bluetooth Data] Updated state for Pico [${picoId}]:`, pico.state);
          }
        });

        await characteristic.subscribeAsync();
        subscribedOrPolled = true;
      }
    }

    // 2. If no notification characteristics are available, fall back to polling readable characteristics
    if (!subscribedOrPolled) {
      const readableChars = characteristics.filter(c => c.properties.includes('read'));
      if (readableChars.length > 0) {
        console.log(`[Bluetooth Polling] No notify characteristics. Starting 5s polling on ${readableChars.length} readable characteristics for Pico [${picoId}]...`);

        const pollInterval = setInterval(async () => {
          // If device is disconnected, cancel polling
          if (!connectedPeripherals.has(picoId)) {
            clearInterval(pollInterval);
            return;
          }

          try {
            for (const char of readableChars) {
              const dataBuffer = await char.readAsync();
              const rawString = dataBuffer.toString('utf-8').trim();
              console.log(`[Bluetooth Data] Pico [${picoId}] Poll data (RAW): ${rawString}`);

              const updatedState = parsePicoState(dataBuffer, pico.state);
              if (updatedState) {
                pico.setState(updatedState);
                console.log(`[Bluetooth Data] Updated state (polled) for Pico [${picoId}]:`, pico.state);
              }
            }
          } catch (e: any) {
            console.error(`[Bluetooth Polling] Error polling Pico [${picoId}]:`, e.message || e);
          }
        }, 5000);

        subscribedOrPolled = true;
      }
    }

    if (!subscribedOrPolled) {
      console.warn(`[Bluetooth Warning] Pico [${picoId}] has no Notify, Indicate, or Read characteristics!`);
    }

  } catch (err) {
    console.error(`[Bluetooth Connection] Error during connection flow for Pico [${picoId}]:`, err);
    connectingPeripherals.delete(picoId);

    // Attempt to disconnect if partially connected
    try {
      await peripheral.disconnectAsync();
    } catch (_) { }
  }
});

/** Sends a newline-delimited JSON command to the Pico through its BLE UART characteristic. */
export async function sendPicoCommand(picoId: string, command: PicoCommand): Promise<void> {
  const characteristic = writableCharacteristics.get(picoId);
  if (!characteristic || !connectedPeripherals.has(picoId)) {
    throw new Error('Pico is not connected or does not expose a writable BLE characteristic');
  }
  const payload = Buffer.from(`${JSON.stringify(command)}\n`, 'utf8');
  const withoutResponse = characteristic.properties.includes('writeWithoutResponse');
  await characteristic.writeAsync(payload, withoutResponse);
}
