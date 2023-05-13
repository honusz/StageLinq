import { EventEmitter } from 'events';
import { strict as assert } from 'assert';
import { Logger } from '../LogEmitter';
import { ReadContext, WriteContext, sleep, getTempFilePath } from '../utils';
import * as fs from 'fs';
import { Broadcast, BroadcastMessage } from './';
import { Service } from './Service';
import { ServiceMessage, DeviceId, Services } from '../types';
import { Source } from '../Sources'
import { StageLinq } from '../StageLinq';
import { performance } from 'perf_hooks';
import { DbConnection } from '../Sources/DbConnection';

//const MESSAGE_TIMEOUT = 5000; // in ms
const DOWNLOAD_TIMEOUT = 60000; // in ms
const MAGIC_MARKER = 'fltx';
const CHUNK_SIZE = 4096;

type ByteRange = [number, number];

type DBInfo = {
	id: number;
	uuid: string;
}

export interface FileTransferData {
	service: FileTransfer;
	deviceId: DeviceId;
	txid: number;
	size?: number;
	offset?: number;
	sources?: string[];
	data?: Buffer;
	byteRange?: ByteRange[];
	fields?: Buffer[];

	flags?: {
		[key: string]: boolean
	};
}

enum Response {
	TimeCode = 0x0,
	FileStat = 0x1,
	EndOfMessage = 0x2,
	DirInfo = 0x3, // 
	FileInfo = 0x4,
	FileChunk = 0x5,
	DataUpdate = 0x6,
	DBMode = 0x7,
	ConnectionSuccess = 0x8, // Sent by player upon fltx connection
	TransferClosed = 0x9, // Directory lost or disconnected
	Unknown = 0xa, //Response to DBMode Change?
}

enum Request {
	FileStat = 0x7d1,
	DirInfo = 0x7d2,
	Unsubscribe = 0x7d3,
	FileInfo = 0x7d4,
	FileChunk = 0x7d5,
	EndTransfer = 0x7d6,
	DBUpdate = 0x7d7,
	SuspendTransfer = 0x7d8,
	DBMode = 0x7d9,
}


export interface FileTransferProgress {
	sizeLeft: number;
	total: number;
	bytesDownloaded: number;
	percentComplete: number;
}

export declare interface FileTransfer {
	on(event: 'fileTransferProgress', listener: (source: Source, fileName: string, txid: number, progress: FileTransferProgress) => void): this;
	on(event: 'fileTransferComplete', listener: (source: Source, fileName: string, txid: number) => void): this;
}


export class FileTransfer extends Service<FileTransferData> {
	public name: string = "FileTransfer";
	//private receivedFile: WriteContext = null;
	static readonly emitter: EventEmitter = new EventEmitter();
	static #txid: number = 2;
	#isAvailable: boolean = true;
	private pathCache: Map<string, number> = new Map();
	private transfers: Map<number, Dir | File> = new Map();

	/**
	 * FileTransfer Service Class
	 * @constructor
	 * @param {DeviceId} deviceId
	 */
	constructor(deviceId?: DeviceId) {
		super(deviceId)
		this.addListener('newDevice', (service: FileTransfer) => this.instanceListener('newDevice', service))
		this.addListener('newSource', (source: Source) => this.instanceListener('newSource', source))
		this.addListener('sourceRemoved', (name: string, deviceId: DeviceId) => this.instanceListener('newSource', name, deviceId))
		this.addListener('fileTransferProgress', (source: Source, fileName: string, txid: number, progress: FileTransferProgress) => this.instanceListener('fileTransferProgress', source, fileName, txid, progress))
		this.addListener('fileTransferComplete', (source: Source, fileName: string, txid: number) => this.instanceListener('fileTransferComplete', source, fileName, txid));
		this.addListener(`data`, (ctx: ReadContext) => this.parseData(ctx));
		//this.addListener(`message`, (message: ServiceMessage<FileTransferData>) => this.messageHandler(message));
		this.addListener(`0`, (message: ServiceMessage<FileTransferData>) => this.firstMessage(message));
	}

