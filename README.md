# Internals of Node

## Node.js structure

Node.js is structured in the following order.

1. Javascript code
2. Node.js Javascript side (lib in Node.js)
   - process.binding() connects JS and C++ functions
   - v8 converts values between JS and C++
3. Node.js C++ side (src folder in Node.js)
4. libuv gives node easy access to underlying OS

## Threads & Process

Process is an instance of computer program that is being executed w/in a single process.  
Thread is like a list of instructions that needs to be executed by the CPU  
A single process can have multiple threads in it.  
Scheduling is OS's ability to decide which instructions to run
rate of processing threads can be increased by more cores or better scheduling by OS

## Event Loop

Below is a psudocode that deomonsrates the logic of an event loop

```
// node myFile.js
const pendingTImers = [];
const pendingOSTasks = [];
const pendingOperations = [];

// New timers, tasks, operations are recorded from as myFile runs
myFile.runContents();

function shouldContinue() {
   // Check one: Any pending setTimeout, setInterval. setImmediate
   // Check two: Any pending OS tasks (i.e Server listening to port)
   // Check three: Any pending long running operations (i.e fs module)
}

//Entier body executes in one 'tick'

while(shouldContinue()) {
   // 1) Node looks at pendingTimers and sees if any functions are ready to be called

   // 2) Node looks at pendingOSTasks and pendingOperations and calls relevant callbacks

   // 3) Pause execution. Continue when...
   //    - a new pendingOSTask is done
   //    - a new pendingOperation is done
   //    - a timer is about to complete

   // 4) Look at pendingTimers. Call any setImmediate

   // 5) Handle any 'close' events'
         - i.e readStream.on('close), () => { console.log('cleanup code');}
}

exit back to the terminal
```

## is Node Single Threaded?

Yes and No. Node Event Loops is indeed single threaded. However, some of node frameworks and standard libraries are not single threaded.

Test by running this code

```javascript
const crypto = require("crypto");

const start = Date.now();

for (let i = 0; i < 2; i++) {
  crypto.pbkdf2("a", "b", 100000, 512, "sha512", () => {
    console.log(`${i} ${Date.now() - start}`);
  });
}
```

Both of pbkdf2 calls finish at the same time. For some std lib function calls the node C++ side and libuv decide to do heavy calculation using thread pool outside of event loop entierly which has four threads in it.

If you call more than 4 pbkdf2 at the same time. Up to 4 of the pbkdf2 calls gets assigned to thread pool then it gets assigned to each logical core in the CPU. Therefore resulting this in laptop with 6 cores of CPU with 6 logical processors.

3 502  
2 510  
1 516  
0 518  
4 949

However if you have less than 4 logical processors or cores, all 4 threads cannot run simultaneously.

```javascript
process.env.UV_THREADPOOL_SIZE = 2;
const crypto = require("crypto");

const start = Date.now();

for (let i = 0; i < 2; i++) {
  crypto.pbkdf2("a", "b", 100000, 512, "sha512", () => {
    console.log(`${i} ${Date.now() - start}`);
  });
}
```

you can change the thread pool size by adding above line on the of the code. Then running the code results in.

1 437  
0 440  
2 873  
3 876  
4 1310

If you add more threads than your logical cores, the OS scheduler manages to juggle these threads so that they end at about same time.

### Questions

We can write custom JS to use the thread pool  
All 'fs' module functions some crypto uses threadpool but these are all OS dependent ( windows vs unix based)  
Tasks running in the threadpool are the 'pendingOperations' in our code exampple

## OS Operations

When you execute this code block, which simple calls http request to google.com

```javascript
const https = require("https");

const start = Date.now();

function doRequest() {
  https
    .request("https://www.google.com", (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        console.log(Date.now() - start);
      });
    })
    .end();
}

doRequest();
doRequest();
doRequest();
doRequest();
doRequest();
doRequest();
```

The result is as follows,  
290  
303  
303  
304  
306  
323  
This is because neither node nor libuv actually does network requests but rather delegates the work to the operating system to do this low level stuff. Because OS does all the work, we are neither touching the thread pool nor blocking any of our javascript code.

Almost all networking functions in node std library use the OS's async features. But some others are OS Specific.
These os async stuff fit in the event loop reside in the 'pendingOSTasks' array

## Multitasking internal of Node

