const { readableStreamFromReader, writableStreamFromWriter } = await import(`https://deno.land/std@0.121.0/streams/conversion.ts`)
const { zipReadableStreams, mergeReadableStreams } = await import("https://deno.land/std@0.121.0/streams/merge.ts")
const { StringReader } = await import("https://deno.land/std@0.128.0/io/mod.ts")
const Path = await import("https://deno.land/std@0.117.0/path/mod.ts")
const { debugValueAsString } = await import("./dapper-debugger.js")

export const asString       = Symbol("asString")
export const zipInto        = Symbol("zipInto")
export const mergeInto      = Symbol("mergeInto")

// 
// 
// Helpers
// 
// 

// based on this, thats all it is: https://deno.land/std@0.125.0/io/types.d.ts
// this does cause a bit of a problem though because files meet this defintion but are "readable" enough I suppose
// because they still need to be converted using readableStream
const isReadable = (obj) => obj instanceof Object && obj.read instanceof Function
const isWritable = (obj) => obj instanceof Object && obj.write instanceof Function

const concatUint8Arrays = (arrays) => new Uint8Array( // simplified from: https://stackoverflow.com/questions/49129643/how-do-i-merge-an-array-of-uint8arrays
        arrays.reduce((acc, curr) => (acc.push(...curr),acc), [])
    )

const FileSystem = {
    info: async (fileOrFolder) => {
        const result1 = await Deno.lstat(fileOrFolder).catch(()=>({doesntExist: true}))
        result1.exists = !result1.doesntExist
        if (result1.exists) {
            const result2 = await Deno.stat(fileOrFolder).catch(()=>({doesntExist: true}))
            result1.isFile = result2.isFile
            result1.isDirectory = result2.isDirectory
        }
        return result1
    },
    remove: (fileOrFolder) => Deno.remove(path,{recursive: true}).catch(()=>false),
    clearAPathFor: async (path)=>{
        const parentPath = Path.dirname(path)
        // dont need to clear a path for the root folder
        if (parentPath == path) {
            return
        } else {
            // we do need to clear a path for the parent of this folder
            await FileSystem.clearAPathFor(parentPath)
        }
        const { exists, isDirectory } = await FileSystem.info(parentPath)
        // if a folder is in the way, delete it
        if (exists && !isDirectory) {
            await FileSystem.remove(parentPath)
        }
        const parentPathInfo = await Deno.lstat(parentPath).catch(()=>({doesntExist: true}))
        // if no folder was there, create one
        if (!parentPathInfo.exists) {
            Deno.mkdir(Path.dirname(parentPath),{ recursive: true })
        }
    },
}

const awaitAll = async (array)=>{
    let newArray = []
    for (const each of array) {
        newArray.push(await each)
    }
    return newArray
}

const streamToString = async (stream) => {
    const reader = stream.getReader()
    const { value } = await reader.read()
    const string = new TextDecoder().decode(value)
    return string
}

