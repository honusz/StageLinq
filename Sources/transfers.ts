import { EventEmitter } from 'events';
import { WriteContext, sleep, getTempFilePath } from '../utils';
import * as fs from 'fs';
import { FileTransfer, FileTransferData } from '../services';
import { ServiceMessage, DeviceId, SourceName } from '../types';
import { Logger } from '../LogEmitter';
import { performance } from 'perf_hooks';
import { Socket } from 'net';
import { StageLinq } from '../StageLinq';

const DOWNLOAD_TIMEOUT = 60000; // in ms
const MAGIC_MARKER = 'fltx';
const CHUNK_SIZE = 4096;

type ByteRange = [number, number];

export interface FileTransferProgress {
    sizeLeft: number;
    total: number;
    bytesDownloaded: number;
    percentComplete: number;
    startTime: number;
    elapsed: number;
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


export abstract class Transfer extends EventEmitter {
    readonly txid: number;
    readonly remotePath: string;
    protected _deviceId: DeviceId = null;
    socket: Socket = null;
    protected _lastUpdateTime: number;

    constructor(socket: Socket, path: string,) {
        super();
        this.remotePath = path;
        this.socket = socket;
        this._deviceId = StageLinq.fileTransfer.getDeviceId(socket)
        this.txid = StageLinq.fileTransfer.newTxid();
    }

    get deviceId(): DeviceId {
        return this._deviceId
    }

    get service(): FileTransfer {
        return StageLinq.fileTransfer
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
        const { ...message } = data.message;
        if (id !== "FileChunk") Logger.debug(`TXID:${message.txid} ${data.deviceId.string} ${this.remotePath} ${id}`, message);
        this.emit(id, data)
        this.handler(data)
    }

    protected abstract handler(message: ServiceMessage<FileTransferData>): void
}


export class Dir extends Transfer {
    fileNames: string[] = [];
    private subDirNames: string[] = [];
    files: Set<string> = new Set();
    directories: Set<string> = new Set();

    constructor(socket: Socket, path: string) {
        super(socket, path);
    }

    protected handler(data: ServiceMessage<FileTransferData>): void {
        const { ...message } = data.message;
        if (data.id === Response.DirInfo) {
            message.flags?.isDir ? this.addSubDirs(message.sources) : this.addFiles(message.sources)
            if (message.flags?.isLast) this.emit('complete', this);
        }
        if (data.id === Response.TransferClosed) {
            this.emit('disconnection')
        }
    }

    private addFiles(fileNames: string[]) {
        fileNames.forEach(file => this.files.add(file))
        this.fileNames = [...this.fileNames, ...fileNames]
    }

    private addSubDirs(subDirNames: string[]) {
        subDirNames.forEach(dir => this.directories.add(dir))
        this.subDirNames = [...this.subDirNames, ...subDirNames]
    }
}
// enum Status {

//     isDownloaded = 0x0001,

// }
const isBusy = 0x0001;
const isDownloadable = 0x0010;
const isDownloaded = 0x0100;
const isPendingUpdate = 0x1000;
const isUpdated = 0x10000;
const isOpen = 0x100000;
const isUpdating = 0x1000000;
const isDownloading = 0x10000000;

interface IStatus {
    isBusy: boolean;
    isDownloadable: boolean;
    isDownloaded: boolean;
    isPendingUpdate: boolean;
    isUpdated: boolean;
    isOpen: boolean;
    isUpdating: boolean;
    isDownloading: boolean;
}
// function fn(options) {
//   if (options & isBusy) { console.log("1"); }
//   if (options & OPTION_2) { console.log("2"); }
//   if (options & OPTION_3) { console.log("3"); }
//   if (options & OPTION_4) { console.log("4"); }
// }


export class File extends Transfer {
    //private isBusy: boolean = false
    //status: 'DOWNLOADED' | 'READY' | 'PENDINGUPDATE' | 'UPDATED' | 'BUSY' = null
    private _status: number = 0;
    size: number = null;
    localPath: string = null;
    //private _isDownloaded: boolean = false;
    //isOpen: boolean = false;
    //hasPendingUpdate: boolean = false;
    private fileStream: fs.WriteStream = null;
    private chunks: number = null;
    private chunksReceived: number = 0;
    private chunkUpdates: ByteRange[][] = [];
    // private chunkUpdateBusy: boolean = false;
    private chunkSessionNumber = 0;
    private chunksToUpdate = 0
    private chunksUpdated = 0
    private chunkUpdatesPending = 0
    private chunkBuffer: Buffer[] = [];
    private chunkCheck: boolean[] = [];
    private downloadStartTime: number = 0.0;

