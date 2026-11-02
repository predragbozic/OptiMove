export function observeCheckedOutClient(client) {
  let failure, rejectFailure, released = false;
  const failed = new Promise((resolve, reject) => { rejectFailure = reject; });
  failed.catch(() => {});
  const disconnected = () => {
    if (released || failure) return;
    failure = Object.assign(new Error('Database connection lost'), { code: 'connectionLost', status: 503 });
    rejectFailure(failure);
  };
  client.on?.('error', disconnected);
  client.on?.('end', disconnected);
  return {
    check() { if (failure) throw failure; },
    run(operation) {
      if (failure) return Promise.reject(failure);
      return Promise.race([Promise.resolve().then(() => { if (failure) throw failure; return operation(); }), failed]);
    },
    release(destroy = false) {
      if (released) return;
      released = true;
      try { client.release(destroy || Boolean(failure)); }
      finally {
        client.removeListener?.('error', disconnected);
        client.removeListener?.('end', disconnected);
      }
    },
  };
}

export function checkoutObservedClient(pool) {
  return new Promise((resolve, reject) => {
    let received = false;
    const accept = (error, client) => {
      if (received) return;
      received = true;
      if (error) { reject(error); return; }
      try { resolve({ client, lifecycle: observeCheckedOutClient(client) }); }
      catch (failure) { client?.release(true); reject(failure); }
    };
    try {
      const pending = pool.connect(accept);
      if (pending && typeof pending.then === 'function') pending.then(client => accept(null, client), accept);
    } catch (error) { accept(error); }
  });
}
