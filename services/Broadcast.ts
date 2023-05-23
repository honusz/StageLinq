import { EventEmitter } from 'events';
import { ReadContext } from '../utils';
import { ServiceMessage, DeviceId } from '../types';
import { Service } from './Service';
import { Logger } from '../LogEmitter';
import { Socket } from 'net';

export type BroadcastMessage = {
	databaseUuid: string;
	trackId?: number | string;
	listId?: number | string;
	sessionId?: number | string;
};

export interface BroadcastData {
	[key: string]: any;
}

export class Broadcast extends Service<BroadcastData> {
	public readonly name = 'Broadcast';
	protected readonly isBufferedService: boolean = false;
	static readonly emitter: EventEmitter = new EventEmitter();

	/**
	 * Broadcast Service Class
	 * @tag Experimental
	 * @param {DeviceId} deviceId
	 */
	constructor() {
		super();
		this.addListener(`data`, (ctx: ReadContext, socket: Socket) => this.parseData(ctx, socket));
		this.addListener(`message`, (message: ServiceMessage<BroadcastData>) => this.messageHandler(message));
	}

	private parseData(ctx: ReadContext, socket: Socket): ServiceMessage<BroadcastData> {
		const length = ctx.readUInt32();

		if (!length && ctx.sizeLeft()) {
			const deviceId = new DeviceId(ctx.read(16))

			const message = {
				id: length,
				deviceId: deviceId,
				service: this,
				socket: socket,
				message: {
					name: ctx.readNetworkStringUTF16(),
					port: ctx.readUInt16(),
					sizeLeft: ctx.sizeLeft(),
				},
			};
			this.emit(`message`, message);
			return message;
		} else {
			const deviceId = this.getDeviceId(socket);
			const message = {
				id: length,
				deviceId: deviceId,
				service: this,
				socket: socket,
				message: {
					json: ctx.getString(length),
					sizeLeft: ctx.sizeLeft(),
				},
			};
			this.emit(`message`, message);
			return message;
		}
	}

	private messageHandler(data: ServiceMessage<BroadcastData>): void {
		if (data?.id === 0) {
			Logger.info(`Broadcast Connection`, data.message)
			this.sockets.set(data.deviceId.string, data.socket)
			this.deviceIds.set(this.addressPort(data.socket), data.deviceId)
			this.emit('connection', this.device, this);
		}

		if (data?.message?.json) {
			const msg = JSON.parse(data.message.json.replace(/\./g, ''));
			const key = Object.keys(msg).shift();
			const value = Object.values(msg).shift() as BroadcastMessage;
			this.emit('broadcast', data.deviceId, key, value);
			if (this.listenerCount(value.databaseUuid)) {
				this.emit(value.databaseUuid, key, value);
			}
		}
	}

	protected instanceListener(eventName: string, ...args: any) {
		Broadcast.emitter.emit(eventName, ...args);
	}
}
