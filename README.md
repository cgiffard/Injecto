Injecto
=======

**Test your code in production!**

Injecto is a web proxy which lets you inject resources from your filesystem into
production websites, and reloads the relevant pages when you change them — no
browser extensions required!

Injecto live-reloads your pages when the filesystem resources change, and it also
provides you a 'broadcast REPL' — a JS console on steroids: evaluate code in all
connected browsers simultaneously. It catches page errors and redirects them to
your terminal.

Injecto also caches resources in-memory, so refreshes are fast and you don't have
to worry about network connectivity.

## Get started

You'll need node and npm.

```sh
npm install -g injecto`
```

Navigate to a folder with resources you want to inject into the page.

Then, it's just a simple matter of:

```sh
injecto myproductionwebsite.com
```

By default, Injecto runs on port 3000. Point your browser to http://localhost:3000/.

You'll see resources appear in your terminal as the page loads. Injecto also
reports whether the resource is being delivered from cache, or fetched remotely.

As soon as at least one websocket-enabled client connects, you'll see a prompt
appear:

```
broadcast REPL: 2 clients> _
```

Anything you type here will be transmitted to connected clients and evaluated
locally. Synchronously returned results are immediately displayed in your terminal.

Typing `reload` will reload all connected clients.

Type `^C` or `.exit` to quit.