```javascript
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const start = Date.now();
const i = 1;

function doRequest() {
  https
    .request("https://www.google.com", (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        console.log(Date.now() - start);
      });
    })
    .end();
}

function doHash() {
  crypto.pbkdf2("a", "b", 100000, 512, "sha512", () => {
    console.log(`${i} ${Date.now() - start}`);
  });
}

doRequest();

fs.readFile("multitask.js", "utf8", () => {
  console.log("FS: ", Date.now() - start);
});

doHash();
doHash();
doHash();
doHash();
```

Above combines Http request, hashing and reading from a file. Running this from a console shows
301  
1 503  
FS: 504  
1 505  
1 506  
1 512

Http runs first then one of the hashing gets finished then fs. Notice how slow FS is compared to running it alone. If you run fs without hashing fs is executed in 14 ms.

Http request runs in the OS so it does not affect other fs and hashing calls. 4 hashing and 1 fs are assigned to the thread pool. so fs takes thread 1 and hashing 1,2,3 takes the rest. However, fs actually requires two roundtrip to the hdd. it first gets the file stat, then it actually fetches the file.

So as thread 1 reaches out to hdd for stat, it immediately expects it to be slower task, so rather than waiting for file stat to return, it holds the fs task and runs remaining 1 hashing task. Meanwhile, one of the hashing from other 3 threads gets finished and prints out the result. Which leaves 1 thread empty. So it sees if there's any other task it can do.

It fetches the fs task that's been pushed back, since there are no other faster task that can be done faster than the fs task, it actually completes the fs task, prints the result. Then other threads finishes and prints the result.

if you change threadpool size to 5, fs doesn't need to wait so it gets finished first. And chaning the threadpool to 1 pushes the fs all the way back so that it gets finished last.

# Performance Enhancement

## Initial Setting

Install using

```
npm init
npm install --save express
```

Don't use Nodemon as it affects clustering.

## Example of a performance issue

```Javascript
const express = require('express');
const app = express();

function doWork(duration) {
	const start = Date.now();
	while(Date.now() - start < duration) {
	}
}

app.get('/', (req, res) => {
	doWork(5000);
	res.send('Hi, there');
});

app.listen(3000);
```

When you run the code above and start a server, a single request to a server takes 5s. Because that while loop blocks the single threaded event loop, preventing it from doing anything else.

If you request 2 requests simultaneously, the second request will take 10 seconds.

## Cluster in theory

A normal node instance gets created in the following order.  
running node index.js  
reading index.js file  
instance of a node gets created

However, things are different in the cluster mode.  
running node index.js
reading index.js file  
first instance that gets created is a cluster manager  
whenever cluster manager decides it is necessary to create new instance, it reads index.js again, calls cluster.fork() and creates a worker instance

## Implementing Cluster

```javascript
const cluster = require("cluster");
const os = require("os");
const cpuCount = os.cpus().length;
const ramSize = os.totalmem() / 1024;

// console.log(cluster.isMaster);

// Is the file being executed in master mode?

if (cluster.isMaster) {
  // Cause index.js to be executed *again* but in child mode
  cluster.fork();
  // cluster.fork();
  // cluster.fork();
  // cluster.fork();
} else {
  // I am a child, I am going to act like a server
  // and do nothing else
  const express = require("express");
  const app = express();

  function doWork(duration) {
    const start = Date.now();
    while (Date.now() - start < duration) {}
  }

  app.get("/", (req, res) => {
    doWork(5000);
    res.send("Hi, there");
  });

  app.get("/fast", (req, res) => {
    res.send("This was fast!!");
  });

  app.listen(3000);
}
```

There are 2 routes, one responses immediately, and the other takes 5 seconds. When you increase the number of clusters, say to 2, notice how fast route can send a res while slow req is still being processed.

In contrast, reducing cluster to 1 behaves as there were no clustering.

## Testing Performance of Cluster

```javascript
const cluster = require("cluster");
const os = require("os");
const crypto = require("crypto");
const myArgs = process.argv.slice(2);
const cpuCount = os.cpus().length;
const ramSize = os.totalmem() / 1024;
process.env.UV_THREADPOOL_SIZE = 1;
const numberOfForks = myArgs[0];

// console.log(cluster.isMaster);

// Is the file being executed in master mode?
let forkCount = 0;
if (cluster.isMaster) {
  console.log("# of forks" + numberOfForks);
  // Cause index.js to be executed *again* but in child mode
  for (let i = 0; i < numberOfForks; i++) {
    forkCount++;
    cluster.fork();
  }
  console.log(forkCount);
  // cluster.fork();
  // cluster.fork();
  // cluster.fork();
} else {
  // I am a child, I am going to act like a server
  // and do nothing else
  const express = require("express");
  const app = express();

  app.get("/", (req, res) => {
    crypto.pbkdf2("a", "b", 200000, 512, "sha512", () => {
      res.send("Hi, there");
    });
  });

  app.get("/fast", (req, res) => {
    res.send("This was fast!!");
  });

  app.listen(3000);
}
```

