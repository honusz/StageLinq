import { ActingAsDevice, StageLinqOptions, Services, DeviceId, ServiceMessage } from '../types';
import { StateData } from '../services';
import { sleep } from '../utils/sleep';
import { StageLinq } from '../StageLinq';



async function main() {

    const stageLinqOptions: StageLinqOptions = {
        actingAs: ActingAsDevice.NowPlaying,
        downloadNowPlayingTrack: true,
        services: [
            Services.StateMap,
            Services.FileTransfer,
        ],
    }

    const stageLinq = new StageLinq(stageLinqOptions);

    await stageLinq.ready();

    // while (stageLinqOptions.services.includes(Services.StateMap) && !stageLinq.stateMap) {
    //     await sleep(250)
    // }

    // while (stageLinqOptions.services.includes(Services.FileTransfer) && !stageLinq.fileTransfer) {
    //     await sleep(250)
    // }

    async function deckIsMaster(data: ServiceMessage<StateData>) {
        const { ...message } = data.message
        if (message.json.state) {
            const deck = parseInt(message.name.substring(12, 13));
            await sleep(250);
            const track = StageLinq.status.getTrack(data.deviceId, deck);
            console.log(`Now Playing: `, track);
            if (stageLinqOptions.services.includes(Services.FileTransfer) && StageLinq.options.downloadNowPlayingTrack) {
                const file = await stageLinq.fileTransfer.getFileInfo(track.TrackNetworkPath);
                const txProgress = setInterval(() => {
                    console.log(file.progressUpdater(file))
                }, 250)
                await file.downloadFile()
                clearInterval(txProgress);
            }
        }
    }

    // async function deckIsMaster(data: ServiceMessage<StateData>) {
    // 	const { ...message } = data.message;
    // 	if (message.json.state) {
    // 		const deck = parseInt(message.name.substring(12, 13))
    // 		await sleep(250);
    // 		const track = StageLinq.status.getTrack(data.deviceId, deck)

    // 		if (StageLinq.options.downloadDbSources) {
    // 			console.warn(track.source.path)
    // 			downloadFile(track.source.name, track.source.location, track.source.path, Path.resolve(os.tmpdir()));
    // 		}

    // 		console.log(`Now Playing: `, track) //Or however you consume it
    // 	}
    // }

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


    // StateMap.emitter.on('newDevice', async (service: StateMap) => {

    // 	for (let i = 1; i <= service.device.deckCount(); i++) {
    // 		service.addListener(`/Engine/Deck${i}/DeckIsMaster`, deckIsMaster);
    // 	}

    // 	service.subscribe();
    // });

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