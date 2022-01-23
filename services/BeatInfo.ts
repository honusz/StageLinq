import { strict as assert } from 'assert';
import { ReadContext } from '../utils/ReadContext';
import { WriteContext } from '../utils/WriteContext';
import { Service } from './Service';

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

export class BeatInfo extends Service<BeatData> {
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
		p_ctx.seek(4);
		const countdownA = p_ctx.readUInt32();
		const countdownB = p_ctx.readUInt32();
		const startTimeA = p_ctx.readUInt32();
		const startTimeB = p_ctx.readUInt32();
		const trackLoadedA = p_ctx.readUInt32();
		const trackLoadedB = p_ctx.readUInt32();
		p_ctx.seek(16);
		const zeroTimeA = p_ctx.readUInt32();
		const zeroTimeB = p_ctx.readUInt32();
		const playheadA = p_ctx.readUInt32();
		const playheadB = p_ctx.readUInt32();
		
		const dataFrame: BeatData = {	
			clock: clock,
			countdownA: countdownA,
			countdownB: countdownB,
			startTimeA: startTimeA,
			startTimeB: startTimeB,
			trackLoadedA: trackLoadedA,
			trackLoadedB: trackLoadedB,
			zeroTimeA: zeroTimeA,
			zeroTimeB: zeroTimeB,
			playheadA: playheadA,
			playheadB: playheadB
		}
		
		return {
			id: id,
			message: dataFrame
		}
	}

	protected messageHandler(p_data: ServiceMessage<BeatData>): void {
		console.info(p_data.message.playheadA, p_data.message.playheadB, p_data.message.countdownA, p_data.message.countdownB);
	}
}