For sake of simplicity, try to reduce threadpool size to 1, then install ab, try to play with  
ab -c 6 -n 2000 localhost:3000/  
-c means concurrent request, and -n means total number of requests.
After playing with it, you will notice that the rule of thumb is to match the number of children to your either physical or logical cores. The performance does not increase just because you increase number of forks.

## PM2

In contrast to creating different children yourself, you can use PM2 simply by running  
npm install -g pm2  
pm2 start index.js -i 0

-i 0 above means letting the pm2 decide how much instances it creates.
Read More on the official doc of PM2

## Worker threads

Worker threads live in a single instance of node and has a benefit of shared memory where as cluster does not offer sharing of arraybuffer.
Generally worker threads are used for time consuming computationally heavy tasks, where as clusters are used for load balancing heavy requests.

index.js

```javascript
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
```

worker.js

```javascript
const { workerData, parentPort } = require("worker_threads");
let x = 0;
for (let i = 0; i < 1000000; i++) {
  for (let g = 0; g < 1000000; g++) {
    x = i + g;
  }
}
parentPort.postMessage(x);
```

Code above utilizes worker thread so that heavy task does not block event loop

## MongoDB Behind the Scene and Index

Whenever we make a request a query, there's an index that matches collection.

index is an efficient data structure that looks at the set of collection.
Indices doesn't look at all the collections but rather goes straight to the collection we are looking for. Since index is so fast, we do not have to really have to worry about it's performance.

However, when index is created for a collection, index targets specific property that exists in this record.

While there are flexibility of property of indices, lets assume there is only \_id property out of \_id, title and content, in the index.

Since index has \_id property, asking for a blogpost with particular id, that operation is very efficient. However, if we run a query looking for a blog with title or content, we dont benefit from index. Mongo then goes to its default behavior called full collection scan, which is relatively expensive.

There are 2 solutions to this.

You can simply add more index to specific property. like adding index with title property. However, adding more index with different properties causes writing more expensive. And adding more indices require more ram and disks.

The other is adding cache layer.

## Caching

Lets assume the app structure is as follows,

Front <-> Backend(Express, Mongoose) <-> MongoDB

In the stack above, we can add cache layer in between backend and mongoDB

Front <-> Backend(Express, Mongoose) <-> Cache Server <-> MongoDB

When the query request has been made from backend to the mongodb, cache server checks if exact query has been made before. If it was made before that means cache stored the result of the query in the cache server. So instead of reaching out to the mongodb, it responses with that saved query result.

When there hasn't been a exact query request before? it simply sends the query request to the mongodb then retrives the respons, saves it to the cahce server for later, send response back to the backend.

## Redis

```javascript
const redis = require("redis");
const redisUrl = "redis://localhost:6379";
const client = redis.createClient(redisUrl);
client.set("hi", "there");
client.get("hi", console.log);
//Nested hash
client.hset("A", "a", "hi");
client.hset("B", "a", "there");
client.hget("A", "a", console.log);
client.hget("B", "a", console.log);
client.get("hi", (err, value) => console.log(value));

const redisValues = {
  A: {
    a: "hi",
  },
  B: {
    a: "there",
  },
};
```

Redis does not store javascript object  
Need to store object as a string

```javascript
// Does not work, saved as [Object Object]
client.set("colors", { red: "rojo" });

//Need to stringify JSON object
client.set("colors", JSON.stringify({ red: "rojo" }));

//get now returns JSON object in string form. Need to parse it
client.get("colors", (err, val) => console.log(JSON.parse(val)));
```

The actual caching implementation.

```javascript
app.get("/api/blogs", requireLogin, async (req, res) => {
  const redis = require("redis");
  const redisUrl = "redis://localhost:6379";
  const client = redis.createClient(redisUrl);
  const util = require("util");
  client.get = util.promisify(client.get);

  //check if there's a blog in the chache
  const cachedBlogs = await client.get(req.user.id);

  // if yes, return cached ones
  if (cachedBlogs) {
    return res.send(cachedBlogs);
  }
  //otherwise, fetch blog from mongodb and send a response
  const blogs = await Blog.find({ _user: req.user.id });
  res.send(blogs);
  //Lastly, save query to redis cache
  client.set(req.user.id, JSON.stringify(blogs));
});
```

