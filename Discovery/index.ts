import { EventEmitter } from 'events';
import { Logger } from '../LogEmitter';
import { strict as assert } from 'assert';
import { ConnectionInfo, DiscoveryMessage, DiscoveryMessageOptions, IpAddress, Units, DeviceId, DeviceIdString } from '../types';
import { sleep, WriteContext, ReadContext } from '../utils';
import { Socket, RemoteInfo, createSocket } from 'dgram';
import { subnet } from 'ip';
import { networkInterfaces } from 'os';
import { createHash } from 'crypto';

const ANNOUNCEMENT_INTERVAL = 1000;
const LISTEN_PORT = 51337;
const DISCOVERY_MESSAGE_MARKER = 'airD';

enum Action {
	Login = 'DISCOVERER_HOWDY_',
	Logout = 'DISCOVERER_EXIT_',
}

type DeviceDiscoveryCallback = (info: ConnectionInfo) => void;

export declare interface Discovery {
	on(event: 'newDiscoveryDevice', listener: (info: DiscoveryMessage) => void): this;
	on(event: 'updatedDiscoveryDevice', listener: (info: DiscoveryMessage) => void): this;
	on(event: 'announcing', listener: (info: DiscoveryMessage) => void): this;
	on(event: 'listening', listener: () => void): this;
}

export class Discovery extends EventEmitter {
	private socket: Socket;
	private address: IpAddress;
	private broadcastAddresses: IpAddress[];
	private options: DiscoveryMessageOptions = null;
	private peers: Map<DeviceIdString, ConnectionInfo> = new Map();
	private deviceId: DeviceId = null;
	private announceTimer: NodeJS.Timer;
	private infoHashes: Set<string> = new Set();

	/**
	 * Get list of devices
	 * @returns {string[]} An array of DeviceId strings
	 */
	public getDeviceList(): string[] {
		return [...this.peers.keys()];
	}

	/**
	 * Get array of device ConnectionInfos
	 * @returns {ConnectionInfo[]} An array of ConnectionInfos
	 */
	public getDevices(): ConnectionInfo[] {
		return [...this.peers.values()];
	}

	/**
	 * Start Discovery Listener
	 * @param {DiscoveryMessageOptions} options
	 */
	listen(options: DiscoveryMessageOptions) {
		this.options = options;
		this.deviceId = options.deviceId;

		this.emit('listening');

		this.listenForDevices((connectionInfo: ConnectionInfo) => this.emit('discoveryDevice', connectionInfo));
	}

	/**
	 * Announce library to network
	 * @param {number} port Port for Directory Service
	 */
	async announce(port: number) {
		assert(this.socket);
		this.socket.setBroadcast(true);
		const discoveryMessage = this.createDiscoveryMessage(Action.Login, this.options, port);
		await sleep(500);
		this.broadcastAddresses = this.findBroadcastIPs();
		const msg = this.writeDiscoveryMessage(discoveryMessage);
		const hash = await this.hashMessage(msg)
		this.infoHashes.add(hash)
		this.broadcastMessage(this.socket, msg, LISTEN_PORT, this.broadcastAddresses)
		this.emit('announcing', discoveryMessage);
		Logger.debug(`Broadcast Discovery Message ${this.deviceId.string} ${discoveryMessage.source}`);
		this.announceTimer = setInterval(
			this.broadcastMessage,
			ANNOUNCEMENT_INTERVAL,
			this.socket,
			msg,
			LISTEN_PORT,
			this.broadcastAddresses
		);
	}

	/**
	 * Unanounce Library to network
	 */
	async unannounce(): Promise<void> {
		assert(this.announceTimer);
		clearInterval(this.announceTimer);
		this.announceTimer = null;
		const discoveryMessage = this.createDiscoveryMessage(Action.Logout, this.options);
		const msg = this.writeDiscoveryMessage(discoveryMessage);

		await this.broadcastMessage(this.socket, msg, LISTEN_PORT, this.broadcastAddresses);
		await this.socket.close();

		Logger.debug('Broadcast Unannounce Message');
	}

	//////////// PRIVATE METHODS ///////////////

