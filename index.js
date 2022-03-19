const { readableStreamFromReader, writableStreamFromWriter } = await import(`https://deno.land/std@0.121.0/streams/conversion.ts`)
const { zipReadableStreams, mergeReadableStreams } = await import("https://deno.land/std@0.121.0/streams/merge.ts")
const { StringReader } = await import("https://deno.land/std@0.128.0/io/mod.ts")
const Path = await import("https://deno.land/std@0.117.0/path/mod.ts")
const { debugValueAsString } = await import("./dapper-debugger.js")

const timeoutSymbol      = Symbol("timeout")
const envSymbol          = Symbol("env")
const cwdSymbol          = Symbol("cwd")
const stdinSymbol        = Symbol("stdin")
const stdoutSymbol       = Symbol("stdout")
const stderrSymbol       = Symbol("stderr")
const stdoutAndErrSymbol = Symbol("stdoutAndErr")
const overwriteSymbol    = Symbol("overwrite")
const appendSymbol       = Symbol("append")
export const throwIfFails = Symbol("throwIfFails")
export const zipInto        = Symbol("zipInto")
export const mergeInto      = Symbol("mergeInto")
export const returnAsString = Symbol("returnAsString")
const asString  = Symbol("asString") // TODO: integrate this as a feature (returns { stdout: "blh", stderr: "bal", output: "blhbal" })
export const Timeout   = ({gentlyBy, waitBeforeUsingForce})=>[timeoutSymbol, {gentlyBy, waitBeforeUsingForce}]
export const Env       = (envVars)=>[envSymbol, envVars]
export const Cwd       = (newDirectory)=>[cwdSymbol, newDirectory]
export const Stdin     = (...streamsFilesOrStrings)=>[stdinSymbol , streamsFilesOrStrings]
export const Stdout    = (...pathsFilesStreamsOrSymbols)=>[stdoutSymbol, pathsFilesStreamsOrSymbols]
export const Stderr    = (...pathsFilesStreamsOrSymbols)=>[stderrSymbol, pathsFilesStreamsOrSymbols]
export const Out       = (...pathsFilesStreamsOrSymbols)=>[stdoutAndErrSymbol, pathsFilesStreamsOrSymbols]
export const Overwrite = (fileOrFilePath)=>[overwriteSymbol, fileOrFilePath]
export const AppendTo  = (fileOrFilePath)=>[appendSymbol, fileOrFilePath]

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

export const hasCommand = async (commandName) => {
    try {
        await Deno.run({cmd:[commandName]})
    } catch (error) {
        if (error.message == "No such file or directory (os error 2)") {
            return false
        }
    }
    return true
}

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

