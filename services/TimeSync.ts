//import { strict as assert } from 'assert';
import { ReadContext } from '../utils/ReadContext';
import { WriteContext } from '../utils/WriteContext';
import { Service } from './Service';
//const Long = require("long");
/*
export interface BeatData {
	clock: bigint;
	countdownA: number;
	countdownB: number;
	startTimeA: number;
	startTimeB: number;
	trackLoadedA: number;
	trackLoadedB: number;
	zeroTimeA: number;
	zeroTimeB: number;
	playheadA: number;
	playheadB: number;
}
*/
export interface TimeSyncData {
	timeAlive: bigint;
}

export class TimeSynchronization extends Service<TimeSyncData> {
	public timeAlive:TimeSyncData = null;
    
    async init() {
		
	}

	public async sendBeatInfoRequest() {
		const ctx = new WriteContext();
		ctx.write(new Uint8Array([0x0,0x0,0x0,0x4,0x0,0x0,0x0,0x0]))
		await this.write(ctx);
	}

	protected parseData(p_ctx: ReadContext): ServiceMessage<TimeSyncData> {
		//assert(p_ctx.sizeLeft() > 72);
        //console.log(p_ctx.readRemainingAsNewBuffer())
    	//const newDate = Date.now();
        //console.log();

        //const bigIntDate = BigInt(newDate);
        //console.log(bigIntDate);
        const id = p_ctx.readUInt32();
        const clock = p_ctx.readUInt64();
        
        return {
            id: id,
            message: {
                timeAlive: clock
            }
        }
	}

	protected messageHandler(p_data: ServiceMessage<TimeSyncData>): void {
		//console.log('player timeAlive: ', Number(p_data.message.timeAlive / (1000n*1000n*1000n)));
        this.timeAlive = p_data.message;
	}
}