Above is a get request that find blogs according to the user ID
Since redis get uses a callback as its logic, promisify makes it so that it returns a promise.

Problems at this point.

1. There has to be a cleaner way to implement redis chaching.
2. Data that is saved in the redis cache does not expire
3. Current caching logic cannot handle additional features. We only have blogs now but as we introduce more feature like tweets, photos, and etc. relying soley on the userid as a key does not work

## Refactoring Cache implementation

```javascript
const query = Person.find({
  occupation: /host/,
  "name.last": "Ghost",
  age: { $gt: 17, $lt: 66 },
  likes: { $in: ["vaporizing", "talking"] },
})
  .limit(10)
  .sort({ occupation: -1 })
  .select({ name: 1, occupation: 1 })
  .exec(callback);
```

Mongoose calls a query by attaching several functions as an option and exec to the instance of mongoose model.

So if you hijack these options and use them as key, and inject some redis cache logic before exec is called, you can simply apply the redis cache logic to every single query that you make in the app.

services/cache.js;

```javascript
const mongoose = require("mongoose");

const exec = mongoose.Query.prototype.exec;

mongoose.Query.prototype.exec = function () {
  console.log("IM ABOUT TO RUN A QUERY");
  return exec.apply(this, arguments);
};
```

and require it in index.js

```javascript
require("./services/cache");
```

So everytime mongoose runs a query, a console log will be executed.

```javascript
const mongoose = require("mongoose");
const redis = require("redis");
const util = require("util");

const redisUrl = "redis://localhost:6379";
const redisClient = redis.createClient(redisUrl);
redisClient.get = util.promisify(redisClient.get);
const exec = mongoose.Query.prototype.exec;

mongoose.Query.prototype.exec = async function () {
  //Make unique key from collection name and query options
  //Object.assign is used because result of this.getQuery()
  //is actually mongoose document so we dont want to manipulate it
  const key = JSON.stringify(
    Object.assign({}, this.getQuery(), {
      collection: this.mongooseCollection.name,
    })
  );

  // See if we have value for ' key ' in redis
  const cacheValue = await redisClient.get(key);

  // If we do, return that
  //Since mongoose expects a mongoose document as a result after
  //Running a query, we need to make cachevalue to a mongoose model
  //We also need to handle cases where there is just one blog or multiple //blogs
  if (cacheValue) {
    const model = JSON.parse(cacheValue);

    return Array.isArray(model)
      ? model.map((m) => new this.model(m))
      : new this.model(model);
  }

  // Otherwise, issue the query and store the result in redis
  const queryResult = await exec.apply(this, arguments);

  redisClient.set(key, JSON.stringify(queryResult));

  return queryResult;
};
```

## Toggle Caching

To further improve our cache implmentation, there are some caveats to it.

1. Redis takes string and returns string
2. we need to parse string back to object
3. this.getQuery() returns mongoose object, to prvent manipulating it when making a key, we need to use Object.assign()
4. after query, return value is expected to be mongoose document object, which means when we retrieve from redis, since it is pure javascript object, we need to make new mongoose object out of it

```javascript
mongoose.Query.prototype.cache = function () {
  this.useCache = true;
  return this;
};

// Inject this on top of mongoose.Query.prototype.exec implementation
if (!this.useCache) return exec.apply(this, arguments);
```

In order to toggle caching feature when executing a query, we can make a new function call cache, and attach it to the Query prototype. By returning this at the end of the function, it can be chained further. Notice this.useCache is specific to the query instance that is created when query is executed. So when

```javascript
const blogs = await Blog.find({ _user: req.user.id }).cache();
```

is called, useCache will only be added to this specific instance.
And by injecting single if statement that checks for useCache, we can toggle cache feature.

## Expiring Cache

There are two ways to expire a cache. Programatically and using timer.
Using timer is simple, adding 'EX' and number in seconds as an argument in set method will set expiration time to that data.

```javascript
client.set(key, "EX", 10);
```

However, in order to implement expiring automatically, we need to change the way we are caching. Because there is no way to remove portion of redis cache depending on the scope, we need to use nested hash keys.

But desigining nested has keys is specific to the project and situation. In our case, we can use userid as key, and query + model name as nested key. By doing so, when a new blog is posted, we can use the userid of the blog post and clean existing blogs tied to that user id. So that other blogs written by other users will not be affected.

Modify these in cache.js

