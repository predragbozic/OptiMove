const validIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function previewBusy() {
  return Object.assign(new Error('previewBusy'), { code: 'previewBusy', status: 429, retryAfter: 1 });
}

export function createPreviewAdmissionCoordinator({ maxActiveDeployment } = {}) {
  if (!positiveInteger(maxActiveDeployment)) throw new TypeError('Explicit positive deployment preview budget required');
  const activeUsers = new Set();
  const activeProcesses = new Map();
  let activeDeployment = 0;
  function tryAcquire(request = {}) {
    if (!request || typeof request !== 'object') throw previewBusy();
    const { userId, processId, processLimit } = request;
    if (!validIdentity(userId) || !validIdentity(processId) || !positiveInteger(processLimit) || processLimit > 2) throw previewBusy();
    const processState = activeProcesses.get(processId);
    if (activeUsers.has(userId) || activeDeployment >= maxActiveDeployment
      || processState && (processState.limit !== processLimit || processState.active >= processLimit)) throw previewBusy();
    const acquiredProcess = processState ?? { active: 0, limit: processLimit };
    acquiredProcess.active += 1;
    activeProcesses.set(processId, acquiredProcess);
    activeUsers.add(userId);
    activeDeployment += 1;
    let released = false;
    function release() {
      if (released) return;
      released = true;
      activeUsers.delete(userId);
      acquiredProcess.active -= 1;
      activeDeployment -= 1;
      if (acquiredProcess.active === 0) activeProcesses.delete(processId);
    }
    return Object.freeze({ release });
  }
  return Object.freeze({ tryAcquire });
}

export function createPreviewAdmission({ coordinator, processId, poolMax, coordinatorTimeoutMs = 500 } = {}) {
  if (!coordinator || typeof coordinator.tryAcquire !== 'function' || !validIdentity(processId)
    || !positiveInteger(poolMax) || !positiveInteger(coordinatorTimeoutMs) || coordinatorTimeoutMs > 1000) throw new TypeError('Trusted bounded preview coordinator, process identity and pool maximum required');
  const processLimit = Math.min(2, Math.floor((poolMax - 1) / 2));
  async function tryAcquire(request = {}) {
    if (!request || typeof request !== 'object') throw previewBusy();
    const { userId } = request;
    if (!validIdentity(userId) || processLimit < 1) throw previewBusy();
    let acquiredLease;
    let timer;
    const pendingLease = Promise.resolve().then(() => coordinator.tryAcquire({ userId, processId, processLimit }));
    try {
      acquiredLease = await Promise.race([pendingLease, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(previewBusy()), coordinatorTimeoutMs);
      })]);
    } catch {
      pendingLease.then(lease => lease?.release?.()).catch(() => {});
      throw previewBusy();
    } finally {
      clearTimeout(timer);
    }
    if (!acquiredLease || typeof acquiredLease.release !== 'function') throw previewBusy();
    let released = false;
    let releasing = null;
    async function release() {
      if (released) return;
      if (releasing) return releasing;
      releasing = Promise.resolve().then(() => acquiredLease.release());
      try {
        await releasing;
        released = true;
      } finally {
        releasing = null;
      }
    }
    return Object.freeze({ release });
  }
  return Object.freeze({ tryAcquire, processLimit });
}
