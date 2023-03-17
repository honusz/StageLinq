import { Discovery } from '../network';
import { EventEmitter } from 'events';
import { Logger } from '../LogEmitter';
import { ActingAsDevice, StageLinqOptions, Devices, DeviceId, ConnectionInfo, ServiceMessage, PlayerStatus, Source} from '../types';
import { Databases } from '../Databases';
import * as Services from '../services';
import { Socket, Server } from 'net';
import { assert } from 'console';

const DEFAULT_OPTIONS: StageLinqOptions = {
  maxRetries: 3,
  actingAs: ActingAsDevice.NowPlaying,
  downloadDbSources: true,
};

export interface ServiceHandlers {
  [key: string]: InstanceType<typeof Services.ServiceHandler>;
}

export declare interface StageLinq {
  on(event: 'trackLoaded', listener: (status: PlayerStatus) => void): this;
  on(event: 'stateChanged', listener: (status: PlayerStatus) => void): this;
  on(event: 'nowPlaying', listener: (status: PlayerStatus) => void): this;
  on(event: 'connected', listener: (connectionInfo: ConnectionInfo) => void): this;
  on(event: 'newStateMapDevice', listener: (deviceId: DeviceId, socket: Socket) => void): this;
  on(event: 'stateMessage', listener: ( message: ServiceMessage<Services.StateData>) => void): this;
  on(event: 'ready', listener: () => void): this;
  on(event: 'connection', listener: (serviceName: string, deviceId: DeviceId) => void): this;

  //on(event: 'fileDownloaded', listener: (sourceName: string, dbPath: string) => void): this;
  //on(event: 'fileDownloading', listener: (sourceName: string, dbPath: string) => void): this;
  on(event: 'fileProgress', listener: (path: string, total: number, bytesDownloaded: number, percentComplete: number) => void): this;
}

/**
 * Main StageLinq class.
 */
export class StageLinq extends EventEmitter {

  public services: ServiceHandlers = {};
  
  private directory: InstanceType<typeof Services.Directory> = null;
  private _databases: Databases;
  public devices = new Devices();
  private _sources: Map<string, Source> = new Map();
  private servers: Map<string, Server> = new Map();

  public options: StageLinqOptions;

  public logger: Logger = Logger.instance;
  public discovery: Discovery = new Discovery(this);

  constructor(options?: StageLinqOptions) {
    super();
    this.options = options || DEFAULT_OPTIONS;
    this._databases = new Databases(this);
  }

  ////// Getters & Setters /////////
  get databases() {
    return this._databases;
  }

  hasSource(sourceName: string): boolean {
    return this._sources.has(sourceName);
  }

  getSource(sourceName: string): Source {
    return this._sources.get(sourceName);
  }
  
  setSource(source: Source) {
    this._sources.set(source.name, source);
  }
  
  getSourceList(): string[] {
    return [...this._sources.keys()]
  } 

  getSources(): Source[] {
    return [...this._sources.values()]
  }

  getSourcesArray()  {
    return this._sources.entries()
  }

  addServer(serverName: string , server: Server) {
    this.servers.set(serverName, server);
  }

  deleteServer(serverName: string) {
    this.servers.delete(serverName);
  }

  private getServers() {
    return this.servers.entries();
  }

  /**
   * Connect to the StageLinq network.
   */
  async connect() {
    //  Initialize Discovery agent
    await this.discovery.init(this.options.actingAs);
    
    for (let service of this.options.services) {  
      switch (service) {
        case "StateMap": {
          this.services[service] = new Services.StateMapHandler(this, service);
          // this.services[service].on('connection', (name: string, deviceId: DeviceId) => {
          //   Logger.warn(`Connection ${name} ${deviceId}`);
          // });
          break;
        }
        case "FileTransfer": {
          this.services[service] = new Services.FileTransferHandler(this, service)
          break;
        }
        case "BeatInfo": {
          this.services[service] = new Services.BeatInfoHandler(this, service);
          break;
        }
        default:
        break;
      }
    }

    //Directory is required
    const directory = new Services.DirectoryHandler(this, Services.Directory.name)
    this.services[Services.Directory.name] = directory;
    this.directory = await directory.startServiceListener(Services.Directory, this);
    
    //  Announce myself with Directory port
    await this.discovery.announce(this.directory.serverInfo.port);   
  }

  /**
   * Disconnect from the StageLinq network.
   */
  async disconnect() {
    try {
      Logger.warn('disconnecting');
      const servers = this.getServers();
      for (let [serviceName, server] of servers) {
        Logger.debug(`Closing ${serviceName} server port ${server.address()}`)
        server.close;
      }      
      await this.discovery.unannounce();
    } catch (e) {
      throw new Error(e);
    }
  }

  async downloadFile(sourceName: string, path: string): Promise<Uint8Array> {
   
    const source = this.getSource(sourceName);
    const service = source.service;
    assert(service);
    await service.isAvailable();
    
    let thisTxid = service.txid;

    service.on('fileTransferProgress', (txid, progress) => {
      if (thisTxid === txid) {
        this.emit('fileProgress', path.split('/').pop(), progress.total, progress.bytesDownloaded, progress.percentComplete);
      }
    });

    try {
      const file = await service.getFile(path,service.socket);
      return file;
    } catch (err) {
      Logger.error(err);
      throw new Error(err);
    }
  } 
}