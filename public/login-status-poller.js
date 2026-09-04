export function createAsyncTerminalPoller({ read, handle }) {
  let inFlight = false;
  let terminalHandled = false;

  return async function poll() {
    if (terminalHandled) return true;
    if (inFlight) return false;

    inFlight = true;
    try {
      const status = await read();
      terminalHandled = Boolean(await handle(status));
      return terminalHandled;
    } finally {
      inFlight = false;
    }
  };
}
