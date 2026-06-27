export type Pico = {
    name: string,
    id: string,
    connected: boolean,
    state: {
        temperature: number,
        moisture: number,
        light: number
    }
}

export type Respond = {
    state: number,
    pico: Pico[]
}