# Sprinter - Beta

Replace bash scripts with Deno!

Designed for piping files, streams, strings

## Stability:

This is only the initial mostly-untested version. The readme will get a makeover once a test suite has been established. PR's, feedback, and feature requests welcome. 

## How to use

```js
import { run, Timeout, Env, Cwd, Stdin, Stdout, Stderr, Out, Overwrite, AppendTo, zipInto, mergeInto, returnIt, } from "https://deno.land/x/sprinter@0.2.2/index.js"


// runs async
run("echo", "hello")

// wait for a command to finish
await run("echo", "hello")

// get outcome
var { success, exitCode } = await run("echo", "hello").outcome

// send stdin (a string, a file, or a stream)
await run("cat", Stdin("Bang\n")).outcome

// send stdin, but later
var {stdin} = run("cat", Stdin())
// send a string
stdin.send("Bang\n")
// or send raw bytes (normally from reading a file or stream directly)
stdin.send(new TextEncoder().encode("Bang Bang\n"))
// (cant send file objects and streams yet, but maybe in the future)
// CLOSE IT! otherwise the process will never end!
await stdin.close()

// get output string as return value
const pathToGrep = await run("which", "grep", Out(returnIt))
console.debug(`pathToGrep is:`,pathToGrep)

// append to a file (give a path or a Deno file object)
var success = await run("which", "grep",
    Stdout(Overwrite("./grep_path.txt")),
    Stderr(AppendTo("./errors.log")),
).success

// report status
var process = run("sleep", "5")
let int = setInterval(() => {
    console.log(`process.isDone? is:`,process.isDone)
    if (process.isDone) {
        clearInterval(int)
    }
}, 1000);
await process

// create timeouts
var { success, exitCode } = await run("yes", Stdout(null), Timeout({ gentlyBy: 100, waitBeforeUsingForce: 500}))

// do a manual timeout
var process = run("yes", Stdout(null))
setTimeout(() => {
    process.kill() // uses force
}, 100)
await process

// do an even more manual timeout
var process = run("yes", Stdout(null))
setTimeout(() => {
    // ask to please stop
    process.sendSignal("SIGINT")

    setTimeout(() => {
        if (!process.isDone) {
            // murder it
            process.sendSignal("SIGKILL")
        }
    }, 200)
}, 100)

```

ToDo: 
- Allow direct passing of one process.stdout to another commands Stdin() without AppendTo
- Allow stdin.send() to accept files and streams as input
- Add a callback for incrementally getting string data out of stdout/stderr
