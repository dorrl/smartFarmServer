export type PicoType = {
    name: string,
    id: string,
    connected: boolean,
    state: PicoState
}

export type PicoState = {
    temperature: number,
    moisture: number,
    light: number
}

export type Respond = {
    state: number,
    pico: PicoType[]
}