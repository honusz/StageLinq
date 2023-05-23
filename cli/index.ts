import { ActingAsDevice, StageLinqOptions, Services, DeviceId, ServiceMessage } from '../types';
import { StateData, BeatData, BeatInfo } from '../services';
import { Source } from '../Sources'
import { sleep } from '../utils/sleep';
import { StageLinq } from '../StageLinq';
import { Logger } from '../LogEmitter';

require('console-stamp')(console, {
	format: ':date(HH:MM:ss) :label',
});

function progressBar(size: number, bytes: number, total: number): string {
	const progress = Math.ceil((bytes / total) * 10)
	let progressArrary = new Array<string>(size);
	progressArrary.fill(' ');
	if (progress) {
		for (let i = 0; i < progress; i++) {
			progressArrary[i] = '|'
		}
	}
	return `[${progressArrary.join('')}]`
}


async function main() {

	const one = 0x1
	const two = 0x10
	const three = 0x100

	function fn(options: number) {
		console.warn(options)
		if (options & one) console.warn("one");
		if (options & two) console.warn("two");
		if (options & three) console.warn("three");
		if (options & (1 | 2)) console.warn("one or two");
		//if (options & (1 | 2)) console.warn("one and two");

		//if (options & OPTION_4) { console.log("4"); }
	}
	let flags = 0
	flags |= one //| two
	fn(flags)
	flags |= two
	//flags ^= two | three
	fn(flags)
	//flags ^= one
	//fn(flags)
	//fn(one & two)
	//fn(one | two)
	//await sleep(60000)

	console.log('Starting CLI');

	const stageLinqOptions: StageLinqOptions = {
		actingAs: ActingAsDevice.StageLinqJS,
		downloadDatabase: true,
		downloadNowPlayingTrack: true,
		services: [
			Services.StateMap,
			Services.FileTransfer,
			// Services.BeatInfo,
			Services.Broadcast,
		],
	}

	const stageLinq = new StageLinq(stageLinqOptions);

	await stageLinq.ready();

	stageLinq.logger.on('error', (...args: any) => {
		console.error(...args);
	});
	stageLinq.logger.on('warn', (...args: any) => {
		console.warn(...args);
		args.push("\n");
	});
	stageLinq.logger.on('info', (...args: any) => {
		console.info(...args);
		args.push("\n");
	});
	stageLinq.logger.on('log', (...args: any) => {
		console.log(...args);
		args.push("\n");
	});
	stageLinq.logger.on('debug', (...args: any) => {
		console.debug(...args);
		args.push("\n");
	});
	//Note: Silly is very verbose!
	// stageLinq.logger.on('silly', (...args: any) => {
	//   console.debug(...args);
	// });


	StageLinq.discovery.on('listening', () => {
		console.log(`[DISCOVERY] Listening`)
	});

	StageLinq.discovery.on('announcing', (info) => {
		console.log(`[DISCOVERY] Broadcasting Announce ${info.deviceId.string} Port ${info.port} ${info.source} ${info.software.name}:${info.software.version}`)
	});

	StageLinq.discovery.on('newDiscoveryDevice', (info) => {
		console.log(`[DISCOVERY] New Device ${info.deviceId.string} ${info.source} ${info.software.name} ${info.software.version}`)
	});

	StageLinq.discovery.on('updatedDiscoveryDevice', (info) => {
		console.log(`[DISCOVERY] Updated Device ${info.deviceId.string} Port:${info.port} ${info.source} ${info.software.name} ${info.software.version}`)
	});


	StageLinq.devices.on('newDevice', (device) => {
		if (device.deviceId?.string) console.log(`[DEVICES] New Device ${device.deviceId.string}`)
	});

	// StageLinq.devices.on('newService', (device, service) => {
	// 	console.log(`[DEVICES] New ${service.name} Service on ${device.deviceId.string} port ${service.serverInfo.port}`)
	// });


	if (stageLinqOptions.services.includes(Services.Broadcast)) {

		stageLinq.broadcast.on('broadcast', async (deviceId: DeviceId, name: string, value) => {
			console.info(`[BROADCAST] ${deviceId.string} ${name}`, value);
			const db = stageLinq.sources.getDBByUuid(value.databaseUuid);
			console.info(value.databaseUuid, db?.uuid)
			if (db && value.trackId) {
				console.info(`Looking for trackId: ${value.trackId} in ${value.databaseUuid}`)
				const track = await db.getTrackById(value.trackId);
				console.info('[BROADCAST] Track Changed:', track);
			}
		})

		async function dbTest() {
			const dbstring = '0eb851d4-a9e1-466c-b398-2e8fcb61fcbd';
			const sources = stageLinq.sources.getDatabases();
			//console.dir(sources)
			const thisDb = stageLinq.sources.getDBByUuid(dbstring);
			console.log(sources.length, thisDb.uuid)
		}

		setTimeout(dbTest, 8000)
	}


	if (stageLinqOptions.services.includes(Services.StateMap)) {

		async function deckIsMaster(data: ServiceMessage<StateData>) {
			const { ...message } = data.message
			if (message.json.state) {
				const deck = parseInt(message.name.substring(12, 13));
				await sleep(250);
				const track = StageLinq.status.getTrack(data.deviceId, deck);
				console.log(`Now Playing: `, track);
				if (stageLinqOptions.services.includes(Services.FileTransfer) && StageLinq.options.downloadNowPlayingTrack) {
					const file = await stageLinq.fileTransfer.getFileInfo(track.TrackNetworkPath);
					await file.downloadFile()
				}
			}
		}


		stageLinq.stateMap.on('newDevice', async (deviceId: DeviceId) => {
			console.log(`[STATEMAP] Subscribing to States on ${deviceId.string}`);

			while (!StageLinq.devices.hasDevice(deviceId)) {
				await sleep(250)
			}
			const device = StageLinq.devices.device(deviceId);
			for (let i = 1; i <= device.deckCount(); i++) {
				stageLinq.stateMap.addListener(`${deviceId.string}/Engine/Deck${i}/DeckIsMaster`, deckIsMaster);
			}

			stageLinq.stateMap.subscribe(deviceId);
		});

		//stageLinq.stateMap.addListener(`/Client/Librarian/DevicesController/CurrentDeviceNetworkPath`, (data: ServiceMessage<StateData>) => StageLinq.sources.connectedSourceListener(data.message.json as JsonEntry, data.deviceId))


		stageLinq.stateMap.on(`/Client/Librarian/DevicesController/CurrentDeviceNetworkPath`, (data: ServiceMessage<StateData>) => StageLinq.sources.connectedSourceListener(data.message.json, data.deviceId))


		stageLinq.stateMap.on('stateMessage', async (data: ServiceMessage<StateData>) => {
			//Logger.debug(`[STATEMAP] ${data.deviceId.string} ${data.message.name} => ${JSON.stringify(data.message.json)}`);
			Logger.silent(`[STATEMAP] ${data.deviceId.string} ${data.message.name} =>`, data.message.json);
		});

	}


	if (stageLinqOptions.services.includes(Services.FileTransfer)) {


		stageLinq.fileTransfer.on('fileTransferProgress', (source, file, txid, progress) => {
			Logger.debug(`[FILETRANSFER] ${source.name} id:{${txid}} Reading ${file}: ${progressBar(10, progress.bytesDownloaded, progress.total)} (${Math.ceil(progress.percentComplete)}%)`);
		});

		stageLinq.fileTransfer.on('fileTransferComplete', (source, file, txid) => {
			console.log(`[FILETRANSFER] Complete ${source.name} id:{${txid}} ${file}`);
		});

		StageLinq.sources.on('newSource', (source: Source) => {
			console.log(`[SOURCES] Source Available: (${source.name})`);
		});

		StageLinq.sources.on('dbDownloaded', (source: Source) => {
			console.log(`[SOURCES] Database Downloaded: (${source.name})`);
		});

		StageLinq.sources.on('sourceRemoved', (sourceName: string, deviceId: DeviceId) => {
			console.log(`[SOURCES] Source Removed: ${sourceName} on ${deviceId.string}`);
		});

	}


	if (stageLinqOptions.services.includes(Services.BeatInfo)) {

		/**
		 * Resolution for triggering callback
		 *    0 = every message WARNING, it's a lot!
		 *    1 = every beat
		 *    4 = every 4 beats
		 *    .25 = every 1/4 beat
		 */
		const beatOptions = {
			everyNBeats: 1,
		}

		/**
		 *  User callback function.
		 *  Will be triggered everytime a player's beat counter crosses the resolution threshold
		 * @param {BeatData} bd
		 */
		function beatCallback(data: ServiceMessage<BeatData>,) {
			const { ...bd } = data.message
			let deckBeatString = ""
			for (let i = 0; i < bd.deckCount; i++) {
				deckBeatString += `Deck: ${i + 1} Beat: ${bd.deck[i].beat.toFixed(3)}/${bd.deck[i].totalBeats.toFixed(0)} `
			}
			console.log(`[BEATINFO] ${data.deviceId.string} clock: ${bd.clock} ${deckBeatString}`);
		}

		////  callback is optional, BeatInfo messages can be consumed by:
		//      - user callback
		//      - event messages
		//      - reading the register
		const beatMethod = {
			useCallback: true,
			useEvent: false,
			useRegister: false,
		};



		stageLinq.beatInfo.on('newDevice', async (deviceId: DeviceId, beatInfo: BeatInfo) => {
			console.log(`[BEATINFO] New Device ${deviceId.string}`)

			if (beatMethod.useCallback) {
				beatInfo.startBeatInfo(deviceId, beatOptions, beatCallback);
			}

			if (beatMethod.useEvent) {
				beatInfo.startBeatInfo(deviceId, beatOptions);
				stageLinq.beatInfo.on('beatMessage', (bd) => {

					if (bd) {
						beatCallback(bd);
					}
				});
			}

			if (beatMethod.useRegister) {
				beatInfo.startBeatInfo(deviceId, beatOptions);

				function beatFunc(beatInfo: BeatInfo) {
					const beatData = beatInfo.getBeatData(deviceId);
					if (beatData) beatCallback(beatData);
				}

				setTimeout(beatFunc, 4000, beatInfo)
			}

		})
	}


	/////////////////////////////////////////////////////////////////////////
	// CLI

	let returnCode = 0;
	try {
		process.on('SIGINT', async function () {
			console.info('... exiting');

			try {
				await stageLinq.disconnect();
			} catch (err: any) {
				const message = err.stack.toString();
				console.error(message);
			}
			process.exit(returnCode);
		});

		await stageLinq.connect();

		while (true) {
			await sleep(250);
		}

	} catch (err: any) {
		const message = err.stack.toString();
		console.error(message);
		returnCode = 1;
	}

	await stageLinq.disconnect();
	process.exit(returnCode);
}

main();
