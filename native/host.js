import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startClient } from './launcher.js';

export async function readMessage(input) {
  // Chromium frames native messages with a four-byte little-endian payload length.
  let buffer = Buffer.alloc(0);
  let length;
  const timeout = setTimeout(() => input.destroy(new Error('Native request timed out.')), 10000);
  try {
    for await (const chunk of input) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 4 && length === undefined) {
        length = buffer.readUInt32LE(0);
        if (length < 2 || length > 4096) throw new Error('Invalid native request size.');
      }
      if (length !== undefined && buffer.length >= length + 4) {
        if (buffer.length !== length + 4) throw new Error('Only one native request is accepted.');
        return JSON.parse(buffer.subarray(4).toString('utf8'));
      }
    }
    throw new Error('Incomplete native request.');
  } finally {
    clearTimeout(timeout);
  }
}

export function writeMessage(output, message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return new Promise((resolve, reject) => {
    output.write(Buffer.concat([header, payload]), error => error ? reject(error) : resolve());
  });
}

export async function handleRequest(request, launch = startClient) {
  if (!request || typeof request !== 'object' ||
      request.action !== 'start-client' || Object.keys(request).length !== 1) {
    throw new Error('Only the start-client action is supported.');
  }
  return { ok: true, ...await launch() };
}

async function main() {
  let response;
  try {
    response = await handleRequest(await readMessage(process.stdin));
  } catch (error) {
    console.error(error);
    response = { ok: false, error: error.message };
    process.exitCode = 1;
  }
  await writeMessage(process.stdout, response);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
