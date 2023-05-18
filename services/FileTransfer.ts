import { EventEmitter } from 'events';
import { strict as assert } from 'assert';
import { Logger } from '../LogEmitter';
import { ReadContext, WriteContext, sleep } from '../utils';
//import * as fs from 'fs';
//import { Broadcast, BroadcastMessage } from './';
import { Service } from './Service';
import { Transfer, File, Dir } from '../Sources/transfers'
import { ServiceMessage, DeviceId } from '../types';
import { Source } from '../Sources'
import { StageLinq } from '../StageLinq';
//import { performance } from 'perf_hooks';
//import { DbConnection } from '../Sources/DbConnection';

//const MESSAGE_TIMEOUT = 5000; // in ms
//const DOWNLOAD_TIMEOUT = 60000; // in ms
const MAGIC_MARKER = 'fltx';
const CHUNK_SIZE = 4096;

type ByteRange = [number, number];

// type DBInfo = {
// 	id: number;
// 	uuid: string;
// }

export interface FileTransferData {
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
	static readonly emitter: EventEmitter = new EventEmitter();
	static #txid: number = 2;
	#isAvailable: boolean = true;
	private pathCache: Map<string, number> = new Map();
	private transfers: Map<number, Dir | File> = new Map();
	//private sourceDir: Dir = null;

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
		this.addListener(`txId:0`, (message: ServiceMessage<FileTransferData>) => this.firstMessage(message));
		this.addListener(`msgId:${Request.DirInfo.toString()}`, (message: ServiceMessage<FileTransferData>) => this.sendNoSourcesReply(message.message));
	}

	/**
	 * get a new, exclusive, Transfer ID
	 * @returns {number}
	 */
	newTxid(): number {
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

		let message: ServiceMessage<FileTransferData> = {
			id: messageId,
			service: this,
			deviceId: this.deviceId,
			message: {
				txid: txId,
			}
		}

		switch (messageId) {

			case Request.DirInfo: {
				assert(ctx.readUInt32() === 0x0)
				assert(ctx.isEOF());

				//this.sendNoSourcesReply(message.message);
				break;
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

				message.message = {
					sources: sources,
					flags: {
						isFirst: isFirst,
						isLast: isLast,
						isDir: isDir
					},
					...message.message
				}
				break;
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

				message.message = {
					size: size,
					fields: fields,
					...message.message
				}
				break;
			}

			case Response.EndOfMessage: {
				// End of result indication?
				const data = ctx.readRemainingAsNewBuffer();
				message.message = {
					data: data,
					...message.message
				}
				break;
			}

			case Response.FileInfo: {
				assert(ctx.sizeLeft() === 12);
				assert(ctx.readUInt32() === 0x0);
				const filesize = ctx.readUInt32();
				const id = ctx.readUInt32();
				assert(id === 1)

				message.message = {
					size: filesize,
					...message.message
				}
				break;
			}

			case Response.FileChunk: {
				assert(ctx.readUInt32() === 0x0);
				const offset = ctx.readUInt32();
				const chunksize = ctx.readUInt32();
				assert(chunksize === ctx.sizeLeft());
				assert(ctx.sizeLeft() <= CHUNK_SIZE);
				let fileChunk: Buffer = null;
				if (ctx.sizeLeft()) fileChunk = ctx.readRemainingAsNewBuffer();
				// try {
				// 	fileChunk = ctx.readRemainingAsNewBuffer();

				// } catch (err) {
				// 	console.error(err)
				// }

				message.message = {
					data: fileChunk,
					offset: offset,
					size: chunksize,
					...message.message
				}
				break;
			}

			case Response.DataUpdate: {
				const length = Number(ctx.readUInt64());
				let byteRange: ByteRange[] = [];
				for (let i = 0; i < length; i++) {
					byteRange.push([Number(ctx.readUInt64()), Number(ctx.readUInt64())]);
				}
				assert(ctx.sizeLeft() === 8);
				const size = Number(ctx.readUInt64());

				message.message = {
					size: size,
					byteRange: byteRange,
					...message.message
				}
				break;
			}

			case Response.ConnectionSuccess: {
				// sizeLeft() of 6 means its not an offline analyzer

				message.message = {
					data: ctx.readRemainingAsNewBuffer(),
					...message.message
				}
				break;
			}

			case Response.TransferClosed: {
				// This message seems to be sent from connected devices when shutdown is started
				if (ctx.sizeLeft() > 0) {
					const msg = ctx.readRemainingAsNewBuffer().toString('hex');
					Logger.debug(msg)
				}
				break;
			}

			default:
				{
					const remaining = ctx.readRemainingAsNewBuffer()
					Logger.error(`File Transfer Unhandled message id '${messageId} '`, remaining.toString('hex'));
				}
				return
		}
		this.emit(`txId:${txId.toString()}`, message);
		this.emit(`msgId:${messageId.toString()}`, message)
		return message
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


	async getFile(remotePath: string, signalComplete?: boolean): Promise<File> {
		const thisFile = await this.fileRequest(remotePath) as File;
		//if (localPath) thisFile.localPath = localPath;
		await thisFile.downloadFile()
		if (signalComplete) this.signalTransferComplete(thisFile.txid)
		return thisFile
	}

	///////////////////////////////////////////////////////////////////////////
	// Private methods


	private async firstMessage(message: ServiceMessage<FileTransferData>) {
		const { ...data } = message.message
		console.warn(`First Message! ${message.deviceId.string} `, data)

		const transfer = await this.dirRequest('') as Dir;
		const sources = [...transfer.directories]


		for (const source of sources) {
			try {
				const sourceDir = await this.dirRequest(`/${source}`) as Dir;
				const newDir = await this.dirRequest(`/${source}/Engine Library/Database2`) as Dir;

				const fileStat = await this.fileRequest(`/${source}/Engine Library/Database2/hm.db`) as File;
				//const fileStat = await this.fileStatRequest(`/${source}/Engine Library/Database2/hm.db`) as File
				const thisSource = new Source(source, this.deviceId, newDir);

				console.warn(`downloading to ${fileStat.localPath}`)
				await fileStat.downloadFile();
				thisSource.newDatabase(fileStat);
				StageLinq.sources.setSource(thisSource);

			} catch (err) {
				console.error(source, err)
			}
		}
	}

	private getOrNewTransfer(path: string, T: typeof Transfer): Dir | File {
		if (this.pathCache.has(path)) {
			return this.transfers.get(this.pathCache.get(path))
		} else {
			const transfer = (T === Dir) ? new Dir(this, path) : new File(this, path)
			this.transfers.set(transfer.txid, transfer);
			this.pathCache.set(path, transfer.txid);
			this.addListener(`txId:${transfer.txid.toString()}`, (message) => transfer.listener(message))
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