// Passenger startup file (PassengerStartupFile server.js). Also `node server.js` in Docker/dev.
// Keeps the entry tiny so a broken build shows a readable error in Passenger's log instead of a blank 500.
import('./dist/index.js')
  .then(m => m.main())
  .catch(err => {
    console.error('[pathshala] failed to start:', err);
    // Passenger restarts on exit; give the log a moment to flush.
    setTimeout(() => process.exit(1), 200);
  });
