import { ActingAsDevice, StageLinqOptions, Services, DeviceId } from '../types';
import { Broadcast } from '../services';
import { sleep } from '../utils/sleep';
import { StageLinq } from '../StageLinq';


async function main() {

    const stageLinqOptions: StageLinqOptions = {
        //downloadDbSources: true,
        actingAs: ActingAsDevice.NowPlaying,
        services: [
            Services.FileTransfer,
            Services.Broadcast
        ],
    }

    const stageLinq = new StageLinq(stageLinqOptions);


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

    Broadcast.emitter.on('message', async (deviceId: DeviceId, name: string, value) => {
        console.log(`[BROADCAST] ${deviceId.string} ${name}`, value);
    });

    let arr = Uint8Array.from([1, 1, 0])
    let bin = arr.reduce(
        (a, bit, i, arr) => a + (bit ? Math.pow(2, arr.length - i - 1) : 0),
        0
    );
    console.warn(arr, bin)

    arr = Uint8Array.from([0, 1, 0])
    bin = arr.reduce(
        (a, bit, i, arr) => a + (bit ? Math.pow(2, arr.length - i - 1) : 0),
        0
    );
    console.warn(arr, bin)

    arr = Uint8Array.from([1, 1, 1])
    bin = arr.reduce(
        (a, bit, i, arr) => a + (bit ? Math.pow(2, arr.length - i - 1) : 0),
        0
    );
    console.warn(arr, bin)

    arr = Uint8Array.from([1, 0, 1])
    bin = arr.reduce(
        (a, bit, i, arr) => a + (bit ? Math.pow(2, arr.length - i - 1) : 0),
        0
    );
    console.warn(arr, bin)

    //const red = arr.reduce((acc, val) => acc << val);
    // console.warn('1,1,1 ', Buffer.from([0x01, 0x01, 0x01]).reduce((acc, val) => acc & val))
    // console.warn('0,1,1 ', Buffer.from([0x00, 0x01, 0x01]).reduce((acc, val) => acc & val))

    // console.warn('0,1,0 ', Uint8Array.from([0, 1, 0]).map((val) => val ? 1 : 0))
    // const val = Uint8Array.from([0, 1, 0]).map((val) => val ? 1 : 0)

    // console.warn(0 >> 1)

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