	/**
	 * get a new, exclusive, Transfer ID
	 * @returns {number}
	 */
	private newTxid(): number {
		FileTransfer.#txid++
		const txid = parseInt(FileTransfer.#txid.toString())
		return txid;
	}

	protected instanceListener(eventName: string, ...args: any) {
		FileTransfer.emitter.emit(eventName, ...args)
	}

	private parseData(ctx: ReadContext): ServiceMessage<FileTransferData> {

		const check = ctx.getString(4);
		if (check !== MAGIC_MARKER) {
			Logger.error(assert(check === MAGIC_MARKER))
		}

		const txId = ctx.readUInt32();
		const messageId: Response | Request = ctx.readUInt32();

		switch (messageId) {
			case Request.DirInfo: {
				assert(ctx.readUInt32() === 0x0)
				assert(ctx.isEOF());

				const message = {
					id: Request.DirInfo,
					message: {
						service: this,
						deviceId: this.deviceId,
						txid: txId,
					},
				};
				this.emit(txId.toString(), message);
				this.sendNoSourcesReply(message.message);
				return message
			}

			case Response.DirInfo: {
				const sources: string[] = [];
				const sourceCount = ctx.readUInt32();
				for (let i = 0; i < sourceCount; ++i) {
					sources.push(ctx.readNetworkStringUTF16());
				}

				const isFirst = !!ctx.read(1)[0]
				const isLast = !!ctx.read(1)[0]
				const isDir = !!ctx.read(1)[0]

				assert(ctx.isEOF());

				const message = {
					id: messageId,
					message: {
						service: this,
						deviceId: this.deviceId,
						txid: txId,
						sources: sources,
						flags: {
							isFirst: isFirst,
							isLast: isLast,
							isDir: isDir
						},
					},
				};
				this.emit(txId.toString(), message);
				return message
			}

			case Response.FileStat: {
				assert(ctx.sizeLeft() === 53);
				// Last 4 bytes (FAT32) indicate size of file

				let fields: Buffer[] = []
				fields.push(Buffer.from(ctx.read(6)));
				fields.push(Buffer.from(ctx.read(13)));
				fields.push(Buffer.from(ctx.read(13)));
				fields.push(Buffer.from(ctx.read(13)));
				const size = Number(ctx.readUInt64());

				const message = {
					id: messageId,
					message: {
						service: this,
						deviceId: this.deviceId,
						txid: txId,
						size: size,
						fields: fields,
					},
				};
				this.emit(txId.toString(), message);
				return message
			}

			case Response.EndOfMessage: {
				// End of result indication?
				const data = ctx.readRemainingAsNewBuffer();
				const message = {
					id: messageId,
					message: {
						service: this,
						deviceId: this.deviceId,
						txid: txId,
						data: data
					},
				};
				this.emit(txId.toString(), message);
				return message
			}

			case Response.FileInfo: {
				assert(ctx.sizeLeft() === 12);
				assert(ctx.readUInt32() === 0x0);
				const filesize = ctx.readUInt32();
				const id = ctx.readUInt32();
				assert(id === 1)
				const message = {
					id: messageId,
					message: {
						service: this,
						deviceId: this.deviceId,
						txid: txId,
						size: filesize,
					},
				};
				this.emit(txId.toString(), message);
				return message
			}

			case Response.FileChunk: {
				assert(ctx.readUInt32() === 0x0);
				const offset = ctx.readUInt32();
				const chunksize = ctx.readUInt32();
				assert(chunksize === ctx.sizeLeft());
				assert(ctx.sizeLeft() <= CHUNK_SIZE);
				let fileChunk: Buffer = null;
				try {
					fileChunk = ctx.readRemainingAsNewBuffer();

				} catch (err) {
					console.error(err)
				}

				const message = {
					id: messageId,
					message: {
						service: this,
						deviceId: this.deviceId,
						txid: txId,
						data: fileChunk,
						offset: offset,
						size: chunksize,
					},
				};
				this.emit(txId.toString(), message);
				return message
			}

			case Response.DataUpdate: {

				const length = Number(ctx.readUInt64());

				let byteRange: ByteRange[] = [];
				for (let i = 0; i < length; i++) {
					byteRange.push([Number(ctx.readUInt64()), Number(ctx.readUInt64())]);
				}
				assert(ctx.sizeLeft() === 8);
				const size = Number(ctx.readUInt64());

				const message = {
					id: messageId,
					message: {
						service: this,
						deviceId: this.deviceId,
						txid: txId,
						size: size,
						byteRange: byteRange
					},
				};

				this.emit(txId.toString(), message);
				return message
			}

			case Response.ConnectionSuccess: {
				// sizeLeft() of 6 means its not an offline analyzer
				const message = {
					id: messageId,
					message: {
						service: this,
						deviceId: this.deviceId,
						txid: txId,
						data: ctx.readRemainingAsNewBuffer(),
					},
				};
				this.emit(txId.toString(), message);
				return message
			}

			case Response.TransferClosed: {
				// This message seems to be sent from connected devices when shutdown is started
				if (ctx.sizeLeft() > 0) {
					const msg = ctx.readRemainingAsNewBuffer().toString('hex');
					Logger.debug(msg)
				}

				const message = {
					id: messageId,
					message: {
						service: this,
						deviceId: this.deviceId,
						txid: txId,
					},
				};
				this.emit(txId.toString(), message);
				return message
			}

			default:
				{
					const remaining = ctx.readRemainingAsNewBuffer()
					Logger.error(`File Transfer Unhandled message id '${messageId}'`, remaining.toString('hex'));
				}
				return
		}
	}

	/**
		 * Promise will resolve when service is available
		 */
	public async isAvailable(): Promise<void> {
		while (!this.#isAvailable) {
			await sleep(250)
		}
	}

	/**
	 * Promise will resolve when service is available
	 * and will set service as unavailable.
	 */
	public async requestService(): Promise<void> {
		while (!this.#isAvailable) {
			await sleep(250)
		}
		this.#isAvailable = false;
	}

	/**
	 * Releases service after transfer
	 */
	public async releaseService(): Promise<void> {
		this.#isAvailable = true;
	}


	async getFile(filePath: string, saveLocation: string): Promise<void> {
		const thisFile = await this.fileRequest(filePath) as File;
		await thisFile.downloadFile(saveLocation, this)
	}

	///////////////////////////////////////////////////////////////////////////
	// Private methods


	private async firstMessage(message: ServiceMessage<FileTransferData>) {
		const { deviceId, service, ...data } = message.message
		console.warn(`First Message! ${deviceId.string} `, data)

		const transfer = await this.dirRequest('/') as Dir;
		const sources = [...transfer.directories]

		for (const source of sources) {
			try {
				const newDir = await this.dirRequest(`/${source}/Engine Library/Database2`) as Dir;
				// const newDirs = [...newDir.directories]
				// const newFiles = [...newDir.files]

				const mDb = await this.fileRequest(`/${source}/Engine Library/Database2/hm.db`) as File;
				console.dir(mDb);
				const fileStat = await this.fileStatRequest(`/${source}/Engine Library/Database2/hm.db`) as File
				const thisSource = new Source(source, this.deviceId, newDir);

				StageLinq.sources.setSource(thisSource);
				console.warn(`downloading to ${fileStat.localPath}`)
				fileStat.downloadFile(fileStat.localPath, this);
			} catch (err) {
				console.error(source, err)
			}
		}
	}

	private getOrNewTransfer(path: string, T: typeof Transfer): Dir | File {
		if (this.pathCache.has(path)) {
			return this.transfers.get(this.pathCache.get(path))
		} else {
			const transfer = (T === Dir) ? new Dir(this.newTxid(), path) : new File(this.newTxid(), path)
			this.transfers.set(transfer.txid, transfer);
			this.pathCache.set(path, transfer.txid);
			this.addListener(transfer.txid.toString(), (message) => transfer.listener(message))
			return transfer
		}
	}

	async fileRequest(path: string): Promise<Dir | File> {
		return await new Promise((resolve, reject) => {
			const transfer = this.getOrNewTransfer(path, File);
			transfer.on('complete', (tx) => resolve(tx));
			this.requestFileInfo(path, transfer.txid);
			setTimeout(reject, 10000, 'no response');
		});
	}

	async fileStatRequest(path: string): Promise<Dir | File> {
		return await new Promise((resolve, reject) => {
			const transfer = this.getOrNewTransfer(path, File);
			transfer.on('complete', (tx) => resolve(tx));
			this.requestStat(path, transfer.txid);
			setTimeout(reject, 10000, 'no response');
		});
	}

	async dirRequest(path: string): Promise<Dir | File> {
		return await new Promise((resolve, reject) => {
			const transfer = this.getOrNewTransfer(path, Dir);
			transfer.on('complete', (tx) => resolve(tx));
			this.requestDirInfo(transfer.txid, path);
			setTimeout(reject, 10000, 'no response');
		});
	}

	/**
	 * Request fstat on file from Device
	 * @param {string} filepath
	 */
	async requestStat(filepath: string, txid: number): Promise<void> {
		// 0x7d1: seems to request some sort of fstat on a file
		const ctx = this.getNewMessage(txid, 0x7d1)
		ctx.writeNetworkStringUTF16(filepath);
		await this.writeWithLength(ctx);
	}

	/**
	 * Request current sources attached to device
	 */
	async requestDirInfo(txid: number, path?: string): Promise<void> {
		// 0x7d2: Request available sources
		const ctx = this.getNewMessage(txid, 0x7d2)
		path ? ctx.writeNetworkStringUTF16(path) : ctx.writeUInt32(0x0);
		await this.writeWithLength(ctx);
	}

	/**
	 * Request TxId for file
	 * @param {string} filepath
	 */
	async requestFileInfo(filepath: string, txid: number): Promise<void> {
		// 0x7d4: Request transfer id?
		const ctx = this.getNewMessage(txid, 0x7d4)
		ctx.writeNetworkStringUTF16(filepath);
		ctx.writeUInt32(0x0); // Not sure why we need 0x0 here
		await this.writeWithLength(ctx);
	}

	/**
	 *
	 * @param {number} txid Transfer ID for this session
	 * @param {number} chunkStartId
	 * @param {number} chunkEndId
	 */
	async requestFileChunk(txid: number, chunkStartId: number, chunkEndId: number): Promise<void> {
		// 0x7d5: seems to be the code to request chunk range
		const ctx = this.getNewMessage(txid, 0x7d5)
		ctx.writeUInt32(0x0);
		ctx.writeUInt32(0x1);
		ctx.writeUInt32(0x0);
		ctx.writeUInt32(chunkStartId);
		ctx.writeUInt32(0x0);
		ctx.writeUInt32(chunkEndId);
		await this.writeWithLength(ctx);
	}

	/**
	 * Signal Transfer Completed
	 */
	async signalTransferComplete(txid: number): Promise<void> {
		// 0x7d6: seems to be the code to signal transfer completed
		const ctx = this.getNewMessage(txid, 0x7d6)
		await this.writeWithLength(ctx);
	}

	async signalMessageComplete(txid: number): Promise<void> {
		// 0x7d6: seems to be the code to signal transfer completed
		const ctx = this.getNewMessage(txid, 0x7d3)
		await this.writeWithLength(ctx);
	}
	/**
	 * Reply to Devices requesting our sources
	 * @param {FileTransferData} data
	 */
	private async sendNoSourcesReply(message: FileTransferData) {
		const ctx = this.getNewMessage(message.txid, 0x3)
		ctx.writeUInt32(0x0);
		ctx.writeUInt8(0x1);
		ctx.writeUInt8(0x1);
		ctx.writeUInt8(0x1);
		await this.writeWithLength(ctx);
	}

	getNewMessage(txid: number, command?: number): WriteContext {
		const ctx = new WriteContext();
		ctx.writeFixedSizedString(MAGIC_MARKER);
		ctx.writeUInt32(txid);
		if (command) ctx.writeUInt32(command);
		return ctx
	}
}

abstract class Transfer<T> extends EventEmitter {
	txid: number;
	remotePath: string;

