import { createPreviewAdmission } from '../../../src/dashboardSimple/previewAdmission.js';

const pendingRequests = new Map();
const heldLeases = new Map();
let requestSequence = 0;
function invokeAuthority(operation, argumentsValue) {
  return new Promise((resolve, reject) => {
    const rpcId = ++requestSequence;
    pendingRequests.set(rpcId, { resolve, reject });
    process.send({ kind: 'rpc', rpcId, operation, argumentsValue }, error => {
      if (!error) return;
      pendingRequests.delete(rpcId);
      reject(error);
    });
  });
}
const coordinator = {
  async tryAcquire(argumentsValue) {
    const leaseId = await invokeAuthority('acquire', argumentsValue);
    return { release: () => invokeAuthority('release', { leaseId }) };
  },
};
const admission = createPreviewAdmission({ coordinator, processId: String(process.pid), poolMax: Number(process.argv[2]) });
process.on('message', async message => {
  if (message.kind === 'rpcResult') {
    const pending = pendingRequests.get(message.rpcId);
    if (!pending) return;
    pendingRequests.delete(message.rpcId);
    if (message.error) pending.reject(Object.assign(new Error(message.error.code), message.error));
    else pending.resolve(message.value);
    return;
  }
  if (message.kind !== 'command') return;
  try {
    if (message.operation === 'acquire') {
      const lease = await admission.tryAcquire({ userId: message.userId });
      heldLeases.set(message.userId, lease);
    } else if (message.operation === 'release') {
      const lease = heldLeases.get(message.userId);
      if (!lease) throw new Error('Missing held lease');
      await lease.release();
      heldLeases.delete(message.userId);
    } else if (message.operation === 'cleanupFailure') {
      if (!heldLeases.has(message.userId)) throw new Error('Missing held lease');
      throw new Error('Cleanup unconfirmed');
    } else if (message.operation !== 'abort') {
      throw new Error('Unknown worker command');
    }
    process.send({ kind: 'commandResult', commandId: message.commandId, value: { pid: process.pid, processLimit: admission.processLimit } });
  } catch (error) {
    process.send({ kind: 'commandResult', commandId: message.commandId, error: { message: error.message, code: error.code, status: error.status, retryAfter: error.retryAfter } });
  }
});
process.send({ kind: 'ready', pid: process.pid });
