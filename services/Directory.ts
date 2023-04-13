import { strict as assert } from 'assert';
import { Logger } from '../LogEmitter';
import { ReadContext, WriteContext } from '../utils';
import { ServiceMessage, Units } from '../types';
import { DeviceId } from '../devices'
import { Socket } from 'net';
import { StageLinq } from '../StageLinq';
import {
  Service,
  StateMap,
  FileTransfer,
  BeatInfo,
  TimeSynchronization,
  Broadcast,
} from '../services'


enum MessageId {
  ServicesAnnouncement = 0x0,
  TimeStamp = 0x1,
  ServicesRequest = 0x2,
}

export interface DirectoryData {
  deviceId: string;
}


export class Directory extends Service<DirectoryData> {
  public readonly name = 'Directory';

  protected readonly isBufferedService = false;
  protected timeAlive: number;


  protected parseData(ctx: ReadContext, socket: Socket): ServiceMessage<DirectoryData> {
    if (ctx.sizeLeft() < 20) {
      return
    }
    const id = ctx.readUInt32();
    const token = ctx.read(16);
    if (!token) {
      return
    }

    this.deviceId = new DeviceId(token);
    const deviceInfo = StageLinq.discovery.getConnectionInfo(this.deviceId);

    assert(this.socket)
    try {
      switch (id) {
        case MessageId.TimeStamp:
          ctx.seek(16);
          let timeAlive: bigint = 1n
          if (ctx.sizeLeft() >= 8) {
            timeAlive = ctx.readUInt64();
            this.timeAlive = Number(timeAlive / (1000n * 1000n * 1000n));
          }

          if (deviceInfo && deviceInfo.unit && deviceInfo.unit.type === 'MIXER') {
            setTimeout(this.sendTimeStampReply, 1400, token, socket);
          }
          break;
        case MessageId.ServicesAnnouncement:
          const service = ctx.readNetworkStringUTF16();
          const port = ctx.readUInt16();
          Logger.silent(this.name, 'received ', service, port);
          break;
        case MessageId.ServicesRequest:
          Logger.silly(`service request from ${this.deviceId.string}`)
          this.sendServiceAnnouncement(this.deviceId, socket);
          break;
        default:
          ctx.rewind()
          Logger.silent(`${this.name} possible malformed data: ${ctx.readRemainingAsNewBuffer().toString('hex')}`);
          break;
      }
    } catch (err) {
      ctx.rewind();
      Logger.silent(`${this.name} possible malformed data: ${ctx.readRemainingAsNewBuffer().toString('hex')}`)
    }


    const directoryMessage: DirectoryData = {
      deviceId: this.deviceId.string
    };
    const directoryData = {
      id: 69,
      socket: this.socket,
      deviceId: this.deviceId,
      message: directoryMessage,
    };
    return directoryData;
  }

  protected messageHandler(directoryMsg: ServiceMessage<DirectoryData>): void {
    if (!directoryMsg) {
      Logger.silent(`${this.name} Empty Directory Message`)
    }
  }

  /////////// Private Methods

  /**
   * Send Service announcement with list of Service:Port
   * @param {DeviceId} deviceId 
   * @param {Socket} socket
   */

  private async sendServiceAnnouncement(deviceId: DeviceId, socket: Socket): Promise<void> {
    const ctx = new WriteContext();
    ctx.writeUInt32(MessageId.ServicesRequest);
    ctx.write(StageLinq.options.actingAs.deviceId.array);
    let services: InstanceType<typeof Service>[] = []
    const device = await StageLinq.devices.getDevice(deviceId);
    for (const serviceName of StageLinq.options.services) {
      if (device && !!Units[device.info?.software?.name]) {
        switch (serviceName) {
          case 'FileTransfer': {
            const fileTransfer = await StageLinq.startServiceListener(FileTransfer, deviceId)
            services.push(fileTransfer);
            break;
          }
          case 'StateMap': {
            const stateMap = await StageLinq.startServiceListener(StateMap, deviceId)
            services.push(stateMap);
            break;
          }
          case 'BeatInfo': {
            const beatInfo = await StageLinq.startServiceListener(BeatInfo, deviceId)
            services.push(beatInfo);
            break;
          }
          case 'TimeSynchronization': {
            const timeSync = await StageLinq.startServiceListener(TimeSynchronization, deviceId)
            services.push(timeSync);
            break;
          }
          case 'Broadcast': {
            const broadcast = await StageLinq.startServiceListener(Broadcast, deviceId)
            services.push(broadcast);
            break;
          }
          default:
            break;
        }
      }
    }

    for (const service of services) {
      ctx.writeUInt32(MessageId.ServicesAnnouncement);
      ctx.write(StageLinq.options.actingAs.deviceId.array);
      ctx.writeNetworkStringUTF16(service.name);
      ctx.writeUInt16(service.serverInfo.port);
      Logger.debug(`${deviceId.string} Created new ${service.name} on port ${service.serverInfo.port}`);
    }

    const msg = ctx.getBuffer();
    await socket.write(msg);
    Logger.debug(`[${this.name}] sent ServiceAnnouncement to ${socket.remoteAddress}:${socket.remotePort}`);
  }

  /**
   * Send TimeStamp reply to Device
   * @param {Uint8Array} token Token from recepient Device
   */
  private async sendTimeStampReply(token: Uint8Array, socket: Socket) {
    const ctx = new WriteContext();
    ctx.writeUInt32(MessageId.TimeStamp);
    ctx.write(token);
    ctx.write(StageLinq.options.actingAs.deviceId.array);
    ctx.writeUInt64(0n);
    const message = ctx.getBuffer();
    assert(message.length === 44);
    await socket.write(message);
    Logger.silly(`sent TimeStamp to ${socket.remoteAddress}:${socket.remotePort}`);
  }

  protected instanceListener() {
  }
}
