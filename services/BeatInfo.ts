import { strict as assert } from 'assert';
//import { StageLinqValue } from '../common';
import { ReadContext } from '../utils/ReadContext';
import { WriteContext } from '../utils/WriteContext';
import { Service } from './Service';

const MAGIC_MARKER = 'smaa';
// FIXME: Is this thing really an interval?
const MAGIC_MARKER_INTERVAL = 0x000007d2;
const MAGIC_MARKER_JSON = 0x00000000;

type BeatInfoData = any;

export interface BeatData {
	name: string;
	json?: {
		type: number;
		string?: string;
		value?: number;
	};
	interval?: number;
}

export class BeatInfo extends Service<BeatInfo> {
	async init() {
		
	}

	protected parseData(p_ctx: ReadContext): ServiceMessage<BeatInfoData> {
		const marker = p_ctx.getString(4);
		assert(marker === MAGIC_MARKER);

		const type = p_ctx.readUInt32();
		switch (type) {
			case MAGIC_MARKER_JSON: {
				const name = p_ctx.readNetworkStringUTF16();
				const json = JSON.parse(p_ctx.readNetworkStringUTF16());
				return {
					id: MAGIC_MARKER_JSON,
					message: {
						name: name,
						json: json,
					},
				};
			}

			case MAGIC_MARKER_INTERVAL: {
				const name = p_ctx.readNetworkStringUTF16();
				const interval = p_ctx.readInt32();
				return {
					id: MAGIC_MARKER_INTERVAL,
					message: {
						name: name,
						interval: interval,
					},
				};
			}

			default:
				break;
		}
		assert.fail(`Unhandled type ${type}`);
		return null;
	}

	protected messageHandler(p_data: ServiceMessage<BeatInfoData>): void {
		console.log(
			`${p_data.message.name} => ${
				p_data.message.json ? JSON.stringify(p_data.message.json) : p_data.message.interval
			}`
		);

		if (p_data.message.name.includes('TrackNetworkPath')) {
			const path = this.controller.getAlbumArtPath(p_data.message.json.string);

			// Now pretend as if this is a value outputted by the device
			if (path) {
				console.log(
					`${p_data.message.name.replace(
						'TrackNetworkPath',
						'TrackLocalAlbumArtPath'
					)} => {"string": "${path}", "type":0}`
				);
			} else {
				console.log(
					`${p_data.message.name.replace(
						'TrackNetworkPath',
						'TrackLocalAlbumArtPath'
					)} => {"string": "", "type":-1}`
				);
			}
		}
	}

	private async subscribeState(p_state: string, p_interval: number) {
		//console.log(`Subscribe to state '${p_state}'`);
		const getMessage = function (): Buffer {
			const ctx = new WriteContext();
			ctx.writeFixedSizedString(MAGIC_MARKER);
			ctx.writeUInt32(MAGIC_MARKER_INTERVAL);
			ctx.writeNetworkStringUTF16(p_state);
			ctx.writeUInt32(p_interval);
			return ctx.getBuffer();
		};

		const message = getMessage();
		{
			const ctx = new WriteContext();
			ctx.writeUInt32(message.length);
			const written = await this.connection.write(ctx.getBuffer());
			assert(written === 4);
		}
		{
			const written = await this.connection.write(message);
			assert(written === message.length);
		}
	}
}
