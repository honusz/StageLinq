import { strict as assert } from 'assert';
import { ReadContext } from '../utils/ReadContext';
import { WriteContext } from '../utils/WriteContext';
import { Service } from './Service';

export interface BeatData {
	clock: bigint;
	playhead: Buffer;
	countdown: Buffer;
	startTime: Buffer;
	trackLoaded: Buffer;
	zeroTime: Buffer;
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
		p_ctx.seek(4);
		const countdownBuf = p_ctx.read(8);
		const startTimeBuf = p_ctx.read(8);
		const trackLoadedBuf = p_ctx.read(8);	
		p_ctx.seek(16);
		const zeroTimeBuf = p_ctx.read(8);
		const playheadBuf = p_ctx.read(8);
	
		
		const dataFrame: BeatData = {	
			clock: clock,
			playhead: Buffer.from(playheadBuf),
			countdown: Buffer.from(countdownBuf),
			startTime: Buffer.from(startTimeBuf),
			trackLoaded: Buffer.from(trackLoadedBuf),
			zeroTime: Buffer.from(zeroTimeBuf),
		}

		/*
		const playheadHexString = Buffer.from(playheadHex).toString('hex')
		if (!this.headTimesArray.includes(playheadHexString)) {
			this.headTimesArray.push(playheadHexString);
		}
		this.headTimes.add(Buffer.from(playheadHex).toString('hex'))

		if (Number(playheadA) !== this.playhead){
			this.prePlayhead = this.playhead;
			this.playhead = Number(playheadA);
		}
		*/
		return {
			id: id,
			message: dataFrame
		}
	}

	protected messageHandler(p_data: ServiceMessage<BeatData>): void {
		console.clear();

		const zeroTime = p_data.message.zeroTime.toString('hex');
		const startTime = p_data.message.startTime.toString('hex');
		const trackLoaded = p_data.message.trackLoaded.toString('hex');
		const playhead = p_data.message.playhead.toString('hex');
		const countdown = p_data.message.countdown.toString('hex');

		let output = {
			clock: Number(p_data.message.clock/(1000n*1000n*1000n)),
			zeroTimeA: zeroTime.substring(0,8),
			zeroTimeB: zeroTime.substring(8,16),
			startTimeA: startTime.substring(0,8),
			startTimeB: startTime.substring(8,16),
			trackLoadedA: trackLoaded.substring(0,8),
			trackLoadedB: startTime.substring(8,16),
			playheadA: playhead.substring(0,8),
			playheadB: playhead.substring(8,16),
			countdownA: countdown.substring(0,8),
			countdownB: countdown.substring(8,16),
		}
		/*
		if (this.prePlayhead) {
			console.log(this.playhead - this.prePlayhead);
		} else {
			console.log(this.playhead);
		}	
		*/	
		console.table(output);
	}
}