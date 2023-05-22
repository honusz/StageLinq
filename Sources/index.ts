import { EventEmitter } from 'events';
import { DeviceId, TrackDBEntry } from '../types';
import { Logger } from '../LogEmitter';
//import * as fs from 'fs';
import { DbConnection } from './DbConnection';
import { sleep } from '../utils';
//import { StageLinq } from '../StageLinq';
//import { Broadcast, BroadcastMessage, FileTransfer } from '../services';
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
	//#rootUpdateChannel: Dir = null;


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

	// /**
	//  * Download a file from Source
	//  * @param {Source} source
	//  * @param {string} path
	//  * @returns {Promise<Uint8Array>}
	//  */
	// async downloadFile(source: Source, path: string): Promise<void> {
	// 	const service = StageLinq.devices.device(source.deviceId).service('FileTransfer') as FileTransfer;
	// 	await service.isAvailable();
	// 	const filePath = getTempFilePath(`/${source.name}`);
	// 	try {
	// 		const file = await service.getFile(path, filePath);
	// 		return file;
	// 	} catch (err) {
	// 		Logger.error(err);
	// 		throw new Error(err);
	// 	}
	// }

	/**
	 * Download DBs from source
	 * @param {Source} source
	 */
	async downloadDbs(source: Source) {
		Logger.debug(`downloadDb request for ${source.name}`);
		for (const database of source.getDatabases()) {
			Logger.info(`downloading ${database.file.fileName}`)
			//await database.downloadDb();
		}
		this.emit('dbDownloaded', source);
		this.setSource(source);
		Logger.debug(`Downloaded ${source.deviceId.string}/${source.name}`);
	}

	// async downloadFile(sourceName: string, remotePath: string, localPath: string): Promise<File> {
	// 	const source = this.#sources.get(sourceName);
	// 	const file = await source.downloadFile(remotePath, localPath);
	// 	return file
	// }
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
	//#file: File = null;



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
		//this.#sourceDirectory.addListener(0x)
		//this.#file = file;
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

	// async downloadFile(remotePath: string, localPath: string): Promise<File> {
	// 	const fileName = remotePath.split('/').pop();
	// 	const service = this.sourceDirectory.service
	// 	const file = await service.getFile(remotePath, true)
	// 	return file
	// }
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
		//this.file.isOpen = true;
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
		console.log(this.uuid, this.file.deviceId.string, this.file.size)

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


// class oldDatabase {
// 	dbFileChan: File;

// 	deviceId: DeviceId = null;
// 	size: number;
// 	filename: string;
// 	remotePath: string;
// 	localPath: string = null;
// 	uuid: string = null;
// 	source: Source = null;
// 	sourceName: string = null;
// 	txid: number;
// 	downloaded: boolean = false;

// 	/**
// 	 * Database Type Class
// 	 * @constructor
// 	 * @param {string} filename name of the file EG: 'm.db'
// 	 * @param {number} size size of the file
// 	 * @param {string} remotePath remote path (excl filename) of file
// 	 * @param {Source} source Source that the DB file is on
// 	 * @param {Transfer} transfer
// 	 */
// 	constructor(dbFile: File) {
// 		// this.filename = filename;
// 		// this.size = size;
// 		// this.remotePath = remotePath;
// 		// this.sourceName = source.name;
// 		// this.source = source;
// 		this.dbFileChan = dbFile;
// 		// this.deviceId = source.deviceId;
// 		this.localPath = getTempFilePath(`${dbFile.service.deviceId.string}/${source.name}/`);
// 	}

// 	/**
// 	 * Get full remote path & filename
// 	 */
// 	get remoteDBPath() {
// 		return `${this.remotePath}/${this.filename}`
// 	}

// 	/**
// 	 * Get full local path & filename
// 	 */
// 	get localDBPath() {
// 		return `${this.localPath}/${this.filename}`
// 	}

// 	/**
// 	 * Create new Connection to the DB for Querying
// 	 * @returns {DbConnection}
// 	 */
// 	connection(): DbConnection {
// 		return new DbConnection(this.localDBPath)
// 	}


// 	/**
// 	 * Downloads the Database
// 	 */
// 	async downloadDb() {
// 		const source = StageLinq.sources.getSource(this.sourceName, this.deviceId)
// 		const service = StageLinq.devices.device(this.deviceId).service("FileTransfer") as FileTransfer;

// 		Logger.info(`Reading database ${source.deviceId.string}/${source.name}/${this.filename}`);
// 		await service.getFile(this.remoteDBPath, this.localDBPath);
// 		//Logger.info(`Saving ${this.remoteDBPath}} to ${this.localDBPath}`);
// 		//fs.writeFileSync(this.localDBPath, Buffer.from(file));
// 		this.downloaded = true;
// 		await this.processDB();
// 		Logger.info(`Downloaded ${source.deviceId.string}/${source.name} to ${this.remoteDBPath}`);
// 	}

// 	private async processDB() {
// 		const db = new DbConnection(this.localDBPath)
// 		const result: DBInfo[] = await db.querySource('SELECT * FROM Information LIMIT 1')
// 		this.uuid = result[0].uuid
// 		db.close();

// 		if (StageLinq.options.services.includes(Services.Broadcast)) {
// 			Broadcast.emitter.addListener(this.uuid, (key, value) => this.broadcastListener(key, value))
// 			Logger.debug(`Sources added broadcast listener for ${this.uuid}`);
// 		}
// 	}

// 	private broadcastListener(key: string, value: BroadcastMessage) {
// 		Logger.silly(`MSG FROM BROADCAST ${key}`, value);
// 		// const service = StageLinq.devices.device(this.deviceId).service('FileTransfer') as FileTransfer
// 		// service.getSourceDirInfo(this.source);
// 	}

// }