// 
// 
// Main function!
// 
// 
export const run = (...args) => {
    // 
    // parse args
    // 
    const commandMetaData = {
        timeout: {gentlyBy: undefined, waitBeforeUsingForce: undefined},
        env: undefined,
        cwd: undefined,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        outAndError: [],
    }
    for (const each of args) {
        if (typeof each == 'symbol') {
            if (each == throwIfFails) {
                commandMetaData.throwIfFails = true
            }
        }
        if (each instanceof Array && typeof each[0] == 'symbol') {
            const [symbol, value] = each
            if (symbol === timeoutSymbol     ) { Object.assign(commandMetaData.timeout, value)}
            if (symbol === envSymbol         ) { commandMetaData.env         = value }
            if (symbol === cwdSymbol         ) { commandMetaData.cwd         = value }
            if (symbol === stdinSymbol       ) { commandMetaData.stdin       = value }
            if (symbol === stdoutSymbol      ) { commandMetaData.stdout      = value }
            if (symbol === stderrSymbol      ) { commandMetaData.stderr      = value }
            if (symbol === stdoutAndErrSymbol) { commandMetaData.outAndError = value }
        }
    }

    // 
    // start setting up the arg for Deno.run
    // 
    const runArg = {
        cmd: args.filter(each=>(typeof each == 'string')),
        env: commandMetaData.env,
        cwd: commandMetaData.cwd,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
    }
    
    const syncStatus = { done: false, exitCode: undefined, success: undefined }

    // 
    // this is done to prevent the ugly (await (await run()).success()) syntax
    // 
    const asyncPart = async ()=> {
        // 
        // timeout check
        //
        if (
            // either both should be null or both should be set
            (commandMetaData.timeout.gentlyBy == null) !== (commandMetaData.timeout.waitBeforeUsingForce == null)
            ||
            (commandMetaData.timeout.gentlyBy != null) && (
                !(commandMetaData.timeout.gentlyBy >= 0)
                ||
                !(commandMetaData.timeout.waitBeforeUsingForce >= 0)
            )
        ) {
            throw Error(`\nWhen running command:\n    ${JSON.stringify(runArg.cmd)}\nit was given a:\n    Timeout(${JSON.stringify(commandMetaData.timeout)})\nhowever both "gentlyBy" and "waitBeforeUsingForce" are needed.\nFor example, if \n    gentlyBy: 1000\n    waitBeforeUsingForce: 500\nit would be force killed 1.5sec after the process started.\nIf you never want force to be used, do {waitBeforeUsingForce: Infinity}\n\n`)
        }
        
        // cmd doesn't need checking
        
        // env doesn't really need checking

        // 
        // check cwd 
        // 
        if (runArg.cwd !== undefined) {
            const folderExists = await Deno.stat(runArg.cwd).then(({isDirectory})=>isDirectory).catch(()=>false)
            if (!folderExists) {
                throw Error(`\nWhen running command:\n    ${JSON.stringify(runArg.cmd)}\nit was given a Cwd (cwd) of:\n${JSON.stringify(runArg.cwd)}\nbut that doesn't seem to be a path to a folder, so the command would fail.\n\n`)
            }
        }

        // 
        // handle stdin (pre-start)
        // 
        let stdinWriter = undefined
        if (commandMetaData.stdin !== undefined) {
            let stdinArgs = commandMetaData.stdin
            
            // await any promise values
            let index = 0
            for (const each of stdinArgs) {
                if (each instanceof Promise) {
                    stdinArgs[index] = await each
                }
                ++index
            }
            
            if (stdinArgs.length == 0) {
                runArg.stdin = 'piped'
            } else if (stdinArgs.length == 1 && stdinArgs[0] == null) {
                runArg.stdin = 'null'
            } else {
                // remove all the null's and undefined's
                stdinArgs = stdinArgs.filter(each=>each != null)
                // if no valid arguments after that, theres a problem
                if (stdinArgs.length == 0) {
                    throw Error(`when calling run() with the command: \n    ${JSON.stringify(runArg.cmd)}\nAn Stdin() was given, but it wasn't given any arguments\nif you want Stdin to be nothing (instead of the default Stdin(Deno.stdin)) put Stdin(null)\n\n`)
                } else {
                    runArg.stdin = 'piped'
                    
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
                            throw Error(`when calling run() with the command: \n    ${JSON.stringify(runArg.cmd)}\nAn Stdin() was given, but there was a problem with one of the arguments.\nThe argument can be a string, a file (Deno.open("./path")), bytes (Uint8Array), or any readable object (like Deno.stdin or the .stdout of another run command)\nbut instead of any of those I receied:\n    ${first}\n\n`)
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
                                throw Error(`when calling run() with the command: \n    ${JSON.stringify(runArg.cmd)}\nAn Stdin() was given, but there was a problem with one of the arguments.\nThe argument can be a string, a file (Deno.open("./path")), bytes (Uint8Array), or any readable object (like Deno.stdin or the .stdout of another run command)\nbut instead of any of those I receied:\n    ${each}\n\n`)
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
        }
        
        // 
        // handle stdout & stderr (pre-start)
        // 
        const outStreamNames = [ 'stdout', 'stderr' ]
        // outAndError
        if (commandMetaData.outAndError.length > 0) {
            for (const each of outStreamNames) {
                if (!(commandMetaData[each] instanceof Array)) {
                    commandMetaData[each] = []
                }
                commandMetaData[each] = commandMetaData[each].concat(commandMetaData.outAndError)
            }
        }
        // stdin, stdout seperatly
        for (const each of outStreamNames) {
            // if it was given at all
            if (commandMetaData[each] !== undefined) {
                // special case of Stdin(null) or Stdout(null)
                if (commandMetaData[each].length == 0) {
                    runArg[each] = 'piped'
                } else if (commandMetaData[each].length == 1 && commandMetaData[each][0] === null) {
                    runArg[each] = 'null'
                } else {
                    runArg[each] = 'piped'
                    // note: surprisingly Sets in ES6 are guarenteed to preserve order, so this only removes null's undefines, and duplicates
                    commandMetaData[each] = [ ... new Set(commandMetaData[each].filter(each=>each!=null))]
                }
            }
        }
        const convertReturnStreamArg = async (arg) => {
            // save this kind of arg for later
            if (arg === returnAsString) {
                return arg
            }
            // if [symbol, data], convert data to file
            if (arg instanceof Array) {
                if (typeof arg[0] == 'symbol') {
                    let [ symbol, value ] = arg
                    // 
                    // overwrite
                    // 
                    if (symbol === overwriteSymbol) {
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
                            throw Error(`\nWhen running command:\n    ${JSON.stringify(runArg.cmd)}\nit was given one of:\n    Stdout(Overwrite(arg))\n    Stdin(Overwrite(arg))\n    Out(Overwrite(arg))\nHowever the given arg was not a string path or a file object.\nHere's what I know about the argument:${debugValueAsString(value)}\n\n`)
                        }
                    // 
                    // append
                    // 
                    } else if (symbol === appendSymbol) {
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
                            throw Error(`\nWhen running command:\n    ${JSON.stringify(runArg.cmd)}\nit was given one of:\n    Stdout(AppendTo(arg))\n    Stdin(AppendTo(arg))\n    Out(AppendTo(arg))\nHowever the given arg was not a string path or a file object.\nHere's what I know about the argument:${debugValueAsString(value)}\n\n`)
                        }

                    }
                    // arg will be a file
                    arg = value
                }
            }
            
            // values that are alread writeable streams
            if (arg instanceof WritableStream) {
                return arg
            // convert files/writables to writeable streams
            } else if (isWritable(arg)) {
                return writableStreamFromWriter(arg)
            } else if (typeof arg == 'string') {
                throw Error(`\nWhen running command:\n    ${JSON.stringify(runArg.cmd)}\nit was given one of:\n    Stdout(${JSON.stringify(arg)})\n    Stdin(${JSON.stringify(arg)})\n    Out(${JSON.stringify(arg)})\nif you want to have them write to a file:\n    dont:    Out(${JSON.stringify(arg)})\n    instead: Out(Overwrite(${JSON.stringify(arg)}))\n    or:      Out(AppendTo(${JSON.stringify(arg)}))\n\n`)
            }
        }
        // stdin, stdout seperatly
        let alreadyComputed = new Map()
        for (const eachStream of outStreamNames) {
            if (commandMetaData[eachStream] instanceof Array) {
                commandMetaData[eachStream] = commandMetaData[eachStream].map(eachArg=>{
                    if (alreadyComputed.has(eachArg)) {
                        return alreadyComputed.get(eachArg)
                    } else {
                        return convertReturnStreamArg(eachArg)
                    }
                })
                // wait on all the promises
                for (const eachIndex in commandMetaData[eachStream]) {
                    commandMetaData[eachStream][eachIndex] = await commandMetaData[eachStream][eachIndex]
                }
            }
        }
        let stdoutArgs = commandMetaData.stdout || []
        let stderrArgs = commandMetaData.stderr || []
        
        
        
        // 
        // 
        // start the process
        // 
        // 
        const process = Deno.run(runArg)
        if (commandMetaData.timeout.gentlyBy) {
            // create a outcome check
            let outcome = false
            process.status().then(()=>outcome=true)
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
                    }, commandMetaData.timeout.waitBeforeUsingForce)
                }
            }, commandMetaData.timeout.gentlyBy)
        }

        // 
        // handle stdout/stderr
        // 
        let returnStream = undefined
        if (runArg.stdout == 'piped' || runArg.stderr == 'piped') {
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
                let sourceStream
                const wasNeededByStdout = neededByStdout.get(eachStreamArg)
                // needs one of: [both, stdout, or stderr]
                if (wasNeededByStdout && neededByStderr.get(eachStreamArg)) {
                    sourceStream = zipReadableStreams(stdoutStreams.pop(), stderrStreams.pop())
                } else if (wasNeededByStdout) {
                    sourceStream = stdoutStreams.pop()
                } else {
                    sourceStream = stderrStreams.pop()
                }

                // pipe it to the correct thing (returnAsString is the only special case)
                if (eachStreamArg === returnAsString) {
                    returnStream = sourceStream
                } else {
                    // every stream arg should be a writable stream by this point
                    sourceStream.pipeTo(eachStreamArg)
                }
            }
        }

        // 
        // send stdin
        // 
        if (runArg.stdin == 'piped') {
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
        let statusPromise = process.status()
        statusPromise.then(({code, success})=>{
            syncStatus.done = true
            syncStatus.exitCode = code
            syncStatus.success = success
        })
        
        // await string
        let processFinishedValue
        if (returnStream) {
            processFinishedValue = statusPromise.then(async ()=>{
                const returnReader = returnStream.getReader()
                const { value } = await returnReader.read()
                const string = new TextDecoder().decode(value)
                return string
            })
        // await object
        } else {
            processFinishedValue = statusPromise.then(({ success, code })=>{
                return {
                    isDone:     true,
                    status:     syncStatus,
                    sendSignal: ()=>0,
                    success:    success,
                    exitCode:   code,
                    pid:        process.pid,
                    rid:        process.rid,
                    kill:       ()=>0,
                    close:      process.close,
                    stdin:      runArg.stdin=='null' ? null : (process.stdin || Deno.stdin),
                    stdout:     process.stdout || Deno.stdout,
                    stderr:     process.stderr || Deno.stderr,
                }
            })
        }

        const returnValueOrError = new Promise(async (resolve, reject)=>{
            if (commandMetaData.throwIfFails) {
                const status = await statusPromise
                if (!status.success) {
                    reject(await processFinishedValue)
                    return
                }
            }
            resolve(processFinishedValue)
        })
        return [ process, returnValueOrError, statusPromise, ]
    }
    // 
    // this is done to prevent the ugly (await (await run()).success()) syntax
    // 
    let returnValuePromise
    const asyncPartPromise = asyncPart().catch(err=>returnValuePromise=err)
    const processPromise     = asyncPartPromise.then(([process, processFinishedValue, statusPromise]) => process)
    const statusPromise      = asyncPartPromise.then(([process, processFinishedValue, statusPromise]) => statusPromise)
    returnValuePromise = asyncPartPromise.then(([process, processFinishedValue, statusPromise]) => processFinishedValue)
    Object.defineProperties(returnValuePromise, {
        status:     { get(){ return syncStatus      } },
        isDone:     { get(){ return syncStatus.done } },
        sendSignal: { get(){ return (         ...args)=>processPromise.then((process)=>process.kill(...args) ).catch(error=>error) } },
        kill:       { get(){ return (signal="SIGKILL")=>processPromise.then((process)=>process.kill(signal)  ) } },
        close:      { get(){ return (         ...args)=>processPromise.then((process)=>process.close(...args)) } },
        success:    { get(){ return statusPromise.then(({success})=>success) } },
        exitCode:   { get(){ return statusPromise.then(({code})=>code)       } },
        outcome:    { get(){ return statusPromise                            } },
        rid:        { get(){ return processPromise.then(({rid    })=>rid                                         ) } },
        pid:        { get(){ return processPromise.then(({pid    })=>pid                                         ) } },
        stdout:     { get(){ return processPromise.then(({stdout })=>stdout||Deno.stdout                         ) } },
        stderr:     { get(){ return processPromise.then(({stderr })=>stderr||Deno.stderr                         ) } },
        stdin:      { 
            get(){
                const realStdinPromise = processPromise.then(({stdin})=>stdin||Deno.stdin)
                return {
                    send(rawDataOrString) {
                        if (typeof rawDataOrString == 'string') {
                            return {...realStdinPromise.then(realStdin=>(realStdin.write(new TextEncoder().encode(rawDataOrString)))), ...this}
                        // assume its raw data
                        } else {
                            return {...realStdinPromise.then(realStdin=>(realStdin.write(rawDataOrString))), ...this}
                        }
                    },
                    close(...args) {
                        return realStdinPromise.then((realStdin)=>(realStdin.close(...args),this))
                    }
                }
            }
        },
    })
    return returnValuePromise
}

// namespace everything
run.Timeout = Timeout
run.Env = Env
run.Cwd = Cwd
run.Stdin = Stdin
run.Stdout = Stdout
run.Stderr = Stderr
run.Out = Out
run.Overwrite = Overwrite
run.AppendTo = AppendTo
run.zipInto = zipInto
run.mergeInto = mergeInto
run.returnAsString = returnAsString