import * as https from 'https';
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
	return new Promise(async (resolve) => {
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
					'Keep-Alive': `timeout=${REQUEST_TIMEOUT / 1000}`,
				},
			},
			(res) => {
				res.on('data', (chunk) => console.log('Received ping', chunk));
			},
		);

		// Since we haven't sent the request body yet, and never will,the
		// only reason for the server to prematurely respond is to
		// communicate an error. So teardown the connection immediately
		req.on('response', (res) => {
			throw new LoggerError(
				`Received response from log backend with status code: ${res.statusCode}`,
				{ cause: res },
			);
		});
		req.on('timeout', () => {
			throw new LoggerError(
				`Request timed out when trying to connect to the log backend`,
			);
		});
		req.on('close', () => {
			throw new LoggerError(
				`Request to the log backend terminated prematurely`,
			);
		});
		req.on('error', (cause) => {
			throw new LoggerError(
				`Request to the log backend terminated with unknown error`,
				{
					cause,
				},
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
				throw new LoggerError(`Failed to create gzip stream`, { cause });
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

if (!process.env.UUID) {
	throw new Error(
		'Please provide a UUID environment variable with the device identifier',
	);
}
const UUID = process.env.UUID;

if (!process.env.API_KEY) {
	throw new Error(
		'Please provide an API_KEY environment variable with the device credentials',
	);
}
const API_KEY = process.env.API_KEY;

const API_ENDPOINT = process.env.API_ENDPOINT || 'https://api.balena-cloud.com';
const LOG_STREAM = `${API_ENDPOINT}/device/v2/${UUID}/log-stream`;
const INITIAL_DELAY = parseInt(process.env.INITIAL_DELAY || '0', 10);
(async () => {
	const log = await Logger(LOG_STREAM, API_KEY);
	const serviceIds = process.env.SERVICE_ID
		? process.env.SERVICE_ID.split(',')
				.filter((s) => !!s)
				.map((s) => parseInt(s.trim(), 10))
		: [];

	let count = 0;
	let delay = INITIAL_DELAY;
	while (true) {
		const now = new Date();
		const message = `${now.toUTCString()} - Test message No. ${count++}. Next message in ${++delay}(s)`;

		// Send the same message to the stdout and the backend
		console.log(message);
		if (serviceIds.length > 0) {
			for (const serviceId of serviceIds) {
				log({
					message,
					timestamp: now.valueOf(),
					serviceId,
					isSystem: false,
					isStdErr: false,
				});
			}
		} else {
			log({
				message,
				timestamp: now.valueOf(),
				isSystem: true,
				isStdErr: false,
			});
		}

		// We increase delay in a linear rate
		await sleep(delay * 1000);
	}
})();
