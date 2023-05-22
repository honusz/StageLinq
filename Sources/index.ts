import { EventEmitter } from 'events';
import { DeviceId, TrackDBEntry } from '../types';
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

export class Sources extends EventEmitter {
	#sources: Map<string, Source> = new Map();
	#dbUuid: Map<string, Database> = new Map();

	/**
	 * Sources EndPoint Class
	 */


	/**
	 * Check if sources has Source
	 * @param {string} sourceName - Name of source in EngineOS, eg: 'DJ STICK (USB 1)'
	 * @param {DeviceId} deviceId - DeviceID instance
	 * @returns {boolean} true if has source
	 */
	hasSource(sourceName: string, deviceId: DeviceId): boolean {
		return this.#sources.has(`${deviceId.string}${sourceName}`);
	}

	/**
	 * Check if sources has Source AND source has downloaded DB
	 * @param {string} sourceName - Name of source in EngineOS, eg: 'DJ STICK (USB 1)'
	 * @param {DeviceId} deviceId - DeviceID instance
	 * @returns {boolean} true if has Source AND the source has downloaded DB
	 */
	hasSourceAndDB(sourceName: string, deviceId: DeviceId): boolean {
		const source = this.#sources.get(`${deviceId.string}${sourceName}`);
		const dbs = source.getDatabases().filter(db => db.file.isDownloaded)
		return (source && dbs.length) ? true : false
	}

	/**
	 * Get Source
	 * @param {string} sourceName Name of source in EngineOS, eg: 'DJ STICK (USB 1)'
	 * @param {DeviceId} deviceId DeviceID instance
	 * @returns {Source}
	 */
	getSource(sourceName: string, deviceId: DeviceId): Source {
		return this.#sources.get(`${deviceId.string}${sourceName}`);
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
		this.#sources.set(`${source.deviceId.string}${source.name}`, source);
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
	deleteSource(sourceName: string, deviceId: DeviceId) {
		this.#sources.delete(`${deviceId.string}${sourceName}`)
		this.emit('sourceRemoved', sourceName, deviceId);
	}

	/**
	 * Get Databases by UUID
	 * @param {string} uuid
	 * @returns {Database[]}
	 */
	getDBByUuid(uuid: string): Database {
		const dbs = [...this.#sources.values()].map(src => src.getDatabases()).flat(1)
		return dbs.filter(db => db.uuid == uuid).shift()
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
		return db
	}
}

class Database {
	file: File = null;
	uuid: string = null;
	private dbConnection: DbConnection = null;

	constructor(dbFile: File) {
		this.file = dbFile;
		this.processDB();
	}

	async open(): Promise<void> {
		const filepath = await this.file.open();
		this.dbConnection = new DbConnection(filepath)
		return
	}

	async close() {
		this.dbConnection = null;
		this.file.close();
	}

	private async processDB() {
		while (!this.file.isDownloaded) {
			await sleep(500)
		}
		const filepath = await this.file.open();
		this.file.isOpen = true;
		const db = new DbConnection(filepath)
		const result: DBInfo[] = await db.querySource('SELECT * FROM Information LIMIT 1')
		this.uuid = result[0].uuid
		StageLinq.sources.addDatabase(this);

		db.close();
		this.file.close();

		// if (StageLinq.options.services.includes(Services.Broadcast)) {
		// 	Broadcast.emitter.addListener(this.uuid, (key, value) => this.broadcastListener(key, value))
		// 	Logger.debug(`Sources added broadcast listener for ${this.uuid}`);
		// }
	}

	async getTrackById(id: number): Promise<TrackDBEntry> {
		if (!this.file.isDownloaded) await this.file.downloadFile()
		await this.open();
		const track = await this.dbConnection.getTrackById(id)
		this.close()
		return track || null
	}
}