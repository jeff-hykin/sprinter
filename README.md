# Sprinter

Replace bash scripts with Deno 


## How to use

```js
const { run, Timeout, Env, Cwd, Stdin, Stdout, Stderr, Out, Overwrite, Append, zipInto, mergeInto, returnIt, } = await import(`https://deno.land/x/sprinter@0.2.0/index.js`)

const value = run("echo", "hello")
console.debug(`value is:`,value)
console.debug(`value.success is:`,value.success)
console.debug(`await value.success is:`,await value.success)

const process = await run("yes", Stdout(null), Timeout({ gentlyBy: 100, waitBeforeUsingForce: 500}))
console.debug(`process.status is:`, await process.status)
console.debug(`process is:`,process)
```