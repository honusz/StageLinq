import { strict as assert } from 'assert';
import { sleep } from './utils/sleep';
import { Controller } from './Controller';
import { announce, unannounce } from './announce';
import { FileTransfer, StateMap } from './services';
//import * as fs from 'fs';
import minimist = require('minimist');

require('console-stamp')(console, {
	format: ':date(HH:MM:ss) :label',
});

async function main() {
	//const args = minimist(process.argv.slice(2));
	const controller = new Controller();
	
	const listenPort = await controller.discoveryListen();
	
	announce(listenPort);

	// Endless loop
	while (true) {
		await sleep(250);
	}
}

(async () => {
	let returnCode = 0;
	try {
		process.on('SIGINT', async function () {
			console.info('... exiting');
			// Ensure SIGINT won't be impeded by some error
			try {
				await unannounce();
			} catch (err) {
				const message = err.stack.toString();
				console.error(message);
			}
			process.exit(returnCode);
		});

		// FIXME: main should be called when we found a device; not after waiting some random amount of time
		await sleep(500);
		await main();
	} catch (err) {
		const message = err.stack.toString();
		console.error(message);
		returnCode = 1;
	}

	await unannounce();
	process.exit(returnCode);
})();
