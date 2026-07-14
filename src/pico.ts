import { PicoState, PicoType } from "./types";

export class Pico {
    name: string
    id: string
    connected: boolean
    state: {
        temperature: number
        moisture: number
        light: number
    }

    constructor (pico: PicoType) {
        this.name = pico.name
        this.id = pico.id
        this.connected = pico.connected
        this.state = pico.state
    }

    import(pico: PicoType) {
        this.name = pico.name
        this.id = pico.id
        this.connected = pico.connected
        this.state = pico.state
    }

    export(): PicoType {
        return ({
            name: this.name,
            id: this.id,
            connected: this.connected,
            state: this.state
        })
    }

    setState(state: PicoState) {
        this.state = state
    }
}

const picoList: {[id: string]: Pico} = {}