'use strict';
// Container health check: the worker touches the heartbeat file every 10 seconds.
const fs = require('fs');
try {
  const age = Date.now() - parseInt(fs.readFileSync('/tmp/worker-heartbeat', 'utf8'), 10);
  process.exit(age < 45000 ? 0 : 1);
} catch (_) {
  process.exit(1);
}
