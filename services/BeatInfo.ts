import { strict as assert } from 'assert';
import { ReadContext } from '../utils/ReadContext';
import { WriteContext } from '../utils/WriteContext';
import { Service } from './Service';
//import { Logger } from '../LogEmitter';
import type { ServiceMessage } from '../types';


interface playerBeatData {
	beat: number;
	totalBeats: number; 
	BPM: number; 
	samples?: number;
}
export interface BeatData {
	clock: bigint;
	playerCount: number;
	player: playerBeatData[];
}

export declare interface BeatInfo {
    on(event: 'message', listener: (message: BeatData) => void): this;
  }

export class BeatInfo extends Service<BeatData> {
	public headTimes = new Set<string>();
	public headTimesArray = new Array<string>();
	public playhead: number = null;
	public prePlayhead: number = null;
	
	async init() {
		
	}

	public async sendBeatInfoRequest() {
		const ctx = new WriteContext();
		ctx.write(new Uint8Array([0x0,0x0,0x0,0x4,0x0,0x0,0x0,0x0]))
		await this.write(ctx);
	}

	protected parseData(p_ctx: ReadContext): ServiceMessage<BeatData> {
		assert(p_ctx.sizeLeft() > 72);
		let id = p_ctx.readUInt32()
		const clock = p_ctx.readUInt64();
		const playerCount = p_ctx.readUInt32();
		let player: playerBeatData[] = [];
		for (let i=0; i<playerCount; i++) {
			let playerData:playerBeatData = {
				beat: p_ctx.readFloat64(),
				totalBeats: p_ctx.readFloat64(),
				BPM: p_ctx.readFloat64(),
			}
			player.push(playerData);
		}
		for (let i=0; i<playerCount; i++) {
			player[i].samples = p_ctx.readFloat64();
		}
		assert(p_ctx.isEOF())
		const beatMsg = {
			clock: clock,
			playerCount: playerCount,
			player: player,
		}
		return {
			id: id,
			message: beatMsg
		}
	}

	protected messageHandler(p_data: ServiceMessage<BeatData>): void {
        console.clear();
		console.table(p_data.message.player[0]);
       
	}
}