```javascript
redisClient.hget = util.promisify(redisClient.hget);

const cacheValue = await redisClient.hget(this.hashKey, key);

redisClient.hset(this.hashKey, key, JSON.stringify(queryResult), "EX", 10);

mongoose.Query.prototype.cache = function (options = {}) {
  this.useCache = true;
  this.hashKey = JSON.stringify(options.key || "");

  //Makes it chainable
  return this;
};
```

Now set and get use nested hash version. The cache function now can take any key as an option making it reusuable. When there's no argument passed to cache function, empty string will be used instead of undefined. also ensuring this.hasKey is string is necessary to prevent errors.

Lastly, create clearHash.js in the middleware folder

```javascript
const { clearHash } = require("../services/cache");

module.exports = async (req, res, next) => {
  await next();
  clearHash(req.user.id);
};
```

And require it in the blogRoutes.js

```javascript
const clearHash = require("../middlewares/clearHash");
```

add clearHash as one of the middleware in the post route

The middleware is supposed to run before the actual post process. Regardless of status of post method, the redis cache will always be flushed. In order to prevent this, in the middleware implementation above, function is made async and

```javascript
await next();
```

is called then clearHash is called.

By doing so, since next() is called asynchronously, it will wait till the post to be executed, and flushes as post is complete.

# Testing

## Testing basics and setup with Jest

Unit testing is a test targeting isolated piece
Integration testing targets ensuring multiple targets work together

In a package.json, add "test": "jest" which simply runs jest when you call npm run test. this will be further modified.

Ia project base directory, create /tests/header.test.js all the test files will have extension of test.js and header just means the tests in this file will test header of our application.

```javascript
test("Adds two numbers", () => {
  const sum = 1 + 2;
  expect(sum).toEqual(3);
});
```

The most basic syntax of testing is as above. test function takes first argument as an explanation of test itself, then callback function of logic, with some expectation.

Flow of test of web app is as follows

1. Launch Chromium
2. Navigate to app
3. Click stuff on screen
4. Use a DOM selector to retrieve the content of an element
5. Write assertion to make sure the content is correct
6. Repeat 1

Example of basic jest test syntax

```javascript
const puppeteer = require("puppeteer");

let browser, page;

beforeEach(async () => {
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  page = await browser.newPage();
  await page.goto("http://localhost:3000");
});

afterEach(async () => {
  await browser.close();
});

test("header has the correct text", async () => {
  const text = await page.$eval("a.brand-logo", (el) => el.innerHTML);
  expect(text).toEqual("Blogster");
});

test("clicking login starts oauth flow", async () => {
  await page.click(".right a");
  const url = await page.url();
  expect(url).toMatch(/accounts\.google\.com/);
});
```

1. Make sure any page related task has await
2. beforeEach and afterEach for setup and clean-up
3. the instance of a chromium does not run inside of node. It runs as another process so puppeteer will run the chromium, take our function in eval, translate it to string, send it to chromium, and retireve result as string, and convert it to a form it needs to be

## Integrate authentication flow with testing

Google Oauth flow

1. user visits /auth/google
2. Node forwards user to google then google prompts their login method
3. User is redirected to the server with address of /auth/google/callback with 'code'
4. Server then uses the code to fetch details about user from google
5. Google acknowledges the code sends the server with user profile
6. User is redirected to after login page and cookie is set on user browser for future identification
7. Now all future requests include cookie data that identifies this user

Problem with testing Oauth flow

1. If we automate the google login process with simulating clicks, google will catch that automated attempts and prevent it from happening with things lit captcha
2. creating a backdoor in the server to bypass this is not safe.

Solution

1. We cannot control the oauth flow from 1 to 6 until user is redirected to after login page
2. Assuming that the test user is in our database, we need to create fake session and convince the server that the user is genuine.

How server uses Session

1. user/browser sends request with session and session.sig
2. Server uses session.sig to ensure the session is untouched
3. Fetch user info from session
4. Look up if user exists in the database.
5. If the user exists, the request is ok. Otherwise assume user is not signed

How to create a session

1. You need session and secret key.
2. You can make session out of id and base64 encrypt it
3. then using keygrip

```javascript
const session = "ldjfgkdjkfgj";
const Keygrip = require("keygrip");
const keygrip = new Keygrip(["secret key"]);
keygrip.sign("session=" + session);
// This returns session.sig
keygrip.verify("session=" + session, session.sig);
// This returns either true or false
```

The header and login testing flow