    constructor(socket: Socket, path: string, localPath?: string) {
        super(socket, path);
        this.localPath = localPath || getTempFilePath(`${this.source}/${this.fileName}`);
    }

    get source(): string {
        const remotePath = (this.remotePath.substring(0, 1) === "/") ? this.remotePath.substring(1) : this.remotePath
        return remotePath.split('/').shift()
    }

    get fileName(): string {
        return this.remotePath.split('/').pop()
    }

    timeSinceUpdate(): number {
        return Date.now() - this._lastUpdateTime
    }

    get status(): IStatus {
        return {
            isBusy: !!(this._status & isBusy),
            isDownloadable: !!(this._status & isDownloadable),
            isDownloaded: !!(this._status & isDownloaded),
            isPendingUpdate: !!(this._status & isPendingUpdate),
            isUpdated: !!(this._status & isUpdated),
            isOpen: !!(this._status & isOpen),
            isUpdating: !!(this._status & isUpdating),
            isDownloading: !!(this._status & isDownloading),
        }
    }

    private setStatus(flags: number) {
        this._status |= flags
    }

    private clearStatus(flags: number) {
        this._status ^= flags
    }

    private checkStatus(flags: number): boolean {
        return !!(this._status & flags)
    }
    async open(): Promise<string> {

        //this.setStatus(isBusy)
        console.warn('check status', this.checkStatus(isBusy | isOpen), this.status);

        while (this.checkStatus(isBusy | isOpen)) {
            await sleep(250)
        }


        Logger.debug(`${this.fileName} open!`)
        //this.isOpen = true;
        this.setStatus(isOpen)
        console.warn('open', this.status)
        return this.localPath
    }

    close() {
        Logger.debug(`${this.fileName} closed!`)
        //this.isOpen = false;
        this.clearStatus(isOpen);
        console.warn('closed', this.status)
    }

    protected handler(data: ServiceMessage<FileTransferData>): void {
        const { ...message } = data.message;
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
            if (this.fileStream) this.chunkHandler(data.message.data);
            this.chunkCheck[chunk] = true;
            if (this.listenerCount(`chunk:${chunk}`)) this.emit(`chunk:${chunk}`, data);
            if (this.listenerCount('chunk')) this.emit(`chunk`, data)
        }
        if (data.id === Response.DataUpdate) {
            //this.hasPendingUpdate = true;
            //this.status = 'PENDINGUPDATE'
            this.setStatus(isPendingUpdate)

            this.setFileSize(data.message.size)
            this.chunkUpdates.push(message.byteRange);
            this.updateChunkRange();
        }
    }

    private chunkHandler(data: Buffer) {
        this.chunkBuffer.push(data);

        while (this.chunkBuffer.length) {
            this.fileStream.write(this.chunkBuffer.shift())
        }
    }

