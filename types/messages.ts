import { DeviceId } from './DeviceId';
import { Service } from '../services';
import { Socket } from 'net';

export interface DiscoveryMessage {
	deviceId: DeviceId;
	source: string;
	action: string;
	software: {
		name: string;
		version: string;
	};
	port: number;
}

export interface ConnectionInfo extends DiscoveryMessage {
	address: IpAddress;
	unit?: {
		name: string,
		type: string,
		decks: number
	};
}

// export interface Connection extends ConnectionInfo {
// 	socket: Socket
// }

export interface ServiceMessage<T> {
	id: number;
	deviceId: DeviceId;
	service: Service<T>;
	socket: Socket;
	message: T;
}


// TODO: Maybe some kind of validation?
export type IpAddress = `${string}.${string}.${string}.${string}`;
export type IpAddressPort = `${string}.${string}.${string}.${string}:${string}`