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

export type ServerSettings = {
    measurementIntervalMinutes: number;
    retentionMonths: number;
};

export type PicoCommand = { command: 'setMeasurementInterval'; minutes: number } | { command: 'measureNow' };

export type Respond = { state: number; pico: PicoType[]; };