```javascript
// .only prevent other tests from running
test.only("when signed in, shows logout button", async () => {
  const Buffer = require("safe-buffer").Buffer;
  const sessionObject = {
    passport: {
      user: testUserId,
    },
  };
  //Base64 encode sessionObject
  session = Buffer.from(JSON.stringify(sessionObject)).toString("base64");
  const keygrip = new Keygrip([cookieKey]);

  //make session.sig
  //Note "session=" is only needed because of session-cookie module
  sessionsig = keygrip.sign("session=" + session);
  await page.goto("http://localhost:3000");

  //set cookie to the page
  await page.setCookie(
    {
      name: "session",
      value: session,
      httpOnly: true,
      expires: Date.now() + 1000 * 60 * 10,
    },
    {
      name: "session.sig",
      value: sessionsig,
      httpOnly: true,
      expires: Date.now() + 1000 * 60 * 10,
    }
  );
  //refresh the page and wait for logout button to be loaded
  await page.goto("http://localhost:3000");
  await page.waitFor('a[href="/auth/logout"]');

  //extract texts from element
  const myBlogsText = await page.$eval(
    "#root > div > div > nav > div > ul > li:nth-child(1) > a",
    (el) => el.innerHTML
  );
  const logoutText = await page.$eval(
    'a[href="/auth/logout"]',
    (el) => el.innerHTML
  );
  //test!
  expect(myBlogsText).toEqual("My Blogs");
  expect(logoutText).toEqual("Logout");
});
```

Refactoring with factory

1. Factories are helper functions to generate a resource soley for use in testing
2. In our case we need a factories for generating session, and user
3. So far we've been using single hardcoded user but this could lead to data leak across testing instances

Testing environment

1. Jest only runs whatever is in the test files in the current setup
2. When the test is run with jest, jest does not run the index.js file.
3. This causes as our userFactory attempts to create new user with jest
4. This requires requiring necessary files to our test files.
5. However where require which causes a problem
6. This can be solved by centralizing

By adding this to our package.json,

```javascript
  "main": "index.js",
  "jest": {
    "setupTestFrameworkScriptFile": "./tests/setup.js"
  },
```

it ensures our setup.js runs

Also setup mongoose connection and require User model so that mongoose recognizes User model

```javascript
require("../models/User");
const mongoose = require("mongoose");
const keys = require("../config/keys");

mongoose.Promise = global.Promise;
mongoose.connect(keys.mongoURI, { useMongoClient: true });
```

factories/sessionFactory.js

```javascript
const Keygrip = require("keygrip");
const Buffer = require("safe-buffer").Buffer;
const keys = require("../../config/keys");
const keygrip = new Keygrip([keys.cookieKey]);

module.exports = (user) => {
  const sessionObject = {
    passport: {
      user: user._id.toString(),
    },
  };
  const session = Buffer.from(JSON.stringify(sessionObject)).toString("base64");
  sessionsig = keygrip.sign("session=" + session);
  return { session, sessionsig };
};
```

factories/userFactory.js

```javascript
const mongoose = require("mongoose");
const User = mongoose.model("User");

module.exports = () => {
  return new User({}).save();
};
```

Notice these are basically same logic that we had earlier in one of our test function. By refactoring it can now be reused in other places

Now the login logic is simplified to this

```javascript
const user = await userFactory();
const { session, sessionsig } = sessionFactory(user);
await page.setCookie(
  {
    name: "session",
    value: session,
    httpOnly: true,
    expires: Date.now() + 1000 * 60 * 10,
  },
  {
    name: "session.sig",
    value: sessionsig,
    httpOnly: true,
    expires: Date.now() + 1000 * 60 * 10,
  }
);

await page.goto("http://localhost:3000");
await page.waitFor('a[href="/auth/logout"]');
```

Refactoring Login Logic in Test Method
There are two suggested method of refactoring the login flow

1. Just like we did in cache, we can attach new function to instance of Page class

```javascript
const Page = require("puppeteer/lib/Page");

Page.prototype.login = async function () {
  const user = await userFactory();
  const { session, sessionsig } = sessionFactory(user);
  await this.setCookie(
    {
      name: "session",
      value: session,
      httpOnly: true,
      expires: Date.now() + 1000 * 60 * 10,
    },
    {
      name: "session.sig",
      value: sessionsig,
      httpOnly: true,
      expires: Date.now() + 1000 * 60 * 10,
    }
  );

  await this.goto("http://localhost:3000");
  await this.waitFor('a[href="/auth/logout"]');
};
```

Notice now this is used as page instance is calling this function
