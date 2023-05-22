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
import { Socket } from 'net';
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




// export declare interface FileTransfer {
// 	on(event: 'fileTransferProgress', listener: (source: Source, fileName: string, txid: number, progress: FileTransferProgress) => void): this;
// 	on(event: 'fileTransferComplete', listener: (source: Source, fileName: string, txid: number) => void): this;
// }


export class FileTransfer extends Service<FileTransferData> {
	public name: string = "FileTransfer";
	static readonly emitter: EventEmitter = new EventEmitter();
	static #txid: number = 2;
	#isAvailable: boolean = true;
	private pathCache: Map<string, number> = new Map();
	private transfers: Map<number, Dir | File> = new Map();
	//private sourceDir: Dir = null;
	// private static socketMap: Map<string, Socket> = new Map()

	/**
	 * FileTransfer Service Class
	 * @constructor
	 * @param {DeviceId} deviceId
	 */
	constructor(deviceId?: DeviceId) {
		super(deviceId)
		this.addListener('newDevice', (deviceId: DeviceId, service: FileTransfer) => this.instanceListener('newDevice', deviceId, service))
		this.addListener('newSource', (source: Source) => this.instanceListener('newSource', source))
		this.addListener('sourceRemoved', (name: string, deviceId: DeviceId) => this.instanceListener('newSource', name, deviceId))
		//this.addListener('fileTransferProgress', (source: Source, fileName: string, txid: number, progress: FileTransferProgress) => this.instanceListener('fileTransferProgress', source, fileName, txid, progress))
		//this.addListener('fileTransferComplete', (source: Source, fileName: string, txid: number) => this.instanceListener('fileTransferComplete', source, fileName, txid));
		this.addListener(`data`, (ctx: ReadContext, socket: Socket) => this.parseData(ctx, socket));
		//this.addListener(`message`, (message: ServiceMessage<FileTransferData>) => this.messageHandler(message));
		this.addListener(`txId:0`, (message: ServiceMessage<FileTransferData>) => this.firstMessage(message));
		this.addListener(`msgId:${Request.DirInfo.toString()}`, (message: ServiceMessage<FileTransferData>) => this.sendNoSourcesReply(message));
		//this.addListener('newDevice', (service: FileTransfer) => FileTransfer.socketMap.set(service.deviceId.string, service.socket))
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

	private parseData(ctx: ReadContext, socket: Socket): ServiceMessage<FileTransferData> {

		const check = ctx.getString(4);
		if (check !== MAGIC_MARKER) {
			Logger.error(assert(check === MAGIC_MARKER))
		}

		const txId = ctx.readUInt32();
		const messageId: Response | Request = ctx.readUInt32();
		const deviceId = this.getDeviceId(socket);
		//if (this.deviceId.string !== deviceId.string) Logger.warn(`deviceId mismatch! ${this.deviceId.string} ${deviceId.string}`);

		let message: ServiceMessage<FileTransferData> = {
			id: messageId,
			service: this,
			socket: socket,
			deviceId: deviceId,
			message: {
				txid: txId,
			}
		}

		switch (messageId) {

			case Request.DirInfo: {
				assert(ctx.readUInt32() === 0x0)
				assert(ctx.isEOF());
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
				if (id !== 1) Logger.warn(`fileInfo weirdness ${id} size: ${filesize}`)

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


	async getFileInfo(_remotePath: string): Promise<File> {

		let remotePath = _remotePath;
		if (remotePath.substring(0, 6) === 'net://') remotePath = _remotePath.substring(6)
		const pathSplit = remotePath.split('/')
		const deviceId = new DeviceId(pathSplit.shift())
		remotePath = `/${pathSplit.join('/')}`
		const socket = this.sockets.get(deviceId.string)
		const thisFile = await this.fileRequest(socket, remotePath) as File;
		//if (localPath) thisFile.localPath = localPath;
		//await thisFile.downloadFile()
		//if (signalComplete) this.signalTransferComplete(socket, thisFile.txid)
		return thisFile
	}

	///////////////////////////////////////////////////////////////////////////
	// Private methods


	private async firstMessage(message: ServiceMessage<FileTransferData>) {
		const { ...data } = message.message
		Logger.debug(`First Message! ${this.getDeviceId(message.socket).string} ${message.deviceId.string} `, data)
		//Logger.log()
		const transfer = await this.dirRequest(message.socket, `/`) as Dir;
		const sources = [...transfer.directories]


		let promiseArray: Promise<File>[] = []
		for (const source of sources) {
			const promise = new Promise<File>(async (resolve, reject) => {
				try {
					await this.dirRequest(message.socket, `/${source}`) as Dir;
					const newDir = await this.dirRequest(message.socket, `/${source}/Engine Library/Database2`) as Dir;

					const fileStat = await this.fileRequest(message.socket, `/${source}/Engine Library/Database2/hm.db`) as File;
					//const fileStat = await this.fileStatRequest(`/${source}/Engine Library/Database2/hm.db`) as File
					const thisSource = new Source(source, message.deviceId, newDir);

					//Logger.warn(`downloading to ${fileStat.localPath}`)
					await fileStat.downloadFile();
					thisSource.newDatabase(fileStat);
					StageLinq.sources.setSource(thisSource);
					resolve(fileStat)

				} catch (err) {
					reject(err)
				}
			});
			promiseArray.push(promise)

		}
		Promise.all(promiseArray)
		// if (this.getDeviceId(message.socket).string == '1e6c417a-b674-4c87-b4aa-fb7ad2298976') {
		// 	await this.getFile('net://1e6c417a-b674-4c87-b4aa-fb7ad2298976/DJ2 (USB 1)/Engine Library/Music/Vakabular/Best Of Phobos Seven Years/16304217_First Time_(Original Mix) (3).mp3')
		// }
	}

	private getOrNewTransfer(socket: Socket, path: string, T: typeof Transfer): Dir | File {
		const deviceId = this.getDeviceId(socket)
		const fullPath = `${deviceId.string}/${path}`
		if (this.pathCache.has(fullPath)) {
			return this.transfers.get(this.pathCache.get(fullPath))
		} else {
			const transfer = (T === Dir) ? new Dir(socket, path) : new File(socket, path)
			this.transfers.set(transfer.txid, transfer);
			this.pathCache.set(fullPath, transfer.txid);
			this.addListener(`txId:${transfer.txid.toString()}`, (message) => transfer.listener(message))
			return transfer
		}
	}

	async fileRequest(socket: Socket, path: string): Promise<Dir | File> {
		return await new Promise((resolve, reject) => {
			const transfer = this.getOrNewTransfer(socket, path, File);
			transfer.on('complete', (tx) => resolve(tx));
			this.requestFileInfo(socket, transfer.txid, path);
			setTimeout(reject, 10000, 'no response');
		});
	}

	async fileStatRequest(socket: Socket, path: string): Promise<Dir | File> {
		return await new Promise((resolve, reject) => {
			const transfer = this.getOrNewTransfer(socket, path, File);
			transfer.on('complete', (tx) => resolve(tx));
			this.requestStat(socket, transfer.txid, path);
			setTimeout(reject, 10000, 'no response');
		});
	}

	async dirRequest(socket: Socket, path: string): Promise<Dir | File> {
		return await new Promise((resolve, reject) => {
			const transfer = this.getOrNewTransfer(socket, path, Dir);
			transfer.on('complete', (tx) => resolve(tx));
			this.requestDirInfo(socket, transfer.txid, path);
			setTimeout(reject, 10000, 'no response');
		});
	}

	/**
	 * Request fstat on file from Device
	 * @param {string} filepath
	 */
	async requestStat(socket: Socket, txid: number, filepath: string): Promise<void> {
		// 0x7d1: seems to request some sort of fstat on a file
		const ctx = this.getNewMessage(txid, 0x7d1)
		ctx.writeNetworkStringUTF16(filepath);
		await this.writeWithLength(ctx, socket);
	}

	/**
	 * Request current sources attached to device
	 */
	async requestDirInfo(socket: Socket, txid: number, path?: string): Promise<void> {
		// 0x7d2: Request available sources
		const ctx = this.getNewMessage(txid, 0x7d2)
		path ? ctx.writeNetworkStringUTF16(path) : ctx.writeUInt32(0x0);
		await this.writeWithLength(ctx, socket);
	}

	/**
	 * Request TxId for file
	 * @param {string} filepath
	 */
	async requestFileInfo(socket: Socket, txid: number, filepath: string,): Promise<void> {
		// 0x7d4: Request transfer id?
		const ctx = this.getNewMessage(txid, 0x7d4)
		ctx.writeNetworkStringUTF16(filepath);
		ctx.writeUInt32(0x0); // Not sure why we need 0x0 here
		await this.writeWithLength(ctx, socket);
	}

	/**
	 *
	 * @param {number} txid Transfer ID for this session
	 * @param {number} chunkStartId
	 * @param {number} chunkEndId
	 */
	async requestFileChunk(socket: Socket, txid: number, chunkStartId: number, chunkEndId: number): Promise<void> {
		// 0x7d5: seems to be the code to request chunk range
		const ctx = this.getNewMessage(txid, 0x7d5)
		ctx.writeUInt32(0x0);
		ctx.writeUInt32(0x1);
		ctx.writeUInt32(0x0);
		ctx.writeUInt32(chunkStartId);
		ctx.writeUInt32(0x0);
		ctx.writeUInt32(chunkEndId);
		await this.writeWithLength(ctx, socket);
	}

	/**
	 * Signal Transfer Completed
	 */
	async signalTransferComplete(socket: Socket, txid: number): Promise<void> {
		// 0x7d6: seems to be the code to signal transfer completed
		const ctx = this.getNewMessage(txid, 0x7d6)
		await this.writeWithLength(ctx, socket);
	}

	async signalMessageComplete(socket: Socket, txid: number): Promise<void> {
		// 0x7d6: seems to be the code to signal transfer completed
		const ctx = this.getNewMessage(txid, 0x7d3)
		await this.writeWithLength(ctx, socket);
	}
	/**
	 * Reply to Devices requesting our sources
	 * @param {FileTransferData} data
	 */
	private async sendNoSourcesReply(message: ServiceMessage<FileTransferData>) {
		const ctx = this.getNewMessage(message.message.txid, 0x3)
		ctx.writeUInt32(0x0);
		ctx.writeUInt8(0x1);
		ctx.writeUInt8(0x1);
		ctx.writeUInt8(0x1);
		await this.writeWithLength(ctx, message.socket);
	}

	getNewMessage(txid: number, command?: number): WriteContext {
		const ctx = new WriteContext();
		ctx.writeFixedSizedString(MAGIC_MARKER);
		ctx.writeUInt32(txid);
		if (command) ctx.writeUInt32(command);
		return ctx
	}
}