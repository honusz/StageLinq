import { EventEmitter } from 'events';
import { DeviceId, DeviceIdString, TrackDBEntry, SourceName, StateValue } from '../types';
import { Logger } from '../LogEmitter';
import { DbConnection } from './DbConnection';
import { sleep } from '../utils';
import { File, Dir } from './transfers'
import { StageLinq } from '../StageLinq';


export declare interface Sources {
	/**
	 *
	 * @event newSource
	 */
	on(event: 'newSource', listener: (source: Source) => void): this;
	on(event: 'sourceRemoved', listener: (sourceName: string, deviceId: DeviceId) => void): this;
	on(event: 'dbDownloaded', listener: (source: Source) => void): this;
}

// type JsonEntry = {
// 	string: string,
// 	type: number
// }

export class Sources extends EventEmitter {
	#sources: Map<SourceName, Source> = new Map();
	#dbUuid: Map<string, Database> = new Map();
	#connectedSources: Map<DeviceIdString, SourceName> = new Map();
	#connectedSourcesSet: Set<SourceName> = new Set();


	connectedSourceListener(sourceNetworkPath: StateValue, deviceId: DeviceId) {
		//if (remotePath.substring(0, 6) === 'net://') remotePath = _remotePath.substring(6)
		const sourceName = sourceNetworkPath.string.substring(6) as SourceName
		this.#connectedSources.set(deviceId.string, sourceName)
		this.#connectedSourcesSet.add(sourceName)
		const source = this.#sources.get(sourceName)

		if (!source) return
		const databases = source.getDatabases()
		if (databases[0] && !databases[0].file?.status?.isDownloaded) databases[0].downloadDB();
	}

