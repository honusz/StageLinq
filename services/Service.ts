import { EventEmitter } from 'events';
import { strict as assert } from 'assert';
import { Logger } from '../LogEmitter';
import { ServiceMessage, DeviceId, IpAddressPort, DeviceIdString, IpAddress } from '../types';
import { Device } from '../devices';
import { ReadContext, WriteContext } from '../utils';
import { Server, Socket, AddressInfo, createServer as CreateServer } from 'net';
import { StageLinq } from '../StageLinq';

const MESSAGE_TIMEOUT = 3000; // in ms


export abstract class Service<T> extends EventEmitter {
	public readonly name: string = "Service";
	public readonly device: Device;
	protected sockets: Map<DeviceIdString, Socket> = new Map();
	protected deviceIds: Map<IpAddressPort, DeviceId> = new Map();
	protected isBufferedService: boolean = true;
	protected timeout: NodeJS.Timer;
	private server: Server = null;
	private socketBuffers: Map<IpAddressPort, Buffer> = new Map()

	/**
	 * Service Abstract Class
	 * @param {DeviceId} [deviceId]
	 */
	constructor(deviceId?: DeviceId) {
		super();
		this.device = (deviceId ? StageLinq.devices.device(deviceId) : null);
	}

	get serverInfo(): AddressInfo {
		return this.server.address() as AddressInfo
	}

	protected getSockets(): Socket[] {
		return [...this.sockets.values()]
	}

	getDeviceId(socket: Socket) {
		return this.deviceIds.get(this.addressPort(socket))
	}

	protected getSocket(deviceId: DeviceId) {
		return this.sockets.get(deviceId.string)
	}
	/**
	 * Creates a new Server for Service
	 * @returns {Server}
	 */
	private async startServer(): Promise<Server> {
		return await new Promise((resolve, reject) => {

			const server = CreateServer((socket) => {
				Logger.debug(`[${this.name}] connection from ${socket.remoteAddress}:${socket.remotePort}`)
				this.socketBuffers.set(this.addressPort(socket), null)

				socket.on('error', (err) => reject(err));
				socket.on('data', async (data) => await this.dataHandler(data, socket));

			}).listen(0, '0.0.0.0', () => {
				this.server = server;
				Logger.silly(`opened ${this.name} server on ${this.serverInfo.port}`);
				resolve(server);
			});
		});
	}

	/**
	 * Start Service Listener
	 * @returns {Promise<AddressInfo>}
	 */
	async start(): Promise<AddressInfo> {
		const server = await this.startServer();
		return server.address() as AddressInfo;
	}

	/**
	 * Close Server
	 */
	async stop() {
		assert(this.server);
		try {
			this.server.close();
		} catch (e) {
			Logger.error('Error closing server', e);
		}
	}

	private subMessageTest(ctx: ReadContext): boolean {
		try {
			if (ctx.sizeLeft() < 22) return
			const msg = ctx.readUInt32();
			if (msg !== 0) return
			ctx.read(16);
			if (ctx.sizeLeft() < 4) return
			const length = ctx.readUInt32();
			if (length > ctx.sizeLeft()) return
			ctx.seek(-4)
			const service = ctx.readNetworkStringUTF16();
			const services: string[] = [...StageLinq.options.services]
			if (!services.includes(service)) return
			if (this.name !== service) return
			return true
		} catch (err) {
			Logger.error(this.name, err)
		}
	}

	protected addressPort(socket: Socket): IpAddressPort {
		const ip = socket.remoteAddress as IpAddress
		const port = socket.remotePort.toString()
		return `${ip}:${port}`
	}

	private concantenateBuffer(socket: Socket, data: Buffer): ReadContext {
		let buffer: Buffer = null;
		const messageBuffer = this.socketBuffers.get(this.addressPort(socket));

		if (messageBuffer && messageBuffer.length > 0) {
			buffer = Buffer.concat([messageBuffer, data]);
		} else {
			buffer = data;
		}
		this.socketBuffers.set(this.addressPort(socket), null)
		const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
		const ctx = new ReadContext(arrayBuffer, false)

		return ctx
	}

	/**
	 * Handle incoming Data from Server Socket
	 * @param {Buffer} data
	 * @param {Socket} socket
	 */
	private async dataHandler(data: Buffer, socket: Socket) {

		const ctx = this.concantenateBuffer(socket, data);

		if (!this.isBufferedService) {
			this.emit(`data`, new ReadContext(ctx.readRemainingAsNewArrayBuffer(), false), socket)
			return
		};

		if (this.subMessageTest(ctx.copy())) {
			try {
				ctx.read(4)
				const deviceId = new DeviceId(ctx.read(16));
				this.deviceIds.set(this.addressPort(socket), deviceId);

				const serviceName = ctx.readNetworkStringUTF16();
				const port = ctx.readUInt16();
				Logger.silent(deviceId.string, serviceName, this.name, port, socket.remotePort)
				this.sockets.set(deviceId.string, socket)
				this.emit('newDevice', deviceId, this);
				if (ctx.sizeLeft()) this.socketBuffers.set(this.addressPort(socket), ctx.readRemainingAsNewBuffer());
			} catch (err) {
				Logger.error(this.name, socket.remoteAddress, err)
			}
		}

		try {
			while (ctx.isEOF() === false) {
				if (ctx.sizeLeft() < 4) {
					this.socketBuffers.set(this.addressPort(socket), ctx.readRemainingAsNewBuffer());
					break;
				}

				const length = ctx.readUInt32();
				if (length <= ctx.sizeLeft()) {
					const message = ctx.read(length);
					const data = message.buffer.slice(message.byteOffset, message.byteOffset + length);
					this.emit(`data`, new ReadContext(data, false), socket)
				} else {
					ctx.seek(-4); // Rewind 4 bytes to include the length again
					this.socketBuffers.set(this.addressPort(socket), ctx.readRemainingAsNewBuffer());
					break;
				}
			}
		} catch (err) {
			Logger.error(this.name, err);
		}
	}

	/**
	 * Wait for a message from the wire
	 * @param {string} eventMessage
	 * @param {number} messageId
	 * @returns {Promise<T>}
	 */
	protected async waitForMessage(eventMessage: string, messageId: number): Promise<T> {
		return await new Promise((resolve, reject) => {
			const listener = (message: ServiceMessage<T>) => {
				if (message.id === messageId) {
					this.removeListener(eventMessage, listener);
					resolve(message.message);
				}
			};
			this.addListener(eventMessage, listener);
			setTimeout(() => {
				reject(new Error(`Failed to receive message '${messageId}' on time`));
			}, MESSAGE_TIMEOUT);
		});
	}

	/**
	 * Write a Context message to the socket
	 * @param {WriteContext} ctx
	 * @returns {Promise<boolean>} true if data written
	 */
	protected async write(ctx: WriteContext, socket: Socket): Promise<boolean> {
		assert(ctx.isLittleEndian() === false);
		const buf = ctx.getBuffer();
		const written = await socket.write(buf);
		return await written;
	}

	/**
	 * Write a length-prefixed Context message to the socket
	 * @param {WriteContext} ctx
	 * @returns {Promise<boolean>} true if data written
	 */
	protected async writeWithLength(ctx: WriteContext, socket: Socket): Promise<boolean> {
		assert(ctx.isLittleEndian() === false);
		const newCtx = new WriteContext({ size: ctx.tell() + 4, autoGrow: false });
		newCtx.writeUInt32(ctx.tell());
		newCtx.write(ctx.getBuffer());
		assert(newCtx.isEOF());
		return await this.write(newCtx, socket);
	}


	protected abstract instanceListener(eventName: string, ...args: any): void
}
