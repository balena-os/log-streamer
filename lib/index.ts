import * as https from 'https';
import { promisify } from 'util';
import * as url from 'url';
import * as zlib from 'zlib';
import * as stream from 'stream';
import * as pThrottle from 'p-throttle';

export type LogMessage = { [key: string | number | symbol]: any };

export type Logger = (message: LogMessage) => void;

export class LoggerError extends Error { }

const ZLIB_TIMEOUT = 100;
const MAX_PENDING_BYTES = 256 * 1024;
const RESPONSE_GRACE_PERIOD = 5 * 1000;

const sleep = promisify(setTimeout);
export async function Logger(
	endpoint: string,
	secret: string,
): Promise<Logger> {
	const throttle = pThrottle({ limit: 1, interval: ZLIB_TIMEOUT });

	return new Promise(async (resolve, reject) => {
		const req = https.request({
			...url.parse(endpoint),
			method: 'POST',
			headers: {
				Authorization: `Bearer ${secret}`,

				'Content-Type': 'application/x-ndjson',
				'Content-Encoding': 'gzip',
			},
		});

		// Since we haven't sent the request body yet, and never will,the
		// only reason for the server to prematurely respond is to
		// communicate an error. So teardown the connection immediately
		req.on('response', (res) => {
			reject(
				new LoggerError(
					`Received response from log backend with status code: ${res.statusCode}`,
				),
			);
		});
		req.on('timeout', () => {
			reject(
				new LoggerError(
					`Request timed out when trying to connect to the log backend`,
				),
			);
		});
		req.on('close', () => {
			reject(
				new LoggerError(`Request to the log backend terminated prematurely`),
			);
		});
		req.on('error', (cause) => {
			reject(
				new LoggerError(`Request to the log backend terminated prematurely`, {
					cause,
				}),
			);
		});

		// Immediately flush the headers. This gives a chance to the server to
		// respond with potential errors such as 401 authentication error
		req.flushHeaders();

		// We want a very low writable high watermark to prevent having many
		// chunks stored in the writable queue of @_gzip and have them in
		// @_stream instead. This is desirable because once @_gzip.flush() is
		// called it will do all pending writes with that flush flag. This is
		// not what we want though. If there are 100 items in the queue we want
		// to write all of them with Z_NO_FLUSH and only afterwards do a
		// Z_SYNC_FLUSH to maximize compression
		const gzip = zlib.createGzip();
		gzip.on('error', (cause) => {
			gzip.end();
			reject(new LoggerError(`Failed to create gzip stream`, { cause }));
		});
		gzip.pipe(req);

		// This stream serves serves as a message buffer during reconnections
		// while we unpipe the old, malfunctioning connection and then repipe a
		// new one.
		const log = new stream.PassThrough({
			allowHalfOpen: true,

			// We halve the high watermark because a passthrough stream has two
			// buffers, one for the writable and one for the readable side. The
			// write() call only returns false when both buffers are full.
			highWaterMark: MAX_PENDING_BYTES / 2,
		});

		let writable = true;
		let dropCount = 0;

		// Flushing every ZLIB_TIMEOUT hits a balance between compression and
		// latency. When ZLIB_TIMEOUT is 0 the compression ratio is around 5x
		// whereas when ZLIB_TIMEOUT is infinity the compession ratio is around 10x.
		const flush = throttle(() => {
			gzip.flush(zlib.constants.Z_SYNC_FLUSH);
		});

		const write = (msg: LogMessage) => {
			if (writable) {
				try {
					// the line end is necessary for ndjson
					writable = log.write(JSON.stringify(msg) + '\n');
					flush();
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

		log.on('drain', () => {
			writable = true;
			flush();
			if (dropCount > 0) {
				write({
					message: `Warning: Suppressed ${dropCount} message(s) due to high load`,
					timestamp: Date.now(),
					isSystem: true,
					isStdErr: true,
				});
				dropCount = 0;
			}
		});

		// Only start piping if there has been no error after the header flush.
		// Doing it immediately would potentially lose logs if it turned out that
		// the server is unavailalbe because @_req stream would consume our
		// passthrough buffer
		await sleep(RESPONSE_GRACE_PERIOD);

		// Pipe log output to gzip
		log.pipe(gzip);

		// Return the write function
		resolve(write);
	});
}

const WAIT = parseInt(process.env.WAIT || '1000', 10);

const UUID = 'ed14dae57b050cf3caa99ebe4cedcbbe';
const SECRET = 'mysecret';
const BACKEND = 'https://api.balena-staging.com';
// const UUID = '112d2bcc8bb14ee3bec5e76874eef091';
// const SECRET = 'my secret';
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
