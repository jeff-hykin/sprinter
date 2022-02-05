#!/usr/bin/env -S deno run --allow-all
const { run, Timeout, Env, Cwd, Stdin, Stdout, Stderr, Out, Overwrite, Append, zipInto, mergeInto, returnIt, } = await import(`./index.js`)

const success = await run("echo", "hello").success
console.debug(`success is:`,success)
console.debug(`success is:`,await success)

const process = await run("yes", Stdout(null), Timeout({ gentlyBy: 100, waitBeforeUsingForce: 500}))
console.debug(`process.status is:`, await process.status)
console.debug(`process is:`,process)