// 
// 
// Main
// 
// 
export class Process extends Promise {
    constructor(...command) {
        super(()=>0)
        // 
        // defaults
        // 
        this.command = command
        this.data = {
            cwd: undefined,
            env: undefined,
            timeout: {},
            stdin: [],
            stdout: [],
            stderr: [],
            out: [],
        }
        this.wasGivenManually = {
            env: false,
            cwd: false,
            stdin: false,
            stdout: false,
            stderr: false,
            out: false,
        }
        this.asString = {
            stdout: false,
            stderr: false,
            out: false,
        }
        this.syncStatus = { done: false, exitCode: undefined, success: undefined }
        
        // 
        // setup the deno process
        // 
        this.process = new Promise( (resolve, reject)=>setTimeout(async () => {
            try {
                console.debug(`this.wasGivenManually is:`,this.wasGivenManually)
                console.debug(`this.data is:`,this.data)
                // this is going to be given to deno as an arg
                this.runArg = {
                    cwd: undefined,
                    env: undefined,
                    cmd: undefined,
                    stdin: undefined,
                    stdout: undefined,
                    stderr: undefined,
                }

                // 
                // 
                // checks
                // 
                // 
                    // 
                    // check cwd 
                    // 
                    if (this.runArg.cwd !== undefined) {
                        const folderExists = await Deno.stat(this.runArg.cwd).then(({isDirectory})=>isDirectory).catch(()=>false)
                        if (!folderExists) {
                            throw Error(`\nWhen running command:\n    ${JSON.stringify(this.runArg.cmd)}\nit was given a Cwd (cwd) of:\n${JSON.stringify(this.runArg.cwd)}\nbut that doesn't seem to be a path to a folder, so the command would fail.\n\n`)
                        }
                    }

                    // env probably doesnt need a check
                    this.runArg.env = this.data.env
                    
                    // cmd
                    // TODO: add checks instead of forcing to string
                    this.runArg.cmd = this.command.filter(each=>each != null).map(each=>`${each}`)

                    // 
                    // timeout check
                    //
                    if (
                        // either both should be null or both should be set
                        (this.data.timeout.gentlyBy == null) !== (this.data.timeout.waitBeforeUsingForce == null)
                        ||
                        (this.data.timeout.gentlyBy != null) && (
                            !(this.data.timeout.gentlyBy >= 0)
                            ||
                            !(this.data.timeout.waitBeforeUsingForce >= 0)
                        )
                    ) {
                        throw Error(`\nWhen running command:\n    ${JSON.stringify(this.runArg.cmd)}\nit was given a:\n    Timeout(${JSON.stringify(this.data.timeout)})\nhowever both "gentlyBy" and "waitBeforeUsingForce" are needed.\nFor example, if \n    gentlyBy: 1000\n    waitBeforeUsingForce: 500\nit would be force killed 1.5sec after the process started.\nIf you never want force to be used, do {waitBeforeUsingForce: Infinity}\n\n`)
                    }
                    

                // 
                // handle stdin (pre-start)
                // 
                let stdinWriter = undefined
                let stdinArgs = await awaitAll(this.data.stdin)
                // default value (Deno.stdin)
                if (!this.wasGivenManually.stdin) {
                    this.runArg.stdin = undefined
                // null (/dev/null)
                } else if (stdinArgs.length == 1 && stdinArgs[0] == null) {
                    this.runArg.stdin = 'null'
                // piped in from stream-variable
                } else if (stdinArgs.length == 0) {
                    this.runArg.stdin = 'piped'
                // piped in from args
                } else {
                    // remove all the null's and undefined's
                    stdinArgs = stdinArgs.filter(each=>each != null)
                    // if no valid arguments after that, theres a problem
                    if (stdinArgs.length == 0) {
                        throw Error(`when calling run() with the command: \n    ${JSON.stringify(this.runArg.cmd)}\nAn .stdin() was given, but it wasn't given any arguments\nif you want Stdin to be nothing (instead of the default .stdin(Deno.stdin)) put .stdin(null)\n\n`)
                    } else {
                        this.runArg.stdin = 'piped'
                        
                        // all strings/bytes (this check is done for efficiency of throughput)
                        if (stdinArgs.every(each=>typeof each == 'string' || each instanceof Uint8Array)) {
                            const allUint8Arrays = stdinArgs.map(each=>typeof each != 'string' ? each : new TextEncoder().encode(each))
                            // creates a single Uint8 array
                            stdinWriter = concatUint8Arrays(allUint8Arrays)
                        } else {
                            // 
                            // create the initial stream
                            // 
                            const first = stdinArgs[0]
                            let prev
                            // string to readable stream
                            if (typeof first == 'string') {
                                stdinWriter = readableStreamFromReader(new StringReader(first))
                                prev = 'string'
                            // Uint8 (raw data) to readable stream
                            } else if (first instanceof Uint8Array) {
                                stdinWriter = readableStreamFromReader(new Buffer(first))
                                prev = 'uint8array'
                            // check for readable stream itself
                            } else if (first instanceof ReadableStream) {
                                stdinWriter = first
                                prev = 'readableStream'
                            // readable to readable stream
                            } else if (isReadable(first)) {
                                stdinWriter = readableStreamFromReader(first)
                                prev = 'readable'
                            } else {
                                throw Error(`when calling run() with the command: \n    ${JSON.stringify(this.runArg.cmd)}\nAn .stdin() was given, but there was a problem with one of the arguments.\nThe argument can be a string, a file (Deno.open("./path")), bytes (Uint8Array), or any readable object (like Deno.stdin or the .stdout of another run command)\nbut instead of any of those I received:\n    ${first}\n\n`)
                            }

                            // for all remaining args
                            for (const each of stdinArgs.slice(1,)) {
                                // check for overrides of the default merging methods
                                if (each === mergeInto || each === zipInto) {
                                    prev = each
                                    continue
                                }

                                let newStream
                                if (typeof each == 'string') {
                                    newStream = readableStreamFromReader(new StringReader(each))
                                    current = 'string'
                                // Uint8 (raw data) to readable stream
                                } else if (each instanceof Uint8Array) {
                                    newStream = readableStreamFromReader(new Buffer(each))
                                    current = 'uint8'
                                // check for readable stream itself
                                } else if (each instanceof ReadableStream) {
                                    newStream = each
                                    current = 'readableStream'
                                // readable to readable stream
                                } else if (isReadable(each)) {
                                    newStream = readableStreamFromReader(each)
                                    current = 'readable'
                                } else {
                                    throw Error(`when calling run() with the command: \n    ${JSON.stringify(this.runArg.cmd)}\nAn .stdin() was given, but there was a problem with one of the arguments.\nThe argument can be a string, a file (Deno.open("./path")), bytes (Uint8Array), or any readable object (like Deno.stdin or the .stdout of another run command)\nbut instead of any of those I received:\n    ${each}\n\n`)
                                }
                                
                                // 
                                // combining method
                                // 
                                // let user specify, but if not specified the strat will be to always zip if both sides are readables, while merging if one side is a string/uint8array
                                if (prev !== zipInto && ( prev === mergeInto || prev == 'string' || prev == 'uint8array' || current == 'string' || current == 'uint8array')) {
                                    // merge is kind of like concat, first one then the other (I believe)
                                    stdinWriter = stdinWriter.mergeReadableStreams(stdinWriter, newStream)
                                } else {
                                    // zip is well, like zip, it get 1 chunk from each and then repeats instead of concating
                                    stdinWriter = stdinWriter.zipReadableStreams(stdinWriter, newStream)
                                }
                            }
                        }
                        
                    }
                }
                
                //
                // handle stdout & stderr (pre-start)
                //
                // mark for string output
                for (const eachStream of [ 'stderr', 'stdout', 'out']) {
                    if (this.data[eachStream].includes(asString)) {
                        this.asString[eachStream] = true
                    }
                }
                // 
                // set this.runArg for stdout/stderr
                // 
                for (const eachStreamName of [ 'stdout', 'stderr' ]) {
                    // add combined-out to each individual stream
                    this.data[eachStreamName] = [...this.data[eachStreamName], ...this.data.out]

                    // default to Deno.stdout/Deno.stderr
                    if (!this.wasGivenManually[eachStreamName] && !this.wasGivenManually.out) {
                        this.runArg[eachStreamName] = undefined
                    // pipe to a variable
                    } else if (this.data[eachStreamName].length == 0) {
                        this.runArg[eachStreamName] = 'piped'
                    // null (/dev/null)
                    } else if (this.data[eachStreamName].length == 1 && this.data[eachStreamName][0] === null) {
                        this.runArg[eachStreamName] = 'null'
                    // actually pipe to something (file, stream, etc)
                    } else {
                        this.runArg[eachStreamName] = 'piped'
                        // note: surprisingly Sets in ES6 are guarenteed to preserve order, so this only removes null's undefines, and duplicates
                        this.data[eachStreamName] = [ ... new Set(this.data[eachStreamName].filter(eachArg=>eachArg!=null))]
                    }
                }
                // 
                // convert args of stdin/stdout
                // 
                const convertReturnStreamArg = async (arg) => {
                    // dont convert this kind of arg (save for later by returning it)
                    if (arg === asString) {
                        return arg
                    }
                    
                    // 
                    // overwrite
                    //
                    if (arg instanceof Object && arg.overwrite !== undefined) {
                        let value = arg.overwrite
                        if (typeof value == 'string') {
                            // ensure parent folders exist
                            await FileSystem.clearAPathFor(value)
                            // convert string to a folder
                            value = await Deno.open(value, {write: true, truncate: true, create: true})
                        }
                        
                        if (value instanceof Deno.File) {
                            // clear the file
                            value.truncate()
                        } else {
                            throw Error(`\nWhen running command:\n    ${JSON.stringify(this.runArg.cmd)}\nit was given one of:\n    .stdout({overwrite:arg})\n    .stdin({overwrite:arg})\n    .out({overwrite:arg})\nHowever the given arg was not a string path or a file object.\nHere's what I know about the argument:${debugValueAsString(value)}\n\n`)
                        }
                    // 
                    // append
                    // 
                    } else if (arg instanceof Object && arg.appendTo !== undefined) {
                        let value = arg.appendTo
                        if (typeof value == 'string') {
                            // ensure parent folders exist
                            await FileSystem.clearAPathFor(value)
                            // convert string to a folder
                            value = await Deno.open(value, {write: true, create: true})
                            // FIXME: this file never gets closed! it needs to be, but only if it was opened here
                        }
                        
                        if (value instanceof Deno.File) {
                            // go to the end of a file (meaning everthing will be appended)
                            await Deno.seek(value.rid, 0, Deno.SeekMode.End)
                        } else {
                            throw Error(`\nWhen running command:\n    ${JSON.stringify(this.runArg.cmd)}\nit was given one of:\n    .stdout({appendTo:arg})\n    .stdin({appendTo:arg})\n    .out({appendTo:arg})\nHowever the given arg was not a string path or a file object.\nHere's what I know about the argument:${debugValueAsString(value)}\n\n`)
                        }

                    // values that are alread writeable streams
                    } else if (arg instanceof WritableStream) {
                        return arg
                    // convert files/writables to writeable streams
                    } else if (isWritable(arg)) {
                        return writableStreamFromWriter(arg)
                    } else if (typeof arg == 'string') {
                        throw Error(`\nWhen running command:\n    ${JSON.stringify(this.runArg.cmd)}\nit was given one of:\n    .stdout(${JSON.stringify(arg)})\n    .stdin(${JSON.stringify(arg)})\n    .out(${JSON.stringify(arg)})\nif you want to have them write to a file:\n    dont:    .out(${JSON.stringify(arg)})\n    instead: .out(Overwrite(${JSON.stringify(arg)}))\n    or:      .out(AppendTo(${JSON.stringify(arg)}))\n\n`)
                    }
                }
                let alreadyComputed = new Map()
                console.debug(`before converting out:`,this.data)
                for (const eachStream of [ 'stdout', 'stderr' ]) {
                    this.data[eachStream] = await awaitAll(this.data[eachStream].map(eachArg=>{
                        if (alreadyComputed.has(eachArg)) {
                            return alreadyComputed.get(eachArg)
                        } else {
                            return convertReturnStreamArg(eachArg)
                        }
                    }))
                }
                console.debug(`after converting out:`,this.data)
                
                // 
                // 
                // start the process
                // 
                // 
                resolve(Deno.run(this.runArg))
            } catch (error) {
                reject(error)
            }
        }, 0))
        
        this.outcomePromise = this.process.then(process=>process.status())

        // 
        // handle output for return value
        //
        this.returnValue = this.process.then(async (process)=>{
            let stdoutArgs = this.data.stdout
            let stderrArgs = this.data.stderr

            if (this.data.timeout.gentlyBy) {
                // create a outcome check
                let outcome = false
                this.outcomePromise.then(()=>outcome=true)
                // schedule a suggested stop time
                setTimeout(async () => {
                    if (!outcome) {
                        // ask it to please stop
                        process.kill("SIGINT")
                        // and schedule it's death
                        setTimeout(()=>{
                            if (!outcome) {
                                process.kill("SIGKILL")
                            }
                        }, this.data.timeout.waitBeforeUsingForce)
                    }
                }, this.data.timeout.gentlyBy)
            }

            // 
            // handle stdout/stderr
            // 
            let returnStream = undefined
            console.debug(`this.runArg is:`,this.runArg)
            if (this.runArg.stdout == 'piped' || this.runArg.stderr == 'piped') {
                // 
                // NOTE: this process is kind of complicated because of checking
                //       for stderr/stdout to the same source 
                //       and for outputing them to mulitple sources
                // 

                // 
                // figure out how many streams are needed
                // 
                const neededByStdout = new Map()
                const neededByStderr = new Map()
                // what needs stdout
                for (const each of stdoutArgs) {
                    // init to set if doesnt exist
                    neededByStdout.set(each, true)
                    neededByStderr.set(each, false)
                }
                // what needs stderr
                for (const each of stderrArgs) {
                    neededByStderr.set(each, true)
                    if (!neededByStdout.has(each)) {
                        neededByStdout.set(each, false)
                    }
                }
                
                // 
                // generate all of the streams
                // 
                // complicated because tee-ing a stream kind of destroys the original 
                // and its better to tee in a branching way than in a all-on-one-side way (BFS-style not DFS-style)
                const stdoutStreamSplitQue = []
                const stderrStreamSplitQue = []
                // the initial ones are edgecases
                if (stdoutArgs.length > 0) {
                    stdoutStreamSplitQue.push(readableStreamFromReader(process.stdout))
                }
                if (stderrArgs.length > 0) {
                    stderrStreamSplitQue.push(readableStreamFromReader(process.stderr))
                }
                while (stdoutStreamSplitQue.length < stdoutArgs.length) {
                    // take off the front of the que (back of the list), create two more items (tee) put them at the back of the que (front of the list)
                    stdoutStreamSplitQue = stdoutStreamSplitQue.pop().tee().concat(stdoutStreamSplitQue)
                }
                while (stderrStreamSplitQue.length < stderrArgs.length) {
                    // take off the front of the que (back of the list), create two more items put them at the back of the que (front of the list)
                    stderrStreamSplitQue = stderrStreamSplitQue.pop().tee().concat(stderrStreamSplitQue)
                }
                // now we should have the appropriate number of streams
                const stdoutStreams = stdoutStreamSplitQue
                const stderrStreams = stderrStreamSplitQue

                // 
                // convert/connect all to streams
                // 
                for (const eachStreamArg of [...new Set(stdoutArgs.concat(stderrArgs))]) {
                    const wasNeededByStdout = neededByStdout.get(eachStreamArg)
                    const wasNeededByStderr = neededByStderr.get(eachStreamArg)
                    let sourceStreamCopy
                    // needed by both
                    if (wasNeededByStdout && wasNeededByStderr) {
                        sourceStreamCopy = zipReadableStreams(stdoutStreams.pop(), stderrStreams.pop())
                        if (eachStreamArg == asString) {
                            this.asString.out = sourceStreamCopy
                        }
                    // needed by only stdout
                    } else if (wasNeededByStdout) {
                        sourceStreamCopy = stdoutStreams.pop()
                        if (eachStreamArg == asString) {
                            this.asString.stdout = sourceStreamCopy
                        }
                    // needed by only stderr
                    } else {
                        sourceStreamCopy = stderrStreams.pop()
                        if (eachStreamArg == asString) {
                            this.asString.stderr = sourceStreamCopy
                        }
                    }
                    
                    // aka: if arg is a stream
                    if (eachStreamArg !== asString) {
                        // pipe it to the correct thing
                        // every stream arg should be a writable stream by this point
                        sourceStreamCopy.pipeTo(eachStreamArg)
                    }
                }
            }

            // 
            // send stdin
            // 
            if (this.runArg.stdin == 'piped') {
                if (stdinWriter instanceof Uint8Array) {
                    // without the stdin.close() part the process will wait forever
                    process.stdin.write(stdinWriter).then(()=>process.stdin.close())
                } else if (stdinWriter instanceof ReadableStream) {
                    // actually pipe data
                    writableStreamFromWriter(process.stdin)
                }
            }

            // 
            // update the syncStatus when process done
            // 
            const outcome = await this.outcomePromise
            this.syncStatus.done = true
            this.syncStatus.exitCode = outcome.code
            this.syncStatus.success = outcome.success
            const output = {
                isDone:     true,
                status:     this.syncStatus,
                sendSignal: ()=>0,
                outcome:    outcome,
                success:    outcome.success,
                exitCode:   outcome.code,
                pid:        process.pid,
                rid:        process.rid,
                kill:       ()=>0,
                close:      process.close,
                stdin:      this.runArg.stdin=='null' ? null : (process.stdin || Deno.stdin),
                stdout: this.asString.stdout ? await streamToString(this.asString.stdout) : (process.stdout || Deno.stdout),
                stderr: this.asString.stderr ? await streamToString(this.asString.stderr) : (process.stderr || Deno.stderr),
                out:    this.asString.out ? await streamToString(this.asString.out) : undefined,
            }
            if (typeof this.returnKey == 'string') {
                return output[this.returnKey]
            } else {
                return output
            }
        })
    }
    then(...args) {
        return this.returnValue.then(...args)
    }
    catch(...args) {
        return this.returnValue.catch(...args)
    }
    finally(...args) {
        return this.returnValue.finally(...args)
    }
    returnKey(key) {
        this.returnKey = key
        return this
    }
    cwd(newCwd) {
        this.wasGivenManually.cwd = true
        this.data.cwd = newCwd
        return this
    }
    env(newEnv) {
        this.wasGivenManually.env = true
        this.data.env = newEnv
        return this
    }
    stdin(...args) {
        this.wasGivenManually.stdin = true
        this.data.stdin = args
        return this
    }
    stdout(...args) {
        console.debug(`args is:`,args)
        this.wasGivenManually.stdout = true
        this.data.stdout = args
        return this
    }
    stderr(...args) {
        this.wasGivenManually.stderr = true
        this.data.stderr = args
        return this
    }
    out(...args) {
        this.wasGivenManually.out = true
        this.data.out = args
        return this
    }
    timeout({gentlyBy, waitBeforeUsingForce}) {
        this.wasGivenManually.timeout = true
        this.data.timeout = {gentlyBy, waitBeforeUsingForce}
        return this
    }

