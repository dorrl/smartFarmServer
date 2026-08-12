export type PicoState = {
    temperature: number;
    moisture: number;
    light: number;
};

export type PicoType = {
    name: string;
    id: string;
    connected: boolean;
    state: PicoState;
    watering?: boolean;
    updatedAt?: string;
};

export type Reading = PicoState & {
    picoId: string;
    recordedAt: string;
};

export type AlertLevel = 'warning' | 'error' | 'info';

export type Alert = {
    id: string;
    picoId: string;
    message: string;
    level: AlertLevel;
    createdAt: string;
    resolved: boolean;
};

export type PicoCommand =
    | { command: 'water'; enabled: boolean; durationSeconds?: number }
    | { command: 'ping' };

export type Respond = {
    state: number;
    pico: PicoType[];
};