	constructor(txid: number, path: string) {
		super();
		this.txid = txid;
		this.remotePath = path;
	}

	getNewMessage(command?: number): WriteContext {
		const ctx = new WriteContext();
		ctx.writeFixedSizedString(MAGIC_MARKER);
		ctx.writeUInt32(this.txid);
		if (command) ctx.writeUInt32(command);
		return ctx
	}

	listener(data: ServiceMessage<FileTransferData>): void {

		const id = Request[data.id] || Response[data.id]
		const { service, deviceId, ...message } = data.message;
		if (id !== "FileChunk") console.warn(`TXID:${data.message.txid} ${deviceId.string}  ${id}`, message);
		this.emit(id, data)
		this.handler(data)

	}

	abstract handler(message: ServiceMessage<FileTransferData>): void
}

export class Dir extends Transfer<T> {
	fileNames: string[] = [];
	private subDirNames: string[] = [];
	files: Set<string> = new Set();
	directories: Set<string> = new Set();


	constructor(txid: number, path: string) {
		super(txid, path);
	}

	handler(data: ServiceMessage<FileTransferData>): void {
		const { service, deviceId, ...message } = data.message;
		if (data.id === Response.DirInfo) {
			message.flags?.isDir ? this.addSubDirs(message.sources) : this.addFiles(message.sources)
			if (message.flags?.isLast) this.emit('complete', this);
		}
	}