	/**
	 * Broadcast Discovery Message
	 * @param {Socket} socket
	 * @param {Buffer} msg
	 * @param {number} port
	 * @param {IpAddress} address
	 */
	private async broadcastMessage(socket: Socket, msg: Buffer, port: number, address: IpAddress[]): Promise<void> {
		for (const ip of address) {
			await socket.send(msg, port, ip);
		}
	}

	private async hashMessage(message: Uint8Array): Promise<string> {
		return createHash('sha256').update(message).digest('base64')
	}


	/**
	 * Listen for new devices on the network and callback when a new one is found.
	 * @param {DeviceDiscoveryCallback} callback Callback when new device is discovered.
	 */

	private async listenForDevices(callback: DeviceDiscoveryCallback) {
		this.socket = createSocket('udp4');
		this.socket.on('message', async (announcement: Uint8Array, remote: RemoteInfo) => {

			const hash = await this.hashMessage(announcement);
			if (!this.infoHashes.has(hash)) {
				this.infoHashes.add(hash)
				const ctx = new ReadContext(announcement.buffer, false);
				const result = this.readConnectionInfo(ctx, remote.address as IpAddress);
				if (!this.address) {
					this.address = remote.address as IpAddress;
				}
				assert(ctx.tell() === remote.size);
				callback(result);
			}
		});
		this.socket.bind({
			port: LISTEN_PORT,
			exclusive: false,
		});
	}

	/**
	 * Read Connection Info from Context
	 * @param {ReadContext} ctx
	 * @param {IpAddress} address
	 * @returns {ConnectionInfo}
	 */
	private readConnectionInfo(ctx: ReadContext, address: IpAddress): ConnectionInfo {
		const magic = ctx.getString(4);
		if (magic !== DISCOVERY_MESSAGE_MARKER) {
			return null;
		}

		const connectionInfo: ConnectionInfo = {
			deviceId: new DeviceId(ctx.read(16)),
			source: ctx.readNetworkStringUTF16(),
			action: ctx.readNetworkStringUTF16(),
			software: {
				name: ctx.readNetworkStringUTF16(),
				version: ctx.readNetworkStringUTF16(),
			},
			port: ctx.readUInt16(),
			address: address,
		};

		if (Units[connectionInfo.software.name]) {
			connectionInfo.unit = Units[connectionInfo.software.name];
		}

		assert(ctx.isEOF());
		return connectionInfo;
	}

	/**
	 * Create a Discovery Message
	 * @param {string} action
	 * @param {DiscoveryMessageOptions} discoveryMessageOptions
	 * @param {number} port
	 * @returns {DiscoveryMessage}
	 */
	private createDiscoveryMessage(
		action: string,
		discoveryMessageOptions: DiscoveryMessageOptions,
		port?: number
	): DiscoveryMessage {
		const msg: DiscoveryMessage = {
			action: action,
			port: port || 0,
			deviceId: discoveryMessageOptions.deviceId,
			software: {
				name: discoveryMessageOptions.name,
				version: discoveryMessageOptions.version,
			},
			source: discoveryMessageOptions.source,
		};
		return msg;
	}

	/**
	 *Discovery Message Writer
	 * @param {DiscoveryMessage} message
	 * @returns {Buffer}
	 */
	private writeDiscoveryMessage(message: DiscoveryMessage): Buffer {
		const ctx = new WriteContext();
		ctx.writeFixedSizedString(DISCOVERY_MESSAGE_MARKER);
		ctx.write(message.deviceId.array);
		ctx.writeNetworkStringUTF16(message.source);
		ctx.writeNetworkStringUTF16(message.action);
		ctx.writeNetworkStringUTF16(message.software.name);
		ctx.writeNetworkStringUTF16(message.software.version);
		ctx.writeUInt16(message.port);
		return ctx.getBuffer();
	}

	/**
	 * Get list of Broadcast-enabled Network Interfaces
	 * @returns {SubnetInfo[]} Array of Broadcast IPs
	 */
	private findBroadcastIPs(): IpAddress[] {
		const interfaces = Object.values(networkInterfaces());
		assert(interfaces.length);
		const ips: IpAddress[] = [];
		for (const i of interfaces) {
			assert(i && i.length);
			for (const entry of i) {
				if (entry.family === 'IPv4' && entry.internal === false) {
					const info = subnet(entry.address, entry.netmask);
					ips.push(info.broadcastAddress as IpAddress);
				}
			}
		}
		return ips;
	}
}
