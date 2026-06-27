import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Respond } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const DEFAULT_PORT = 3000;
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || DEFAULT_PORT;

app.get('/', (req, res) => {
  const respond: Respond = {
    state: 200,
    pico: [{
      name: 'pico1',
      id: 'aaaa',
      connected: true,
      state: {
        temperature: 20,
        moisture: 30,
        light: 6
      }
    }]
  }
  res.json(respond);
});

// HTTPS 대신 HTTP 서버를 생성합니다.
http.createServer(app).listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP Server is running locally on port ${PORT}`);
  console.log(`Local Access: http://localhost:${PORT}`);
});
