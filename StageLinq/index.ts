import { Discovery } from '../Discovery';
import { Logger } from '../LogEmitter';
import { ActingAsDevice, StageLinqOptions, DeviceId, Services } from '../types';
import { Devices } from '../devices'
import { Sources } from '../Sources';
import { Service, Directory, FileTransfer, StateMap, BeatInfo, Broadcast, TimeSynchronization } from '../services';
import { Status } from '../status';


const DEFAULT_OPTIONS: StageLinqOptions = {
	actingAs: ActingAsDevice.StageLinqJS,
	downloadDbSources: true,
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
	static services: Map<string, InstanceType<typeof Service>> = new Map();
	// fileTransfer: FileTransfer = null;
	// stateMap: StateMap = null;
	// beatInfo: BeatInfo = null;
	// broadcast: Broadcast = null;
	// timeSync: TimeSynchronization = null;
	static fileTransfer: FileTransfer = null;
	static stateMap: StateMap = null;
	static beatInfo: BeatInfo = null;
	static broadcast: Broadcast = null;
	static timeSync: TimeSynchronization = null;

	private static _servicePorts: Map<string, number> = new Map();



	constructor(options?: StageLinqOptions,) {
		StageLinq._options = options || DEFAULT_OPTIONS;
		StageLinq._discovery = new Discovery();
		StageLinq._devices = new Devices();
		StageLinq._sources = new Sources();
		StageLinq._status = new Status();
		if (StageLinq.options.services.includes(Services.StateMap)) StageLinq.startServiceListener(StateMap).then(service => StageLinq.stateMap = service);
		if (StageLinq.options.services.includes(Services.FileTransfer)) StageLinq.startServiceListener(FileTransfer).then(service => StageLinq.fileTransfer = service);
		if (StageLinq.options.services.includes(Services.BeatInfo)) StageLinq.startServiceListener(BeatInfo).then(service => StageLinq.beatInfo = service);
		if (StageLinq.options.services.includes(Services.Broadcast)) StageLinq.startServiceListener(Broadcast).then(service => StageLinq.broadcast = service);

	}

	static get options() {
		return this._options
	}

	static get discovery() {
		return this._discovery
	}

	static get devices() {
		return this._devices
	}

	static get sources() {
		return this._sources
	}

	static get status() {
		return this._status
	}

	static get directory() {
		return this._directory
	}

	static get servicePorts(): [string, number][] {
		return [...this._servicePorts.entries()]
	}

	private static set directory(service: Directory) {
		StageLinq._directory = service;
	}

	static getService<T>(serviceName: string): Service<T> {
		return StageLinq.services.get(serviceName) as Service<T>
	}

	get fileTransfer(): FileTransfer {
		return StageLinq.fileTransfer
	}

	get stateMap(): StateMap {
		return StageLinq.stateMap
	}

	get beatInfo(): BeatInfo {
		return StageLinq.beatInfo
	}

	get broadcast(): Broadcast {
		return StageLinq.broadcast
	}

	get timeSync(): TimeSynchronization {
		return StageLinq.timeSync
	}

	/**
	 * Service Constructor Factory Function
	 * @param {Service<T>} Service
	 * @param {DeviceId} [deviceId]
	 * @returns {Promise<Service<T>>}
	 */
	static async startServiceListener<T extends InstanceType<typeof Service>>(ctor: {
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

		//Directory is required
		StageLinq.directory = await StageLinq.startServiceListener(Directory);
		// if (StageLinq.options.services.includes(Services.FileTransfer)) this.fileTransfer = await StageLinq.startServiceListener(FileTransfer);
		// if (StageLinq.options.services.includes(Services.StateMap)) this.stateMap = await StageLinq.startServiceListener(StateMap);
		// if (StageLinq.options.services.includes(Services.BeatInfo)) this.beatInfo = await StageLinq.startServiceListener(BeatInfo);
		// if (StageLinq.options.services.includes(Services.Broadcast)) this.broadcast = await StageLinq.startServiceListener(Broadcast);
		// if (StageLinq.options.services.includes(Services.TimeSynchronization)) this.timeSync = await StageLinq.startServiceListener(TimeSynchronization);
		//  Announce myself with Directory port
		await StageLinq.discovery.announce(StageLinq.directory.serverInfo.port);
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
				//Logger.log(`closing ${service.name} on ${service.deviceId.string}`);
				await service.stop()
			}
			await StageLinq.discovery.unannounce();
		} catch (e) {
			throw new Error(e);
		}
	}
}