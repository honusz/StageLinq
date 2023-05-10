import { EventEmitter } from 'events';
import { strict as assert } from 'assert';
import { Logger } from '../LogEmitter';
import { ReadContext, WriteContext, sleep, getTempFilePath } from '../utils';
import * as fs from 'fs';
import { Service } from './Service';
import { ServiceMessage, DeviceId } from '../types';
import { Source } from '../Sources'
import { StageLinq } from '../StageLinq';
import { performance } from 'perf_hooks';

const MESSAGE_TIMEOUT = 5000; // in ms
const DOWNLOAD_TIMEOUT = 60000; // in ms
const MAGIC_MARKER = 'fltx';
const CHUNK_SIZE = 4096;

export interface FileTransferData {
	service: FileTransfer;
	deviceId: DeviceId;
	txid: number;
	size?: number;
	offset?: number;
	sources?: string[];
	data?: Buffer;
	flags?: {
		[key: string]: boolean
	};
}

// enum MessageId {
// 	TimeCode = 0x0,
// 	FileStat = 0x1,
// 	EndOfMessage = 0x2,
// 	DirResponse = 0x3, // 
// 	FileInfo = 0x4,
// 	FileTransferChunk = 0x5,
// 	DataUpdate = 0x6,
// 	ConnectionSuccess = 0x8, // Sent by player upon fltx connection
// 	DeviceShutdown = 0x9, // Directory lost or disconnected
// 	RequestSources = 0x7d2,
// }

// enum Action {
// 	RequestStat = 0x7d1,
// 	DirRequest = 0x7d2,
// 	Unknown1 = 0x7d3,
// 	RequestFileInfo = 0x7d4,
// 	RequestChunkRange = 0x7d5,
// 	TransferComplete = 0x7d6,
// 	WalMode = 0x7d9,
// }

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


