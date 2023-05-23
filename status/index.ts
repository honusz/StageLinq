import { EventEmitter } from 'events';
import { StageLinq } from '../StageLinq';
import { StateData, StateMap } from '../services';
import { Track, DeviceId, ServiceMessage, DeviceIdString, StateValue, color } from '../types';
import { sleep } from '../utils';

type value = string | boolean | number | color
// type dir = {
// 	[key: string]: value
// }
interface StateObj {
	[key: DeviceIdString]: {
		[key: string]: value;
	}

}

export class Status extends EventEmitter {
	private tracks: Map<DeviceIdString, Track> = new Map();
	state: StateObj = {};
	/**
	 * Status EndPoint Class
	 */

	// addStateListener() {
	// 	StageLinq.stateMap.addListener('stateMessage', (data: ServiceMessage<StateData>) => this.stateListener(data))
	// }

	stateListener(data: ServiceMessage<StateData>) {
		function valueFromStateMessage(stateValue: StateValue): value {

			const keys = Object.keys(stateValue)

			if (keys.includes('color')) return stateValue.color as color
			if (keys.includes('string')) return stateValue.string as string
			if (keys.includes('value')) return stateValue.value as number
			if (keys.includes('state')) return stateValue.state as boolean

		}

		if (data?.message?.json) {
			if (!this.state[data.deviceId.string]) {
				this.state[data.deviceId.string] = {}
			}
			this.state[data.deviceId.string][data.message.name] = valueFromStateMessage(data.message.json)
			//console.log(this.state[data.deviceId.string])
		}
		//console.dir(this.state)
	}
	/**
	 * Get Track Info from Status
	 * @param {DeviceId} deviceId DeviceId of the player
	 * @param {deck} deck Deck (layer) number
	 * @returns {TrackData}
	 */

	getTrack(deviceId: DeviceId, deck: number): Track {
		return this.tracks.get(`{${deviceId.string}},${deck}`);
	}

	/**
	 * Add a Deck for Status to monitor
	 * @param {StateMap} service // Instance of StateMap Service
	 * @param {number} deck Deck (layer) number
	 */
	async addDeck(deviceId: DeviceId, service: StateMap, deck: number) {
		let track = new Track(`${deviceId.string}/Engine/Deck${deck}/Track/`)
		this.tracks.set(`{${deviceId.string}},${deck}`, track)
		for (let item of Object.keys(track)) {
			service.addListener(`${track.prefix}${item}`, data => this.trackListener(data, this))
		}
	}

	async addDecks(deviceId: DeviceId, service: StateMap) {
		while (!StageLinq.devices.hasDevice(deviceId)) {
			await sleep(250)
		}

		for (let i = 1; i <= StageLinq.devices.device(deviceId).deckCount(); i++) {
			this.addDeck(deviceId, service, i);
		}
	}

	private trackListener(data: ServiceMessage<StateData>, status: Status) {
		const { ...message } = data.message
		const deck = parseInt(message.name.substring(12, 13))
		const property = message.name.split('/').pop()
		const value = this.getTypedValue(message);
		const track = status.tracks.get(`{${data.deviceId.string}},${deck}`)
		this.tracks.set(`{${data.deviceId.string}},${deck}`, Object.assign(track, { [property]: value }));
	}

	private getTypedValue(data: StateData): boolean | string | number {
		if (data.json.state) {
			return data.json.state as boolean
		}
		if (data.json.string) {
			return data.json.string as string
		}
		if (data.json.value) {
			return data.json.value as number
		}
	}
}