	addFile(fileName: string) {
		this.fileNames.push(fileName)
	}

	addFiles(fileNames: string[]) {
		fileNames.forEach(file => this.files.add(file))
		this.fileNames = [...this.fileNames, ...fileNames]
	}

	addSubDir(subDirName: string) {
		this.subDirNames.push(subDirName);
	}

	addSubDirs(subDirNames: string[]) {
		subDirNames.forEach(dir => this.directories.add(dir))
		this.subDirNames = [...this.subDirNames, ...subDirNames]
	}

}

export class File extends Transfer<T> {
	filename: string = "";
	size: number = null;
	fileStream: fs.WriteStream = null;
	localPath: string = null;
	private chunks: number = null;
	private chunksReceived: number = 0;
	private chunkUpdates: ByteRange[][] = [];
	private chunkUpdateBusy: boolean = false;
	private chunkSessionNumber = 0;


	constructor(txid: number, path: string) {
		super(txid, path);
		this.filename = this.remotePath.split('/').pop();
		this.localPath = getTempFilePath(`/${this.filename}`);
	}

	handler(data: ServiceMessage<FileTransferData>): void {
		const { service, deviceId, ...message } = data.message;
		if (data.id === Response.FileInfo) {
			this.setFileSize(message.size);
			this.emit('complete', this);
		}

		if (data.id === Response.FileStat) {
			this.setFileSize(message.size);
			this.emit('complete', this);
		}

		if (data.id === Response.FileChunk) {
			const chunk = (data.message.offset > 1) ? Math.ceil(data.message.offset / data.message.size) : data.message.offset
			this.chunksReceived += 1
			this.fileStream.write(data.message.data)
			this.emit(`chunk:${chunk}`, data);
		}
		if (data.id === Response.DataUpdate) {
			this.chunkUpdates.push(message.byteRange);
			this.updateChunkRange(data.message.service);
		}
	}

