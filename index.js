const cluster = require("cluster");
const crypto = require("crypto");
// I am a child, I am going to act like a server
// and do nothing else
const express = require("express");
const app = express();

const { Worker } = require("worker_threads");

function runService(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("./worker.js", { workerData });
    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0)
        reject(
          new Error(`Stopped the Worker Thread with the exit code: ${code}`)
        );
    });
  });
}

async function run(res) {
  const result = await runService("GeeksForGeeks");
  result && res.send(`${result}`);
  console.log(result);
}

app.get("/", (req, res) => {
  run(res).catch((err) => console.error(err));
});

app.get("/fast", (req, res) => {
  res.send("This was fast!!");
});

app.listen(3000);
