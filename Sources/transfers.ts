import { EventEmitter } from 'events';
import { WriteContext, sleep, getTempFilePath } from '../utils';
import * as fs from 'fs';
import { FileTransfer, FileTransferData } from '../services';
import { ServiceMessage, DeviceId } from '../types';
import { performance } from 'perf_hooks';

const DOWNLOAD_TIMEOUT = 60000; // in ms
const MAGIC_MARKER = 'fltx';
const CHUNK_SIZE = 4096;

type ByteRange = [number, number];

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
    service: FileTransfer;

    constructor(service: FileTransfer, path: string,) {
        super();
        this.service = service;
        this.remotePath = path;
        this.txid = service.newTxid();
    }

    get deviceId(): DeviceId {
        return this.service.deviceId
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
        if (id !== "FileChunk") console.warn(`TXID:${message.txid} ${data.deviceId.string} ${this.remotePath} ${id}`, message);
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


    constructor(service: FileTransfer, path: string) {
        super(service, path);
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

export class File extends Transfer {
    size: number = null;
    localPath: string = null;
    isDownloaded: boolean = false;
    isOpen: boolean = false;
    private fileStream: fs.WriteStream = null;
    private chunks: number = null;
    private chunksReceived: number = 0;
    private chunkUpdates: ByteRange[][] = [];
    private chunkUpdateBusy: boolean = false;
    private chunkSessionNumber = 0;
    private chunkBuffer: Buffer[] = [];
    private chunkCheck: boolean[] = [];


    constructor(service: FileTransfer, path: string, localPath?: string) {
        super(service, path);
        this.localPath = localPath || getTempFilePath(`${this.source}/${this.fileName}`);
    }

    get source(): string {
        const remotePath = (this.remotePath.substring(0, 1) === "/") ? this.remotePath.substring(1) : this.remotePath
        return remotePath.split('/').shift()
    }

    get fileName(): string {
        return this.remotePath.split('/').pop()
    }

    async onFileClosed(): Promise<void> {
        while (this.isOpen) {
            await sleep(250)
        }
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
            this.chunkHandler(data.message.data);
            this.chunkCheck[chunk] = true;
            this.emit(`chunk:${chunk}`, data);
        }
        if (data.id === Response.DataUpdate) {
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

    private async updateChunkRange() {
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
                const data = await this.getFileChunk(chunk, this.service);
                const offset = chunk * CHUNK_SIZE;
                const written = await this.updateFileChunk(this.localPath, data.message.data, offset)
                console.warn(`Wrote ${written} bytes at offset ${offset}`);
            }
        }
        if (!this.chunkUpdates.length) console.warn(`${this.fileName} Updated!`)
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
        return progress
    }

    async downloadFile(): Promise<number> {

        const localPath = this.localPath
        console.log(`${this.service.deviceId.string} downloading ${this.chunks} chunks to local path: ${localPath}`)
        this.fileStream = fs.createWriteStream(`${localPath}`);
        const startTime = performance.now();
        const txStatus = setInterval(this.transferProgress, 250, this)
        this.service.requestFileChunk(this.txid, 0, this.chunks - 1);
        const endTime = performance.now();
        while (this.size > this.fileStream.bytesWritten) {
            console.info(this.size, this.fileStream.bytesWritten)
            await sleep(250)
        }
        clearInterval(txStatus);

        console.log(`complete! in ${(endTime - startTime) / 1000}`, this.deviceId.string, this.fileName, this.fileStream.bytesWritten, this.size)
        this.fileStream.end();
        this.isDownloaded = true;
        return this.fileStream.bytesWritten;
    }

    private setFileSize(size: number) {
        if (this.size && size !== this.size) throw new Error('Size Descrepancy');
        this.size = size;
        this.chunks = Math.ceil(this.size / CHUNK_SIZE);
        this.chunkCheck = new Array(this.chunks).fill(false)
    }
}