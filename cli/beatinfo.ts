#!/usr/bin/env node
/**
 * StageLinq BeatInfo CLI Tool
 *
 * Connects to a StageLinq device and displays real-time beat information.
 *
 * Usage: npx ts-node cli/beatinfo.ts
 *
 * Note: This tool requires a StageLinq-compatible device on the network.
 */

import { StageLinqInstance } from '../StageLinq';
import { ActingAsDevice } from '../types';
import { sleep } from '../utils/sleep';
import { formatToken } from '../utils/token';

require('console-stamp')(console, {
  format: ':date(HH:MM:ss) :label',
});

async function main() {
  console.log('StageLinq BeatInfo Demo');
  console.log('=======================');
  console.log('');
  console.log('Connecting to StageLinq network...');

  const stageLinq = new StageLinqInstance({
    actingAs: ActingAsDevice.NowPlaying,
    downloadDbSources: false,
    enableBeatInfo: true,
    maxRetries: 3,
    logger: {
      trace: () => {},
      debug: (msg: string, ...args: unknown[]) => console.debug(msg, ...args),
      info: (msg: string, ...args: unknown[]) => console.info(msg, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(msg, ...args),
      error: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
    },
  });

  // Track connection
  stageLinq.devices.on('connected', (info) => {
    console.log(`Connected to: ${info.software.name} (${info.address}:${info.port})`);
  });

  stageLinq.devices.on('ready', () => {
    console.log('');
    console.log('Ready! Listening for beat information...');
    console.log('Press Ctrl+C to exit.');
    console.log('');
  });

  stageLinq.devices.on('beatMessage', (connectionInfo, msg) => {
    let decks:string = "";
    try {
      decks = JSON.stringify(msg?.message?.decks);
    } catch (err) {
      console.error(err);
    }
    console.log(`BEATINFO [${formatToken(connectionInfo.token)}] ${JSON.stringify(msg)}`);
  });

  // Display now playing info
  stageLinq.devices.on('nowPlaying', (status) => {
    console.log('');
    console.log(`Now Playing on ${status.deck}:`);
    console.log(`  Title:  ${status.title}`);
    console.log(`  Artist: ${status.artist}`);
  });

  // Display state changes (includes beat/BPM info)
  stageLinq.devices.on('stateChanged', (status) => {
    // Only show if we have BPM info
    if (status.currentBpm) {
      const playState = status.playState ? 'playing' : 'paused';
      process.stdout.write(
        `\r[${status.deck}] BPM: ${status.currentBpm.toFixed(1).padStart(6)} | ` +
        `State: ${playState.padEnd(10)}`
      );
    }
  });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\nShutting down...');
    try {
      await stageLinq.disconnect();
    } catch (err) {
      console.error('Error during disconnect:', err);
    }
    process.exit(0);
  });

  // Connect and run
  try {
    await stageLinq.connect();

    // Keep running
    while (true) {
      await sleep(1000);
    }
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
