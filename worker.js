const { workerData, parentPort } = require("worker_threads");
let x = 0;
for (let i = 0; i < 1000000; i++) {
  for (let g = 0; g < 1000000; g++) {
    x = i + g;
  }
}
parentPort.postMessage(x);
