import express from 'express';
import http from 'node:http';
import { Pico, getAlerts, getReadings, loadPersistedData, picoList, saveState } from './pico.js';
import { PicoCommand, PicoState, PicoType, Respond } from './types.js';
import { sendPicoCommand } from './bluetooth.js';

const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 3000;
const API_KEY = process.env.SMARTFARM_API_KEY;

loadPersistedData();

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
    // Native clients do not need CORS, but this allows the Expo web build to read monitoring data.
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!API_KEY) return res.status(503).json({ error: 'SMARTFARM_API_KEY is not configured' });
    if (req.get('X-API-Key') !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
    next();
}

function cleanId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const id = value.toLowerCase().replace(/[^a-z0-9]/g, '');
    return id.length > 0 && id.length <= 64 ? id : null;
}

function isPicoState(value: unknown): value is PicoState {
    if (!value || typeof value !== 'object') return false;
    const state = value as PicoState;
    return [state.temperature, state.moisture, state.light].every(item => typeof item === 'number' && Number.isFinite(item));
}

app.get('/', (_req, res) => res.json({ state: 200, service: 'smartfarm-server' }));

app.get('/state', (_req, res) => {
    const pico: PicoType[] = Object.values(picoList).map(device => device.export());
    const response: Respond = { state: 200, pico };
    res.json(response);
});

app.get('/picos/:id/readings', (req, res) => {
    const id = cleanId(req.params.id);
    if (!id || !picoList[id]) return res.status(404).json({ error: 'Pico not found' });
    const requestedLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 720)) : 100;
    res.json({ state: 200, readings: getReadings(id, limit) });
});

app.get('/notifications', (_req, res) => res.json({ state: 200, notifications: getAlerts() }));

// Reserved for a trusted gateway or maintenance tool. Sensor data arriving over BLE
// updates state directly and never needs this HTTP endpoint.
app.post('/setPico', requireApiKey, (req, res) => {
    const body = req.body as Partial<PicoType>;
    const id = cleanId(body?.id);
    if (!id) return res.status(400).json({ error: 'A valid Pico ID is required' });
    if (body.state !== undefined && !isPicoState(body.state)) return res.status(400).json({ error: 'Invalid sensor state' });

    try {
        let pico = picoList[id];
        if (!pico) {
            if (!body.state) return res.status(400).json({ error: 'State is required when creating a Pico' });
            pico = new Pico({ id, name: typeof body.name === 'string' ? body.name.slice(0, 80) : `Pico-${id}`, connected: Boolean(body.connected), state: body.state });
            picoList[id] = pico;
        } else {
            if (typeof body.name === 'string') pico.name = body.name.slice(0, 80);
            if (typeof body.connected === 'boolean') pico.setConnected(body.connected);
            if (body.state) pico.setState(body.state);
        }
        saveState();
        res.json({ state: 200, pico: pico.export() });
    } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request' });
    }
});

app.post('/picos/:id/commands', requireApiKey, async (req, res) => {
    const id = cleanId(req.params.id);
    if (!id || !picoList[id]) return res.status(404).json({ error: 'Pico not found' });
    const command = req.body as PicoCommand;
    if (!command || (command.command !== 'water' && command.command !== 'ping')) return res.status(400).json({ error: 'Unsupported command' });
    if (command.command === 'water' && (typeof command.enabled !== 'boolean' || (command.durationSeconds !== undefined && (!Number.isInteger(command.durationSeconds) || command.durationSeconds < 1 || command.durationSeconds > 600)))) {
        return res.status(400).json({ error: 'Invalid watering command' });
    }

    try {
        await sendPicoCommand(id, command);
        if (command.command === 'water') picoList[id].setWatering(command.enabled);
        res.json({ state: 200, pico: picoList[id].export() });
    } catch (error) {
        res.status(503).json({ error: error instanceof Error ? error.message : 'Command delivery failed' });
    }
});

http.createServer(app).listen(PORT, '0.0.0.0', () => {
    if (!API_KEY) console.warn('[Security] Write endpoints are disabled until SMARTFARM_API_KEY is configured.');
    console.log(`SmartFarm HTTP server is listening on port ${PORT}`);
});
