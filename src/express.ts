import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { PicoType, Respond } from './types.js';
import { picoList, Pico } from './pico.js';

const DEFAULT_PORT = 3000;
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || DEFAULT_PORT;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = WebApp();
function WebApp() {
    const server = express();
    // Enable JSON body parser middleware
    server.use(express.json());
    return server;
}

app.get('/', (req, res) => {
    res.json({
        state: 200
    });
});

app.get('/state', (req, res) => {
    const picoArray: PicoType[] = Object.values(picoList).map(pico => pico.export());
    const respond: Respond = {
        state: 200,
        pico: picoArray
    };
    res.json(respond);
});

app.post('/setPico', (req, res) => {
    const body: PicoType = req.body;
    if (!body || !body.id) {
        res.status(400).json({ error: 'Pico ID is required' });
        return;
    }

    const cleanId = body.id.toLowerCase().replace(/[^a-z0-9]/g, '');
    let pico = picoList[cleanId];
    if (pico) {
        // Import existing properties
        pico.name = body.name || pico.name;
        if (body.connected !== undefined) {
            pico.connected = body.connected;
        }
        if (body.state) {
            pico.setState(body.state);
        }
    } else {
        // Create new Pico instance
        pico = new Pico({
            id: cleanId,
            name: body.name || `Pico-${cleanId}`,
            connected: body.connected !== undefined ? body.connected : false,
            state: body.state || { temperature: 0, moisture: 0, light: 0 }
        });
        picoList[cleanId] = pico;
    }

    res.json({
        state: 200,
        pico: pico.export()
    });
});

// Create HTTP server
http.createServer(app).listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP Server is running locally on port ${PORT}`);
    console.log(`Local Access: http://localhost:${PORT}`);
});