// function arrayToBinary(arr: Uint8Array): number {
// 	return arr.reduce(
// 		(a, bit, i, arr) => a + (bit ? Math.pow(2, arr.length - i - 1) : 0),
// 		0
// 	)
// }


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
	private receivedFile: WriteContext = null;
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
				//console.info(`Sources Requested by ${this.deviceId.string}`);

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

				const data = ctx.readRemainingAsNewBuffer();
				ctx.seek(-4)
				const size = ctx.readUInt32();

				const message = {
					id: messageId,
					message: {
						service: this,
						deviceId: this.deviceId,
						txid: txId,
						size: size,
						data: data
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
				//const 
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

	// private async getSource(sources: string[]) {
	// 	const result: Source[] = [];

	// 	for (const source of sources) {
	// 		const dbFiles = ['m.db'];
	// 		const thisSource = new Source(source, this.deviceId)

	// 		for (const database of dbFiles) {
	// 			const dbPath = `/${source}/Engine Library/Database2`
	// 			const _transfer = {
	// 				txid: this.newTxid(),
	// 				filepath: `${dbPath}/${database}`
	// 			}
	// 			await this.requestStat(_transfer.filepath, _transfer.txid);
	// 			const fstatMessage = await this.waitForFileMessage('fileMessage', Response.FileStat, _transfer.txid);

	// 			if (fstatMessage.size > 126976) {
	// 				const db = thisSource.newDatabase(database, fstatMessage.size, dbPath)
	// 				Logger.debug(`{${_transfer.txid}} file: ${db.remoteDBPath} size: ${db.size}`)
	// 				await this.signalMessageComplete(_transfer.txid)
	// 			} else {
	// 				await this.signalMessageComplete(_transfer.txid)
	// 			}
	// 		}
	// 		StageLinq.sources.setSource(thisSource);

	// 		this.emit('newSource', thisSource)
	// 		result.push(thisSource);

	// 		if (StageLinq.options.downloadDbSources) {
	// 			await StageLinq.sources.downloadDbs(thisSource);
	// 		}
	// 	}
	// }


	///////////////////////////////////////////////////////////////////////////
	// Private methods


	private async firstMessage(message: ServiceMessage<FileTransferData>) {
		const { deviceId, service, ...data } = message.message
		console.warn(`First Message! ${deviceId.string} `, data)

		const transfer = await this.dirRequest('/') as Dir;
		const sources = [...transfer.directories]
		//console.log(directories.length, directories)
		for (const source of sources) {
			try {
				const newDir = await this.dirRequest(`/${source}/Engine Library/Database2`) as Dir;
				const newDirs = [...newDir.directories]
				const newFiles = [...newDir.files]
				const mDb = await this.fileRequest(`/${source}/Engine Library/Database2/m.db`) as File;
				console.dir(mDb);
				const fileStat = await this.fileStatRequest(`/${source}/Engine Library/Database2/m.db`) as File
				const thisSource = new Source(source, this.deviceId, newDir, mDb);
				StageLinq.sources.setSource(thisSource);
				const filePath = getTempFilePath(`/${fileStat.filename}`)
				console.warn(`downloading to ${filePath}`)
				fileStat.downloadFile(filePath, this);


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

	private async waitForFileMessage(eventMessage: string, messageId: number, txid: number): Promise<FileTransferData> {
		return await new Promise((resolve, reject) => {
			const listener = (message: ServiceMessage<FileTransferData>) => {
				if (message.id === messageId && message.message?.txid === txid) {
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
		//console.log(ctx.getBuffer())
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

abstract class Transfer extends EventEmitter {
	txid: number;
	path: string;

	constructor(txid: number, path: string) {
		super();
		this.txid = txid;
		this.path = path;
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
	//abstract listener(message: ServiceMessage<FileTransferData>): void
	abstract handler(message: ServiceMessage<FileTransferData>): void
}

export class Dir extends Transfer {
	fileNames: string[] = [];
	private subDirNames: string[] = [];
	files: Set<string> = new Set();
	directories: Set<string> = new Set();



	constructor(txid: number, path: string) {
		super(txid, path);
	}

	handler(data: ServiceMessage<FileTransferData>): void {

		//const id = Request[data.id] || Response[data.id]
		const { service, deviceId, ...message } = data.message;
		//console.warn(`TXID:${data.message.txid} ${deviceId.string}  ${id}`, message);
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

export class File extends Transfer {
	filename: string = "boner";
	size: number = null;
	bytes: Buffer = null;
	fileStat: Buffer = null;
	blockStart: number = null;
	blockEnd: number = null;
	file: fs.WriteStream = null

	constructor(txid: number, path: string) {
		super(txid, path);
		this.filename = this.path.split('/').pop();
	}

	handler(data: ServiceMessage<FileTransferData>): void {
		const { service, deviceId, ...message } = data.message;
		if (data.id === Response.FileInfo) {
			//console.dir(message)

			this.size = message.size;
			this.emit('complete', this);

			// message.flags?.isDir ? this.addSubDirs(message.sources) : this.addFiles(message.sources)
			// if (message.flags?.isLast) this.emit('complete', this);
		}

		if (data.id === Response.FileStat) {
			//console.dir(message)

			//this.size = message.size;

			this.emit('complete', this);

			// message.flags?.isDir ? this.addSubDirs(message.sources) : this.addFiles(message.sources)
			// if (message.flags?.isLast) this.emit('complete', this);
		}

		if (data.id === Response.FileChunk) {
			const chunk = (data.message.offset > 1) ? Math.ceil(data.message.offset / data.message.size) : data.message.offset
			//console.warn('chunk!!', chunk)
			this.file.write(data.message.data)
			this.emit(`chunk:${chunk}`, data)
		}
	}

	async getFileChunk(chunk: number, service: FileTransfer): Promise<void> {
		return await new Promise((resolve, reject) => {
			service.requestFileChunk(this.txid, chunk, chunk);
			this.on(`chunk:${chunk}`, (data: ServiceMessage<FileTransferData>) => {
				this.file.write(data.message.data);
				//console.warn(`GOT CHUNK ${chunk}`)
				resolve();
			});
			setTimeout(reject, DOWNLOAD_TIMEOUT, 'no response');

		});
	}

	async downloadFile(localPath: string, service: FileTransfer) {

		//const filename = this.path.split('/').shift();
		const chunks = Math.ceil(this.size / CHUNK_SIZE);
		console.log(`downloading ${chunks} chunks to local path: ${localPath}`)
		this.file = fs.createWriteStream(`${localPath}`);

		let chunkMap: Promise<void>[] = []

		for (let i = 0; i < chunks; i++) {

			const thisPromise: Promise<void> = new Promise((resolve, reject) => {
				service.requestFileChunk(this.txid, i, i);
				this.on(`chunk:${i}`, (data: ServiceMessage<FileTransferData>) => {
					//this.file.write(data.message.data);
					//console.warn(`GOT CHUNK ${i} ${data.id}`);
					resolve()
				});
				setTimeout(reject, DOWNLOAD_TIMEOUT, `no response for chunk ${i}`);

			});

			chunkMap.push(thisPromise);
			//await this.getFileChunk(i, service)
			//this.file.write(data);
			//
			//if (i % 1000 === 0) console.log(`got file chunk! ${i}/${chunks}`);
		}
		const startTime = performance.now();
		const resolved = await Promise.all(chunkMap);
		const endTime = performance.now();

		//await this.getFileChunk(47, service)
		while (this.size > this.file.bytesWritten) {
			await sleep(100)
		}

		console.log(`complete! in ${(endTime - startTime) / 1000}`, this.filename, this.file.bytesWritten, this.size)
		this.file.end();
		//console.log(this.file.bytesWritten)



	}
}
