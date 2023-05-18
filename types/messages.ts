import { DeviceId } from './DeviceId';
import { Service } from '../services';

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

export interface ServiceMessage<T> {
	id: number;
	deviceId: DeviceId;
	service: Service<T>;
	message: T;
}


// TODO: Maybe some kind of validation?
export type IpAddress = string;
export type IpAddressPort = string;