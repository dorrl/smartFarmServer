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
    // Timestamp of the last sensor message received over BLE. Connection changes
    // do not change this value, so clients can distinguish an old reading.
    receivedAt?: string;
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
    syncIntervalMinutes: number;
    retentionMonths: number;
};

export type Respond = {
    state: number;
    // Always the newest BLE value held by the server, never a history snapshot.
    source: 'latest-received';
    servedAt: string;
    pico: PicoType[];
};
