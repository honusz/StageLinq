import { strict as assert } from 'assert';
import { ReadContext, WriteContext } from '../utils';
import { Service } from './Service';
import type { ServiceMessage, DeviceId, DeviceIdString } from '../types';
import { EventEmitter } from 'events';
import { Socket } from 'net';


type BeatCallback = (n: ServiceMessage<BeatData>) => void;

type BeatOptions = {
	everyNBeats: number,
}

interface deckBeatData {
	beat: number;
	totalBeats: number;
	BPM: number;
	samples?: number;
}

export interface BeatData {
	clock: bigint;
	deckCount: number;
	deck: deckBeatData[];
}

export declare interface BeatInfo {
	on(event: 'beatMessage', listener: (message: ServiceMessage<BeatData>) => void): this;
	on(event: 'newDevice', listener: (deviceId: DeviceId, service: BeatInfo) => void): this;
}

export class BeatInfo extends Service<BeatData> {
	public readonly name = "BeatInfo";
	static #instances: Map<string, BeatInfo> = new Map()
	static readonly emitter: EventEmitter = new EventEmitter();

	#userBeatCallback: BeatCallback = null;
	#userBeatOptions: BeatOptions = null;
	#currentBeatData: Map<DeviceIdString, ServiceMessage<BeatData>> = new Map();
	protected isBufferedService: boolean = true;

	/**
	 * BeatInfo Service Class
	 * @constructor
	 * @param {DeviceId} [deviceId] 
	 */

	constructor(deviceId?: DeviceId) {
		super(deviceId)
		//this.addListener('connection', () => this.instanceListener('newDevice', this));
		//this.addListener('beatMessage', (data: BeatData) => this.instanceListener('beatMessage', data));
		this.addListener(`data`, (ctx: ReadContext, socket: Socket) => this.parseData(ctx, socket));
		this.addListener(`message`, (message: ServiceMessage<BeatData>) => this.messageHandler(message));
	}

	// protected instanceListener(eventName: string, ...args: any) {
	// 	BeatInfo.emitter.emit(eventName, ...args)
	// }

	// static getInstances(): string[] {
	// 	return [...BeatInfo.#instances.keys()]
	// }

	deleteDevice(deviceId: DeviceId) {
		BeatInfo.#instances.delete(deviceId.string)
	}
	/**
	 * Get current BeatData
	 * @returns {BeatData}
	 */
	getBeatData(deviceId: DeviceId): ServiceMessage<BeatData> {
		return this.#currentBeatData.get(deviceId.string);
	}

	/**
	 * Start BeatInfo
	 * @param {BeatOptions} options 
	 * @param {BeatCallback} [beatCB] Optional User callback
	 */
	public startBeatInfo(deviceId: DeviceId, options: BeatOptions, beatCB?: BeatCallback) {
		if (beatCB) {
			this.#userBeatCallback = beatCB;
		}


		this.#userBeatOptions = options;
		//for (const socket of this.getSockets()) {
		const socket = this.getSocket(deviceId);
		this.sendBeatInfoRequest(socket);
		//}

	}

	/**
	 * Send Subscribe to BeatInfo message to Device
	 * @param {Socket} socket 
	 */
	private async sendBeatInfoRequest(socket: Socket) {
		const ctx = new WriteContext();
		ctx.write(new Uint8Array([0x0, 0x0, 0x0, 0x4, 0x0, 0x0, 0x0, 0x0]))
		await this.write(ctx, socket);
	}

	private parseData(ctx: ReadContext, socket: Socket): ServiceMessage<BeatData> {
		assert(ctx.sizeLeft() > 72);
		let id = ctx.readUInt32()
		const clock = ctx.readUInt64();
		const deckCount = ctx.readUInt32();
		let deck: deckBeatData[] = [];
		for (let i = 0; i < deckCount; i++) {
			let deckData: deckBeatData = {
				beat: ctx.readFloat64(),
				totalBeats: ctx.readFloat64(),
				BPM: ctx.readFloat64(),
			}
			deck.push(deckData);
		}
		for (let i = 0; i < deckCount; i++) {
			deck[i].samples = ctx.readFloat64();
		}
		assert(ctx.isEOF())
		const message: ServiceMessage<BeatData> = {
			id: id,
			service: this,
			socket: socket,
			deviceId: this.getDeviceId(socket),
			message: {
				clock: clock,
				deckCount: deckCount,
				deck: deck,
			}
		}
		this.emit(`message`, message);
		return message
	}

	private messageHandler(data: ServiceMessage<BeatData>): void {

		function resCheck(res: number, prevBeat: number, currentBeat: number): boolean {
			if (res === 0) {
				return true
			}
			return (Math.floor(currentBeat / res) - Math.floor(prevBeat / res) >= 1)
				|| (Math.floor(prevBeat / res) - Math.floor(currentBeat / res) >= 1)
		}

		if (!data || !data.message) {
			return
		}

		if (!this.#currentBeatData.has(data.deviceId.string)) {
			this.#currentBeatData.set(data.deviceId.string, data);
			if (this.listenerCount('beatMessage')) {
				this.emit('beatMessage', data);
			}
			if (this.#userBeatCallback) {
				this.#userBeatCallback(data);
			}

		}

		let hasUpdated = false;
		const currentBeatData = this.#currentBeatData.get(data.deviceId.string)
		for (let i = 0; i < data.message.deckCount; i++) {

			if (resCheck(
				this.#userBeatOptions.everyNBeats,
				currentBeatData.message.deck[i].beat,
				data.message.deck[i].beat)) {
				hasUpdated = true;
			}
		}

		if (hasUpdated) {
			if (this.listenerCount('beatMessage')) {
				this.emit('beatMessage', data);
			}
			if (this.#userBeatCallback) {
				this.#userBeatCallback(data);
			}
		}
		this.#currentBeatData.set(data.deviceId.string, data);
	}
}