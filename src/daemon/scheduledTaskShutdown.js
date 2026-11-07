// Stop accepting control requests first; a request already waiting for an
// Agent launch must not make HTTP server shutdown wait without a deadline.
export async function closeScheduledTaskApi(localApi, scheduler, {timeoutMs = 5000} = {}) {
  const closing = localApi.close();
  let drained = false;
  try {
    drained = await scheduler.drain(timeoutMs);
  } finally {
    localApi.server.closeAllConnections();
    await closing;
  }
  return drained;
}