	getConnectedSources(): SourceName[] {
		return [...this.#connectedSources.values()]
	}
	/**
	 * Sources EndPoint Class
	 */



	/**
	 * Check if sources has Source
	 * @param {string} sourceName - Name of source in EngineOS, eg: 'DJ STICK (USB 1)'
	 * @param {DeviceId} deviceId - DeviceID instance
	 * @returns {boolean} true if has source
	 */
	hasSource(sourceName: SourceName, deviceId: DeviceId): boolean {
		return this.#sources.has(`${deviceId.string}/${sourceName}`);
	}

	/**
	 * Check if sources has Source AND source has downloaded DB
	 * @param {string} sourceName - Name of source in EngineOS, eg: 'DJ STICK (USB 1)'
	 * @param {DeviceId} deviceId - DeviceID instance
	 * @returns {boolean} true if has Source AND the source has downloaded DB
	 */
	hasSourceAndDB(sourceName: SourceName, deviceId: DeviceId): boolean {
		const source = this.#sources.get(`${deviceId.string}/${sourceName}`);
		const dbs = source.getDatabases().filter(db => db.file.status.isDownloaded)
		return (source && dbs.length) ? true : false
	}

	/**
	 * Get Source
	 * @param {string} sourceName Name of source in EngineOS, eg: 'DJ STICK (USB 1)'
	 * @param {DeviceId} deviceId DeviceID instance
	 * @returns {Source}
	 */
	getSource(sourceName: SourceName, deviceId: DeviceId): Source {
		return this.#sources.get(`${deviceId.string}/${sourceName}`);
	}

	/**
	 * Get all Sources
	 * @param {DeviceId} [deviceId] Optional narrow results by DeviceId
	 * @returns {Source[]} an array of Sources
	 */
	getSources(deviceId?: DeviceId): Source[] {
		if (deviceId) {
			const filteredMap = new Map([...this.#sources.entries()].filter(entry => entry[0].substring(0, 36) == deviceId.string))
			return [...filteredMap.values()]
		}
		return [...this.#sources.values()]
	}

	/**
	 * Add a new Source
	 * @param {Source} source
	 */
	setSource(source: Source) {
		const sourceName = `${source.deviceId.string}/${source.name}` as SourceName
		this.#sources.set(sourceName, source);
		this.emit('newSource', source);
	}

	addDatabase(db: Database) {
		this.#dbUuid.set(db.uuid, db)
	}

	/**
	 * Delete Source
	 * @param {string} sourceName name of the source
	 * @param {DeviceId} deviceId
	 */
	deleteSource(sourceName: SourceName, deviceId: DeviceId) {
		this.#sources.delete(`${deviceId.string}/${sourceName}`)
		this.emit('sourceRemoved', sourceName, deviceId);
	}

	getDatabases(): Database[] {
		return [...this.#dbUuid.values()]
	}

	/**
	 * Get Databases by UUID
	 * @param {string} uuid
	 * @returns {Database[]}
	 */
	getDBByUuid(uuid: string): Database {
		//const dbs = [...this.#sources.values()].map(src => src.getDatabases()).flat(1)
		//return dbs.filter(db => db.uuid == uuid).shift()
		return this.#dbUuid.get(uuid)
	}

	/**
	 * Download DBs from source
	 * @param {Source} source
	 */
	async downloadDbs(source: Source) {
		Logger.debug(`downloadDb request for ${source.name}`);
		for (const database of source.getDatabases()) {
			Logger.info(`downloading ${database.file.fileName}`)
		}
		this.emit('dbDownloaded', source);
		this.setSource(source);
		Logger.debug(`Downloaded ${source.deviceId.string}/${source.name}`);
	}

}

type DBInfo = {
	id: number;
	uuid: string;
}

export class Source {
	name: string;
	deviceId: DeviceId;
	#databases: Map<string, Database> = new Map();
	sourceDirectory: Dir = null;

	/**
	 * Source Type Class
	 * @constructor
	 * @param {string} name
	 * @param {DeviceId} deviceId
	 */


	constructor(name: string, deviceId: DeviceId, sourceDirectory: Dir) {
		this.name = name;
		this.deviceId = deviceId;
		this.sourceDirectory = sourceDirectory;
	}
	/**
	 * Get a Database by File Name
	 * @param {string }name Filename eg "m.db"
	 * @returns {Database}
	 */
	getDatabase(name?: string): Database {
		return this.#databases.get(name || "m.db")
	}

	/**
	 * Get an array of all Databases
	 * @returns {Database[]}
	 */

	getDatabases(): Database[] {
		return [...this.#databases.values()]
	}

	/**
	 * New Database Constructor
	 * @param {string} filename
	 * @param {number} size
	 * @param {string} remotePath
	 * @returns
	 */
	newDatabase(file: File): Database {
		const db = new Database(file)
		this.#databases.set(file.fileName, db);
		const connectedSources = StageLinq.sources.getConnectedSources()
		console.warn(connectedSources, file.asSourceName)
		if (connectedSources.includes(file.asSourceName) && !file.status.isDownloaded) {
			console.warn('yes its there')
			db.downloadDB();
		}
		return db
	}
}

class Database {
	file: File = null;
	uuid: string = null;
	private dbConnection: DbConnection = null;
	private _maxId: number = 0;

	constructor(dbFile: File) {
		this.file = dbFile;

		this.file.addListener('fileUpdated', () => this.updateMaxId.bind(this))
		if (this.file.status.isDownloaded) this.processDB();
	}

	get maxId(): number {
		return this._maxId
	}

	async open(): Promise<void> {
		if (!this.file.status.isDownloaded) await this.downloadDB();
		const filepath = await this.file.open();
		this.dbConnection = new DbConnection(filepath)
		return
	}

	async close() {
		this.dbConnection = null;
		this.file.close();
	}

	async downloadDB() {
		const bytes = await this.file.downloadFile();
		console.warn('bytes', bytes)
		const uuid = await this.processDB();
		console.warn(uuid)
	}

	private async processDB(): Promise<string> {
		console.warn('processDb')
		while (!this.file.status.isDownloaded) {
			await sleep(500)
		}
		await this.open()
		const filepath = this.file.localPath
		//await this.file
		const db = new DbConnection(filepath)
		const result: DBInfo[] = await db.querySource('SELECT * FROM Information LIMIT 1')
		this.uuid = result[0].uuid
		StageLinq.sources.addDatabase(this);
		//const sources = StageLinq.sources.getDatabases()
		this._maxId = await db.getMaxId();
		db.close();
		//this.file.close()
		//const maxId = await this.getMaxId()
		//console.log('maxId', maxId);

		this.file.close();
		return this.uuid
		// if (StageLinq.options.services.includes(Services.Broadcast)) {
		// 	Broadcast.emitter.addListener(this.uuid, (key, value) => this.broadcastListener(key, value))
		// 	Logger.debug(`Sources added broadcast listener for ${this.uuid}`);
		// }
	}

	async getTrackById(id: number): Promise<TrackDBEntry> {
		if (!this.file.status.isDownloaded) await this.downloadDB()
		await this.open();
		const track = await this.dbConnection.getTrackById(id)
		this.close()
		return track || null
	}

	private async updateMaxId(): Promise<void> {
		await this.open();
		const filepath = this.file.localPath
		//await this.file
		const db = new DbConnection(filepath)

		const maxId = await db.getMaxId();
		if (maxId) this._maxId = maxId
		this.close()
	}

	//SELECT MAX(Id) FROM Table
}