import { NetworkDevice } from '../network';
import { FileTransfer } from '../services';
import { makeTempDownloadPath } from "./makeDownloadPath";
import { strict as assert } from 'assert';
import * as fs from 'fs';
import minimist = require('minimist');
import { Logger } from '../LogEmitter';

export async function maybeDownloadFiles(controller: NetworkDevice) {
	const args = minimist(process.argv.slice(2));
	if (!args.disableFileTransfer) {
		const ftx = await controller.connectToService(FileTransfer);
		assert(ftx);
		const sources = await ftx.getSources();
		{
			const sync = !args.skipsync;
			for (const source of sources) {
				const dbPath = makeTempDownloadPath(source.database.location);
				// FIXME: Move all this away from main
				if (sync) {
					const file = await ftx.getFile(source.database.location);
					fs.writeFileSync(dbPath, file);
					Logger.info(`downloaded: '${source.database.location}' and stored in '${dbPath}'`);
				}
				await controller.addSource(source.name, dbPath, makeTempDownloadPath(`${source.name}/Album Art/`));

				if (sync) {
					await controller.dumpAlbumArt(source.name);
				}
			}
			ftx.disconnect();
		}
	}
}