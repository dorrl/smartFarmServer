import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { PicoType, Respond } from './types.js';
import { picoList } from './pico.js';

const DEFAULT_PORT = 3000;
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || DEFAULT_PORT;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.get('/', (req, res) => {
    const picoArray: PicoType[] = Object.values(picoList).map(pico => pico.export())
    const respond: Respond = {
        state: 200,
        pico: picoArray
    }
    res.json(respond);
});

app.post('/state', (req, res) => {
    const body: PicoType = req.body
})

// HTTPS 대신 HTTP 서버를 생성합니다.
http.createServer(app).listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP Server is running locally on port ${PORT}`);
    console.log(`Local Access: http://localhost:${PORT}`);
});