    // TODO:
        // sendSignal
        // send
        // 

    static run(...command) {
        return (new Process(...command)).process
    }
    static outcome(...command) {
        return (new Process(...command)).returnKey("outcome")
    }
    static success(...command) {
        return (new Process(...command)).returnKey("success")
    }
    static exitCode(...command) {
        return (new Process(...command)).returnKey("exitCode")
    }
    static stdin(...command) {
        return (new Process(...command)).returnKey("stdin")
    }
    static stdout(...command) {
        return (new Process(...command)).returnKey("stdout")
    }
    static stderr(...command) {
        return (new Process(...command)).returnKey("stderr")
    }
    static out(...command) {
        return (new Process(...command)).returnKey("out")
    }
}


// Object.defineProperties(run, {
//     isDone:     { get(){ return this.syncStatus.done } },
//     sendSignal: { get(){ return (         ...args)=>this.process.then((process)=>process.kill(...args) ).catch(error=>error) } },
//     kill:       { get(){ return (signal="SIGKILL")=>this.process.then((process)=>process.kill(signal)  ) } },
//     close:      { get(){ return (         ...args)=>this.process.then((process)=>process.close(...args)) } },
//     success:    { get(){ return this.outcomePromise.then(({success})=>success) } },
//     exitCode:   { get(){ return this.outcomePromise.then(({code})=>code)       } },
//     outcome:    { get(){ return this.outcomePromise                            } },
//     rid:        { get(){ return this.process.then(({rid    })=>rid                                         ) } },
//     pid:        { get(){ return this.process.then(({pid    })=>pid                                         ) } },
//     stdout:     { get(){ return this.process.then(({stdout })=>stdout||Deno.stdout                         ) } },
//     stderr:     { get(){ return this.process.then(({stderr })=>stderr||Deno.stderr                         ) } },
//     stdin:      { 
//         get(){
//             const realStdinPromise = this.process.then(({stdin})=>stdin||Deno.stdin)
//             return {
//                 send(rawDataOrString) {
//                     if (typeof rawDataOrString == 'string') {
//                         return {...realStdinPromise.then(realStdin=>(realStdin.write(new TextEncoder().encode(rawDataOrString)))), ...this}
//                     // assume its raw data
//                     } else {
//                         return {...realStdinPromise.then(realStdin=>(realStdin.write(rawDataOrString))), ...this}
//                     }
//                 },
//                 close(...args) {
//                     return realStdinPromise.then((realStdin)=>(realStdin.close(...args),this))
//                 }
//             }
//         }
//     },
// })