    private async updateFileChunk(filePath: string, data: Buffer, offset: number): Promise<number> {
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

    private getChunkArrayFromRange(chunkRange: ByteRange): number[] {
        const rangeArray = (start: number, stop: number) =>
            Array.from({ length: (stop - start) / 1 + 1 }, (_, i) => start + i * 1);
        return rangeArray(chunkRange[0], chunkRange[1])
    }

    private async updateChunkRange() {
        this.chunkUpdatesPending++
        this.chunkSessionNumber++
        //this.setStatus(isBusy)
        Logger.debug(`updateChunkRange called for ${this.chunkSessionNumber} current ${this.chunksToUpdate}`, this.status)
        while (this.checkStatus(isUpdating)) {
            await sleep(250);
        }
        //this.chunkUpdateBusy = true;
        this.setStatus(isUpdating)
        this.setStatus(isBusy)

        const byteRange: ByteRange[] = this.chunkUpdates.shift()

        for (const range of byteRange) {
            const chunks = this.getChunkArrayFromRange(range)
            this.chunksToUpdate += chunks.length
            Logger.debug(`added ${chunks.length} total ${this.chunksToUpdate} range ${range[0]} - ${range[1]}`)
            for (const chunk of chunks) {
                const data = await this.getFileChunk(chunk);
                const offset = chunk * CHUNK_SIZE;
                const written = await this.updateFileChunk(this.localPath, data.message.data, offset)
                this.chunksUpdated++
                Logger.debug(`Wrote chunk ${chunk} - ${written} bytes at offset ${offset}`);
            }
        }
        Logger.debug(`update progress ${this.chunksUpdated}/${this.chunksToUpdate}`)
        this.chunkUpdatesPending--
        //this.chunkUpdateBusy = false;
        this.clearStatus(isUpdating)
        if (!this.chunkUpdatesPending) {
            Logger.debug(`${this.fileName} Updated! Chunks written ${this.chunksUpdated} of ${this.chunksToUpdate}`)
            //this.hasPendingUpdate = false;
            this._lastUpdateTime = Date.now()
            this.emit('fileUpdated', this);
            this.clearStatus(isPendingUpdate | isBusy)
            //this.setStatus(is)
        }
    }

    private async getFileChunk(chunk: number): Promise<ServiceMessage<FileTransferData>> {
        return await new Promise((resolve, reject) => {
            StageLinq.fileTransfer.requestFileChunk(this.socket, this.txid, chunk, chunk);
            this.on(`chunk:${chunk}`, (data: ServiceMessage<FileTransferData>) => {
                resolve(data);
            });
            setTimeout(reject, DOWNLOAD_TIMEOUT, 'no response');
        });
    }

    progressUpdater(file: File): string {
        const progress = this.transferProgress(file);
        return `${this._deviceId.string} TXID:${this.txid} ${this.fileName} ${progress.bytesDownloaded.toLocaleString('en-US')} / ${progress.total.toLocaleString('en-US')} ${progress.percentComplete}% elapsed: ${progress.elapsed.toPrecision(3)} secs`
    }

    transferProgress(file: File): FileTransferProgress {
        return {
            total: file.size,
            bytesDownloaded: file.chunksReceived * CHUNK_SIZE,
            sizeLeft: file.size - (file.chunksReceived * CHUNK_SIZE),
            percentComplete: Math.ceil(file.chunksReceived / file.chunks * 100),
            startTime: file.downloadStartTime,
            elapsed: ((performance.now() - file.downloadStartTime) / 1000)
        }
    }

    async downloadFile(_localPath?: string): Promise<number> {
        Logger.debug('downloadFile called', this.status)
        if (this.checkStatus(isBusy | isOpen)) return
        //if (this.status.isOpen) return
        this.setStatus(isDownloading)
        this.setStatus(isBusy)
        try {
            const localPath = _localPath || this.localPath
            this.fileStream = fs.createWriteStream(`${localPath}`);
            this.downloadStartTime = performance.now();
            const txProgress = setInterval(() => {
                Logger.debug(this.progressUpdater(this))
            }, 250)
            StageLinq.fileTransfer.requestFileChunk(this.socket, this.txid, 0, this.chunks - 1);

            while (this.size > this.fileStream.bytesWritten) {
                await sleep(10)
            }
            const endTime = performance.now();
            clearInterval(txProgress);

            Logger.debug(`TXID: ${this.txid} completed in ${((endTime - this.downloadStartTime) / 1000).toPrecision(3)} secs`, this.deviceId.string, this.fileName, this.fileStream.bytesWritten.toLocaleString('en-US'), this.size.toLocaleString('en-US'))
            this.fileStream.end();
            //await sleep(250)

            const bytesWritten = parseInt(`${this.fileStream.bytesWritten}`)
            this.fileStream = null;
            //this.isDownloaded = true;
            this.clearStatus(isBusy)
            this.clearStatus(isDownloading)
            this.setStatus(isDownloaded)
            //console.warn(this.status)
            // console.warn(`bytes written returning ${bytesWritten}`)
            this._lastUpdateTime = Date.now();
            return bytesWritten;
        } catch (err) {
            //this.isDownloaded = false
            this.clearStatus(isBusy | isDownloaded)
            Logger.error(err)
        }
    }

    private setFileSize(size: number) {
        this.size = size;
        this.chunks = Math.ceil(this.size / CHUNK_SIZE);
        this.chunkCheck = new Array(this.chunks).fill(false)
        this.setStatus(isDownloadable)

    }

    get asSourceName(): SourceName {
        return `${this._deviceId.string}/${this.remotePath.substring(1).split('/').shift()}` as SourceName
    }
}