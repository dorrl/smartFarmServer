import { PicoState, PicoType } from "./types.js";

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

    static create(pico: PicoType) {
        picoList[pico.id] = new Pico(pico)
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

export const picoList: {[id: string]: Pico} = {}

Pico.create({
    id: 'aaaa',
    name: 'aaa',
    connected: true,
    state: {
        temperature: 10,
        moisture: 10,
        light: 1
    }
})