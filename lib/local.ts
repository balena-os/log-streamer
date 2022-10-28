import * as https from 'http';
import { promisify } from 'util';
import * as zlib from 'zlib';
import { pipeline } from 'stream';

export type LogMessage = { [key: string | number | symbol]: any };

export type Logger = (message: LogMessage) => void;

export class LoggerError extends Error {}

const RESPONSE_GRACE_PERIOD = 5 * 1000;
const REQUEST_TIMEOUT = 59 * 1000;

const sleep = promisify(setTimeout);
export async function Logger(url: string, secret: string): Promise<Logger> {
	return new Promise(async (resolve, reject) => {
		const req = https.request(
			url,
			{
				method: 'POST',
				timeout: REQUEST_TIMEOUT,
				agent: false,
				headers: {
					Authorization: `Bearer ${secret}`,
					'Content-Type': 'application/x-ndjson',
					'Content-Encoding': 'gzip',
				},
			},
			(res) => {
				res.on('data', (chunk) => console.log(chunk));
			},
		);

		// Since we haven't sent the request body yet, and never will,the
		// only reason for the server to prematurely respond is to
		// communicate an error. So teardown the connection immediately
		req.on('response', (res) => {
			console.error('Received response', res.statusCode);
			reject(
				new LoggerError(
					`Received response from log backend with status code: ${res.statusCode}`,
				),
			);
		});
		req.on('timeout', () => {
			console.error('Request timed out');
			reject(
				new LoggerError(
					`Request timed out when trying to connect to the log backend`,
				),
			);
		});
		req.on('close', () => {
			console.error('Request closed');
			reject(
				new LoggerError(`Request to the log backend terminated prematurely`),
			);
		});
		req.on('error', (cause) => {
			console.error('Request error', cause);
			reject(
				new LoggerError(`Request to the log backend terminated prematurely`, {
					cause,
				}),
			);
		});

		// Immediately flush the headers. This gives a chance to the server to
		// respond with potential errors such as 401 authentication error
		req.flushHeaders();

		const gzip = zlib.createGzip({
			flush: zlib.constants.Z_SYNC_FLUSH,
			writableHighWaterMark: 1024,
		} as any);

		pipeline(gzip, req, (cause) => {
			if (cause) {
				req.end();
				console.error('Gzip error', cause);
				reject(new LoggerError(`Failed to create gzip stream`, { cause }));
			}
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
					console.error(
						'Failed to write to logging stream, dropping message',
						e,
					);
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

		// Return the write function
		resolve(write);
	});
}

const WAIT = parseInt(process.env.WAIT || '1000', 10);

const UUID = '43aebb844b9240f6b8702ecadb846f81';
const SECRET = 'D75GGljZ1dA3GrInZIA22p3zYZZH6Faf';
const BACKEND = 'http://localhost:3000';
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