	async updateFileChunk(filePath: string, data: Buffer, offset: number): Promise<number> {
		return await new Promise((resolve, reject) => {
			fs.open(filePath, "a", (err, fd) => {
				if (err) reject(err);
				fs.write(fd, data, 0, data.length, offset, (err, bytes) => {
					if (err) {
						reject(err)
					} else {
						fs.close(fd, () => resolve(bytes));
					}
				});
			});
		})
	}

	async updateChunkRange(service: FileTransfer) {
		this.chunkSessionNumber++
		console.info(`updateChunkRange called for ${this.chunkSessionNumber}`)
		while (this.chunkUpdateBusy) {
			await sleep(250);
		}
		this.chunkUpdateBusy = true;
		const byteRange: ByteRange[] = this.chunkUpdates.shift()
		const rangeArray = (start: number, stop: number) =>
			Array.from({ length: (stop - start) / 1 + 1 }, (_, i) => start + i * 1);

		for (const range of byteRange) {
			const chunks = rangeArray(range[0], range[1])
			for (const chunk of chunks) {
				const data = await this.getFileChunk(chunk, service);
				const offset = chunk * CHUNK_SIZE;
				const written = await this.updateFileChunk(this.localPath, data.message.data, offset)
				console.warn(`Wrote ${written} bytes at offset ${offset}`);
			}
		}
		if (!this.chunkUpdates.length) console.warn(`${this.filename} Updated!`)
		this.chunkUpdateBusy = false;
	}

