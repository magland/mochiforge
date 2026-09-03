import * as fs from 'fs';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';

// A response body written to a file, with a ceiling.
//
// The two callers fetch archives -- an action's source from a forge, a node
// build from nodejs.org -- and used to read each whole into one Buffer before
// writing it out. The size of that Buffer was whatever the far end chose to
// serve, and a `uses:` line names the far end, so a workflow could point the
// runner at a tarball the size of its memory. Streaming through a counter
// bounds the transfer at the cap and costs one chunk of memory at a time.

export class DownloadTooLarge extends Error {}

export async function downloadTo(res: Response, file: string, maxBytes: number): Promise<void> {
  if (!res.body) throw new Error('the response had no body');
  // A declared length over the cap is refused before a byte is read; a body
  // that declares less than it sends, or nothing, is caught as it arrives.
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new DownloadTooLarge(`${declared} bytes, over the limit of ${maxBytes}`);
  let seen = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) callback(new DownloadTooLarge(`more than ${maxBytes} bytes`));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), cap, fs.createWriteStream(file));
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
}
