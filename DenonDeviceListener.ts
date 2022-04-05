import { strict as assert } from 'assert';
import { Action, LISTEN_PORT, DISCOVERY_MESSAGE_MARKER } from './common';
import { createSocket, RemoteInfo } from 'dgram';
import { ReadContext } from './utils/ReadContext';
import { ConnectionInfo, IpAddress } from './types';

type DeviceDiscoveryCallback = (info: ConnectionInfo) => void;

/**
 * Continuously listens for devices to announce themselves. When they do,
 * execute a callback.
 */
export class DenonDeviceListener {

  devices: Map<IpAddress, ConnectionInfo> = new Map();

  /**
   * Listen for new devices on the network and callback when a new one is found.
   * @param callback Callback when new device is discovered.
   */
  onDeviceDiscovered(callback: DeviceDiscoveryCallback) {
    const client = createSocket('udp4');
    client.on('message', (p_announcement: Uint8Array, p_remote: RemoteInfo) => {
      const ctx = new ReadContext(p_announcement.buffer, false);
      const result = this.readConnectionInfo(ctx, p_remote.address);

      assert(ctx.tell() === p_remote.size);
      assert(result.action === Action.Login);

      if (this.isDeviceNew(result)) {
        // Keep a record of all the devices that we find on the network.
        this.devices.set(result.address, result);

        // But only callback if it's ones we want to know about.
        if (!this.ignoreDevice(result)) callback(result);
      }
    });
    client.bind(LISTEN_PORT);
  }

  /**
   * Is this a new device or have we already seen it?
   * @param device Discovered device.
   * @returns True if it's a new device.
   */
  private isDeviceNew(device: ConnectionInfo) {
    return !this.devices.has(device.address);
  }

  /**
   * Filter out some stuff from the network.
   * @param device
   * @returns True if we want to filter this device out from the callback.
   */
  private ignoreDevice(device: ConnectionInfo) {
    if (device.software.name === 'OfflineAnalyzer') return true;
    if (device.source === 'testing') return true;
    return false;
  }

  private readConnectionInfo(p_ctx: ReadContext, p_address: string): ConnectionInfo {
    const magic = p_ctx.getString(4);
    if (magic !== DISCOVERY_MESSAGE_MARKER) {
      return null;
    }

    const result: ConnectionInfo = {
      token: p_ctx.read(16),
      source: p_ctx.readNetworkStringUTF16(),
      action: p_ctx.readNetworkStringUTF16(),
      software: {
        name: p_ctx.readNetworkStringUTF16(),
        version: p_ctx.readNetworkStringUTF16(),
      },
      port: p_ctx.readUInt16(),
      address: p_address,
    };
    assert(p_ctx.isEOF());
    return result;
  }
}