	private async getFileChunk(chunk: number, service: FileTransfer): Promise<ServiceMessage<FileTransferData>> {
		return await new Promise((resolve, reject) => {
			service.requestFileChunk(this.txid, chunk, chunk);
			this.on(`chunk:${chunk}`, (data: ServiceMessage<FileTransferData>) => {
				resolve(data);
			});
			setTimeout(reject, DOWNLOAD_TIMEOUT, 'no response');

		});
	}

	private transferProgress(tx: File): number {
		const progress = Math.ceil((tx.chunksReceived / tx.chunks) * 100);
		console.log(tx.chunksReceived, tx.chunks, `${progress}%`)
		return progress
	}

	async downloadFile(localPath: string, service: FileTransfer) {

		console.log(`downloading ${this.chunks} chunks to local path: ${localPath}`)
		this.fileStream = fs.createWriteStream(`${localPath}`);

		let chunkMap: Promise<void>[] = []

		for (let i = 0; i < this.chunks; i++) {
			const thisPromise: Promise<void> = new Promise((resolve, reject) => {
				service.requestFileChunk(this.txid, i, i);
				this.on(`chunk:${i}`, () => {

					resolve()
				});
				setTimeout(reject, DOWNLOAD_TIMEOUT, `no response for chunk ${i}`);
			});
			chunkMap.push(thisPromise);
		}
		const startTime = performance.now();
		const txStatus = setInterval(this.transferProgress, 250, this)
		await Promise.all(chunkMap);
		const endTime = performance.now();
		while (this.size > this.fileStream.bytesWritten) {
			await sleep(100)
		}
		clearInterval(txStatus);

		console.log(`complete! in ${(endTime - startTime) / 1000}`, this.filename, this.fileStream.bytesWritten, this.size)
		this.fileStream.end();
	}

	private setFileSize(size: number) {
		if (this.size && size !== this.size) throw new Error('Size Descrepancy');
		this.size = size;
		this.chunks = Math.ceil(this.size / CHUNK_SIZE);
	}
}


export class Database extends File {
	deviceId: DeviceId = null;
	uuid: string = null;
	sourceName: string = null;
	downloaded: boolean = false;


	constructor(txid: number, path: string, source: Source) {
		super(txid, path);
		this.sourceName = source.name;
		this.deviceId = source.deviceId;
	}

	/**
	 * Get full remote path & filename
	 */
	get remoteDBPath() {
		return `${this.remotePath}/${this.filename}`
	}

	/**
	 * Get full local path & filename
	 */
	get localDBPath() {
		return `${this.localPath}/${this.filename}`
	}

	/**
	 * Create new Connection to the DB for Querying
	 * @returns {DbConnection}
	 */
	connection(): DbConnection {
		return new DbConnection(this.localDBPath)
	}


	/**
	 * Downloads the Database
	 */
	async downloadDb() {
		const source = StageLinq.sources.getSource(this.sourceName, this.deviceId)
		const service = StageLinq.devices.device(this.deviceId).service("FileTransfer") as FileTransfer;

		Logger.info(`Reading database ${source.deviceId.string}/${source.name}/${this.filename}`);
		await service.getFile(this.remoteDBPath, this.localDBPath);
		this.downloaded = true;
		await this.processDB();
		Logger.info(`Downloaded ${source.deviceId.string}/${source.name} to ${this.remoteDBPath}`);
	}

	private async processDB() {
		const db = new DbConnection(this.localDBPath)
		const result: DBInfo[] = await db.querySource('SELECT * FROM Information LIMIT 1')
		this.uuid = result[0].uuid
		db.close();

		if (StageLinq.options.services.includes(Services.Broadcast)) {
			Broadcast.emitter.addListener(this.uuid, (key, value) => this.broadcastListener(key, value))
			Logger.debug(`Sources added broadcast listener for ${this.uuid}`);
		}
	}

	private broadcastListener(key: string, value: BroadcastMessage) {
		Logger.silly(`MSG FROM BROADCAST ${key}`, value);
		// const service = StageLinq.devices.device(this.deviceId).service('FileTransfer') as FileTransfer
		// service.getSourceDirInfo(this.source);
	}

}