import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../native/host.js';
import { startClient } from '../native/launcher.js';

export async function runSafariHost({ input = process.stdin, output = process.stdout, launch = startClient } = {}) {
  const reader = createInterface({ input, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  async function receive() {
    const { value, done } = await lines.next();
    if (done || value.length > 8192) throw new Error('Invalid or incomplete Safari helper request.');
    return JSON.parse(value);
  }
  function send(message) {
    return new Promise((resolve, reject) => {
      output.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve());
    });
  }
  try {
    const request = await receive();
    const response = await handleRequest(request, options => launch({
      ...options,
      chooseDirectory: async () => {
        await send({ type: 'choose-folder' });
        const reply = await receive();
        if (!reply || typeof reply !== 'object' || Array.isArray(reply) ||
            Object.keys(reply).length !== 1 || !Object.hasOwn(reply, 'directory') ||
            (reply.directory !== null && (typeof reply.directory !== 'string' || !path.isAbsolute(reply.directory)))) {
          throw new Error('The Safari folder picker returned an invalid response.');
        }
        if (reply.directory === null) throw new Error('Folder selection canceled. No download was started.');
        return reply.directory;
      }
    }));
    await send({ type: 'result', response });
    return response;
  } catch (error) {
    console.error('Safari native helper failed:', error);
    const response = { ok: false, error: error.message };
    await send({ type: 'result', response });
    return response;
  } finally {
    reader.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSafariHost().then(response => { process.exitCode = response.ok ? 0 : 1; }).catch(error => {
    console.error('Safari native protocol failed:', error);
    process.exitCode = 1;
  });
}
