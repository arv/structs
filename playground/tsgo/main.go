//go:build js && wasm

// TypeScript 7.1's API server (what `tsc --api` serves over its stdio), in
// WebAssembly: build-wasm.ts copies this file into a checkout of stock
// TypeScript, as tsc/cmd/threadsapi, and builds it with GOOS=js GOARCH=wasm.
// Its stdin and stdout are two pipes in shared memory (pipe.ts), which the
// worker that runs it (tsgo-worker.ts) sets as globalThis.tsgoPipes; the
// compiler's worker speaks the API's protocol on the other end (channel.ts).
// The lib files are the ones built in (bundled:///libs); every other file
// comes with the request that makes a snapshot.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"syscall/js"

	"github.com/microsoft/TypeScript/tsc/internal/api"
	"github.com/microsoft/TypeScript/tsc/internal/bundled"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
)

// pipe is one direction of the connection: read and write block, on
// Atomics.wait, until the other end has written or read
type pipe struct {
	pipe js.Value
	// the bytes read or to write, a chunk at a time
	buf js.Value
	len int
}

func newPipe(p js.Value) *pipe {
	buf := p.Get("chunk")
	return &pipe{pipe: p, buf: buf, len: buf.Length()}
}

func (p *pipe) Read(b []byte) (int, error) {
	n := p.pipe.Call("read", min(len(b), p.len)).Int()
	if n == 0 {
		return 0, io.EOF
	}
	js.CopyBytesToGo(b[:n], p.buf)
	return n, nil
}

func (p *pipe) Write(b []byte) (int, error) {
	written := 0
	for written < len(b) {
		n := js.CopyBytesToJS(p.buf, b[written:])
		p.pipe.Call("write", n)
		written += n
	}
	return written, nil
}

func (p *pipe) Close() error {
	p.pipe.Call("close")
	return nil
}

func main() {
	flags := flag.NewFlagSet("api", flag.ContinueOnError)
	cwd := flags.String("cwd", "/", "current working directory")
	callbacks := flags.String("callbacks", "", "comma-separated list of FS callbacks")
	caseSensitive := flags.Bool("useCaseSensitiveFileNames", true, "treat filesystem paths as case-sensitive")
	timing := flags.Bool("timing", false, "collect per-request server processing time")
	flags.Bool("api", true, "serve the API")
	flags.Bool("runExternalCode", false, "ignored: no external code runs here")
	if err := flags.Parse(os.Args[1:]); err != nil {
		os.Exit(2)
	}
	if *callbacks != "" {
		fmt.Fprintln(os.Stderr, "tsgo in WebAssembly: no file system callbacks; send the files with the snapshot")
		os.Exit(2)
	}
	pipes := js.Global().Get("tsgoPipes")
	options := &api.StdioServerOptions{
		In:                        newPipe(pipes.Get("in")),
		Out:                       newPipe(pipes.Get("out")),
		Err:                       os.Stderr,
		Cwd:                       tspath.ToRootedDirectoryPath(*cwd, "/"),
		DefaultLibraryPath:        bundled.LibPath(),
		UseCaseSensitiveFileNames: caseSensitive,
		CollectTiming:             *timing,
	}
	if err := api.NewStdioServer(options).Run(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
