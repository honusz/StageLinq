import { strict as assert } from 'assert';
import { ReadContext } from '../utils/ReadContext';
import { WriteContext } from '../utils/WriteContext';
import { Service } from './Service';
import { Logger } from '../LogEmitter';
import type { ServiceMessage } from '../types';

interface playerBeatData {
	beat: Buffer;
	totalBeats: Buffer; //former countdown
	BPM: Buffer; //former startTime
	samples?: Buffer;
}
export interface BeatData {
	clock: bigint;
	player1: playerBeatData;
	player2?: playerBeatData;
	remaining?: Buffer;
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
		const beatBuf = p_ctx.read(8); //former countDownBuf
		const totalBeatsBuf = p_ctx.read(8); //former startTimeBuf 
		const BPMBuf = p_ctx.read(8); //former trackLoadedBuf	
		const beatBuf2 = p_ctx.read(8); //former countDownBuf
		const totalBeatsBuf2 = p_ctx.read(8); //former startTimeBuf 
		const BPM2Buf2 = p_ctx.read(8); //former trackLoadedBuf	
		const samplesBuf = p_ctx.read(8);
		const samplesBuf2 = p_ctx.read(8);
		
		const dataFrame: BeatData = {	
			clock: clock,
			player1: {
				beat: Buffer.from(beatBuf),
				totalBeats: Buffer.from(totalBeatsBuf),
				BPM: Buffer.from(BPMBuf),
				samples: Buffer.from(samplesBuf),
			},
			player2: {
				beat: Buffer.from(beatBuf2),
				totalBeats: Buffer.from(totalBeatsBuf2),
				BPM: Buffer.from(BPM2Buf2),
				samples: Buffer.from(samplesBuf2),
			},
		}

		return {
			id: id,
			message: dataFrame
		}
	}

	protected messageHandler(p_data: ServiceMessage<BeatData>): void {
		console.clear();

		const beatFloat = p_data.message.player1.beat.readDoubleBE();
		const totalBeatsFloat = p_data.message.player1.totalBeats.readDoubleBE();
		const BPMFloat = p_data.message.player1.BPM.readDoubleBE();;
		const beatFloat2 = p_data.message.player2.beat.readDoubleBE();
		const totalBeatsFloat2 = p_data.message.player2.totalBeats.readDoubleBE();
		const BPMFloat2 = p_data.message.player2.BPM.readDoubleBE();
		const samplesFloat = p_data.message.player1.samples.readDoubleBE();
		const samplesFloat2 = p_data.message.player2.samples.readDoubleBE();
		
		let output = {
			clock: Number(p_data.message.clock/(1000n*1000n*1000n)),
			beat: beatFloat,
			totalBeats: totalBeatsFloat,
			BPM: BPMFloat,
			samples: samplesFloat / 44100,
			beat2: beatFloat2,
			totalBeats2: totalBeatsFloat2,
			BPM2: BPMFloat2,
			samples2: samplesFloat2 / 44100,
		}
		console.table(output);
	}
}