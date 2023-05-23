import { Discovery } from '../Discovery';
import { Logger } from '../LogEmitter';
import { ActingAsDevice, StageLinqOptions, DeviceId, Services } from '../types';
import { sleep } from '../utils';
import { Devices } from '../devices'
import { Sources } from '../Sources';
import { Service, Directory, FileTransfer, StateMap, BeatInfo, Broadcast, TimeSynchronization } from '../services';
import { Status } from '../status';


const DEFAULT_OPTIONS: StageLinqOptions = {
	actingAs: ActingAsDevice.StageLinqJS,
};

/**
 * Main StageLinq static class.
 */
export class StageLinq {
	private static _options: StageLinqOptions = DEFAULT_OPTIONS;
	readonly logger: Logger = Logger.instance;
	private static _discovery: Discovery = null;
	private static _devices: Devices = null;
	private static _sources: Sources = null;
	private static _status: Status = null;
	private static _directory: Directory = null;
	private static _fileTransfer: FileTransfer = null;
	private static _stateMap: StateMap = null;
	private static _beatInfo: BeatInfo = null;
	private static _broadcast: Broadcast = null;
	private static _timeSync: TimeSynchronization = null;


	static services: Map<string, InstanceType<typeof Service>> = new Map();

	private static _servicePorts: Map<string, number> = new Map();


	constructor(options?: StageLinqOptions,) {
		StageLinq._options = options || DEFAULT_OPTIONS;
		StageLinq._discovery = new Discovery();
		StageLinq._devices = new Devices();
		StageLinq._sources = new Sources();
		StageLinq._status = new Status();
		if (StageLinq.options.services.includes(Services.StateMap)) StageLinq.startServiceListener(StateMap).then(service => StageLinq._stateMap = service);
		if (StageLinq.options.services.includes(Services.FileTransfer)) StageLinq.startServiceListener(FileTransfer).then(service => StageLinq._fileTransfer = service);
		if (StageLinq.options.services.includes(Services.BeatInfo)) StageLinq.startServiceListener(BeatInfo).then(service => StageLinq._beatInfo = service);
		if (StageLinq.options.services.includes(Services.Broadcast)) StageLinq.startServiceListener(Broadcast).then(service => StageLinq._broadcast = service);

	}

	static get options() {
		return this._options
	}
	get options() {
		return StageLinq._options
	}

	static get discovery() {
		return this._discovery
	}
	get discovery() {
		return StageLinq._discovery
	}

	static get devices() {
		return this._devices
	}
	get devices() {
		return StageLinq._devices
	}

	static get sources() {
		return this._sources
	}
	get sources() {
		return StageLinq._sources
	}

	static get status() {
		return this._status
	}
	get status() {
		return StageLinq._status
	}

	static get directory() {
		return this._directory
	}
	get directory() {
		return StageLinq._directory
	}

	private static set directory(service: Directory) {
		StageLinq._directory = service;
	}

	static get fileTransfer(): FileTransfer {
		return this._fileTransfer
	}
	get fileTransfer(): FileTransfer {
		return StageLinq._fileTransfer
	}

	static get stateMap(): StateMap {
		return this._stateMap
	}
	get stateMap(): StateMap {
		return StageLinq._stateMap
	}

	static get beatInfo(): BeatInfo {
		return this._beatInfo
	}
	get beatInfo(): BeatInfo {
		return StageLinq._beatInfo
	}

	static get broadcast(): Broadcast {
		return this._broadcast
	}
	get broadcast(): Broadcast {
		return StageLinq._broadcast
	}

	static get timeSync(): TimeSynchronization {
		return this._timeSync
	}
	get timeSync(): TimeSynchronization {
		return StageLinq._timeSync
	}

	static get servicePorts(): [string, number][] {
		return [...this._servicePorts.entries()]
	}

	static getService<T>(serviceName: string): Service<T> {
		return StageLinq.services.get(serviceName) as Service<T>
	}

	/**
	 * Service Constructor Factory Function
	 * @param {Service<T>} Service
	 * @param {DeviceId} [deviceId]
	 * @returns {Promise<Service<T>>}
	 */
	private static async startServiceListener<T extends InstanceType<typeof Service>>(ctor: {
		new(_deviceId?: DeviceId): T;
	}, deviceId?: DeviceId): Promise<T> {
		const service = new ctor(deviceId);

		await service.start();
		StageLinq._servicePorts.set(ctor.name, service.serverInfo.port)
		StageLinq.services.set(ctor.name, service);
		return service;
	}

	/**
	 * Connect to the StageLinq network.
	 */
	async connect() {
		//  Initialize Discovery agent
		StageLinq.discovery.listen(StageLinq.options.actingAs);

		await this.ready();

		//Directory is required
		StageLinq.directory = await StageLinq.startServiceListener(Directory);

		await StageLinq.discovery.announce(StageLinq.directory.serverInfo.port);
	}

	async ready() {
		while (this.options.services.includes(Services.StateMap) && !this.stateMap) {
			await sleep(100)
		}
		while (this.options.services.includes(Services.BeatInfo) && !this.beatInfo) {
			await sleep(100)
		}
		while (this.options.services.includes(Services.FileTransfer) && !this.fileTransfer) {
			await sleep(100)
		}
		while (this.options.services.includes(Services.Broadcast) && !this.broadcast) {
			await sleep(100)
		}
	}

	/**
	 * Disconnect from the StageLinq network.
	 * Close all open Servers
	 */

	async disconnect() {
		try {
			Logger.warn('disconnecting');
			await StageLinq.directory.stop();
			const services = await StageLinq.devices.getDeviceServices();
			for (const service of services) {
				await service.stop()
			}
			await StageLinq.discovery.unannounce();
		} catch (e) {
			throw new Error(e);
		}
	}
}