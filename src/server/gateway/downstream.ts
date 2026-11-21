type DownstreamResponse = {
  on(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
  writableEnded: boolean;
  destroyed?: boolean;
  closed?: boolean;
};

/** Observe downstream closure, including a close that happened before registration. */
export function watchDownstreamDisconnect(
  response: DownstreamResponse,
  onDisconnect: () => void,
): () => void {
  let disconnected = false;
  const handleClose = () => {
    // ServerResponse emits close after a normal end too. That is not a disconnect.
    if (disconnected || response.writableEnded) return;
    disconnected = true;
    onDisconnect();
  };

  // Register first, then inspect state: this closes the gap where close fires just
  // before registration without leaving a race between the check and the listener.
  response.on('close', handleClose);
  if (response.destroyed || response.closed) handleClose();

  return () => response.off('close', handleClose);
}
