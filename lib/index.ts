import { promisify } from 'util';
import * as zlib from 'zlib';
import got from 'got';

export type LogMessage = { [key: string | number | symbol]: any };

export type Logger = (message: LogMessage) => void;

export class LoggerError extends Error {}

const sleep = promisify(setTimeout);

const RESPONSE_GRACE_PERIOD = 5 * 1000;

export async function Logger(url: string, secret: string): Promise<Logger> {
	const gzip = zlib.createGzip();

	const req = got.stream.post(url, {
		http2: true,
		headers: {
			Authorization: `Bearer ${secret}`,
			'Content-Type': 'application/x-ndjson',
			'Content-Encoding': 'gzip',
		},
		timeout: {
			// See https://github.com/sindresorhus/got/blob/5f278d74125608b7abe75941cb6a71e21e0fb892/documentation/6-timeout.md
			lookup: 100,
			connect: 50,
			secureConnect: 50,
			socket: 2000,
			response: 1000,
		},
	});

	let writable = true;
	let dropCount = 0;

	const write = (msg: LogMessage) => {
		if (writable) {
			try {
				// the line end is necessary for ndjson
				writable = gzip.write(JSON.stringify(msg) + '\n');
				gzip.flush();
			} catch (e: any) {
				console.error('Failed to write to logging stream, dropping message', e);
			}
		} else {
			dropCount++;
		}
	};

	gzip.on('drain', () => {
		writable = true;
		if (dropCount > 0) {
			write({
				message: `Warning: Suppressed ${dropCount} message(s) due to high load`,
				timestamp: Date.now(),
				isSystem: true,
				isStdErr: true,
			});
			dropCount = 0;
		}
		gzip.flush();
	});

	// Only start piping if there has been no error after the header flush.
	// Doing it immediately would potentially lose logs if it turned out that
	// the server is unavailalbe because @_req stream would consume our
	// passthrough buffer
	await sleep(RESPONSE_GRACE_PERIOD);

	gzip.pipe(req);

	return write;
}

const WAIT = parseInt(process.env.WAIT || '1000', 10);
//
const UUID = '43aebb844b9240f6b8702ecadb846f81';
const SECRET = 'D75GGljZ1dA3GrInZIA22p3zYZZH6Faf';
const BACKEND = 'https://api.balena-staging.com';
// const UUID = '112d2bcc8bb14ee3bec5e76874eef091';
// const SECRET = 'aS8SPCdTN1DyYmRBcSlzY6K2T04CHJxN';
// const BACKEND = 'https://api.balena-cloud.com';
const LOG_STREAM = `${BACKEND}/device/v2/${UUID}/log-stream`;
(async () => {
	const log = await Logger(LOG_STREAM, SECRET);

	let count = 0;
	while (true) {
		console.log(`Count: ${count}`);
		log({
			message: `Count: ${count++}`,
			timestamp: Date.now(),
			isSystem: true,
			isStdErr: true,
		});
		await sleep(WAIT);
	}
})();
