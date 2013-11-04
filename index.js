#!/usr/bin/env node

var fs			= require("fs"),
	bl			= require("bl"),
	ws			= require("ws"),
	url			= require("url"),
	path		= require("path"),
	http		= require("http"),
	repl		= require("repl"),
	util		= require("util"),
	zlib		= require("zlib"),
	after		= require("after"),
	colors		= require("colors"),
	cheerio		= require("cheerio"),
	chokidar	= require("chokidar"),
	optimist	= require("optimist").argv,
	StreamCache	= require("stream-cache"),
	
	// We only take one domain for now, whatever's last specified.
	proxyDomain	= (optimist._||[]).pop() || "localhost",
	port		= optimist.port || optimist.p || 3000,
	dir			= optimist.dir || process.cwd() || __dirname,
	
	// State
	startTime	= Date.now(),
	wsClients	= [],
	cache		= {},
	
	// Ignore file modification notifications in our watch directory
	// that are triggered before we've been running for this number of
	// miliseconds.
	watchThreshold = 500;

// One time synchronous enumeration of available scripts
var injectAssets = fs.readdirSync(dir),
	cssAssets = injectAssets.filter(function(name) {
		return name.match(/\.css$/i);
	}),
	jsAssets = injectAssets.filter(function(name) {
		return name.match(/\.js$/i);
	});

// REPL/Prompt aware log
var logTimer = null,
	lastWasPrompt = false;

function log() {
	if (lastWasPrompt)
		process.stdout.write("\n\n");
	
	console.log.apply(console,arguments);
	lastWasPrompt = false;
	
	if (!prompt) return;
	
	if (logTimer)
		clearTimeout(logTimer);
	
	logTimer = setTimeout(function() {
		process.stdout.write("\n");
		prompt.displayPrompt();
		lastWasPrompt = true;
	},100);
}

function started() {
	log("Injecto running for %s, on port %d".blue.bold,proxyDomain,port);
	log("Watching %s for changes.",dir.bold);
	
	chokidar
		.watch(dir)
		.on("add",reload)
		.on("change",reload)
		.on("unlink",reload);
}

function reload(path) {
	if (Date.now() < startTime + watchThreshold) {
		return;
	}
	
	if (!wsClients.length) return;
	
	log("\n\nFilesystem changed: %s",path.red);
	log("Triggering reload for %d clients...".red,wsClients.length);
	
	wsClients.forEach(function(socket) {
		socket.send("reload");
	});
	wsClients = [];
}

function injecto(req,res) {
	var resPath = path.join(dir, req.url.split(/injecto\//).pop());

	fs.stat(resPath,function(err) {
		if (err) return error(req,res,404);
		log("[INJECTO] %s".green,req.url);
		fs.createReadStream(resPath).pipe(res);
	});
}

function rewrite(remoteRes,localRes) {
	remoteRes.pipe(bl(runRewrite));

	function runRewrite(err, data) {
		var $ = cheerio.load(data);

		["href","src"].forEach(function(param) {
			$("[" + param + "]").each(function(i,item) {
				var attr = url.parse($(item).attr(param));
				if (attr.hostname === proxyDomain || attr.host === proxyDomain) {
					$(item).attr(param,
						attr.pathname + (attr.search||"") + (attr.hash||""));
				}
			});
		});
		
		// Kill HTTP import URLs
		// TODO this is a horrible travesty. make this not suck
		var importRegExp =
			new RegExp("\\@import\\s*url\\(([\"\'])http?\\:\\/\\/" + proxyDomain,"ig");
		
		$("style").each(function(i,item) {
			$(item).html(
					$(item).html().replace(importRegExp,function(m1,m2) {
						return "@import url(" + m2;
					})
				);
		});
		
		$("head").append("<script type='text/javascript' src='/--injecto-core'/>");

		cssAssets.forEach(function(asset) {
			$("head")
				.append(
					"<link rel='stylesheet' media='screen' href='/--injecto/" + asset + "' />");
		});

		jsAssets.forEach(function(asset) {
			$("body")
				.append(
					"<script type='text/javascript' src='/--injecto/" + asset + "' />");
		});

		var resultCode = $.html();
		
		delete remoteRes.headers["content-encoding"];
		delete remoteRes.headers["content-length"];
		delete remoteRes.headers["accept-ranges"];
		delete remoteRes.headers["connection"];

		localRes.writeHead(remoteRes.statusCode,remoteRes.headers);
		localRes.end(resultCode);
	}
}

function proxy(req,res) {
	var timeStarted = Date.now(),
		requestOptions = {
			host: proxyDomain,
			port: 80,
			path: req.url,
			headers: req.headers
		};

	requestOptions.headers.host = proxyDomain;
	requestOptions.headers.referer = "http://" + proxyDomain + "/";
	
	if (cache[req.url]) {
		return done(cache[req.url], true);
	}
	
	function done(remoteRes, fromCache) {
		var time = Date.now() - timeStarted;
		
		if (!remoteRes.headers["content-type"]) {
			remoteRes.headers["content-type"] = "text/html";
		}
		
		log(
			"%s [%s] %s (%dms)",
			(fromCache ? "CACHE" : "REMOTE"),
			String(remoteRes.statusCode)[remoteRes.statusCode>=400?"red":"green"],
			req.url.white,
			time,
			(remoteRes.headers["content-encoding"] || "uncompressed").yellow);
		
		if (!fromCache && remoteRes.statusCode < 400) {
			cache[req.url] = new StreamCache();
			
			if (remoteRes.headers["content-encoding"]) {
				delete remoteRes.headers["content-encoding"];
				remoteRes.pipe(zlib.createUnzip()).pipe(cache[req.url]);
			} else {
				remoteRes.pipe(cache[req.url]);
			}
			
			cache[req.url].headers = remoteRes.headers;
			cache[req.url].statusCode = remoteRes.statusCode;
			remoteRes = cache[req.url];
		}
		
		if (remoteRes.headers["content-type"] &&
			remoteRes.headers["content-type"].match(/^text\/html/i)) {
			return rewrite(remoteRes,res);
		}
	
		remoteRes.pipe(res);
	}
	
	http.get(requestOptions, done)
		.on("error",function(error) {
			log("Request Error: %s".red,error.message);
			res.end();
		});
}

function consolo(req,res) {
	req.pipe(bl(function(err,data) {
		try {
			var data	= JSON.parse(String(data)),
				context	= data.context,
				error	= data.error,
				message	= data.message;
			
			if (typeof message !== "array" && !(message instanceof Array))
				message = [message];
			
		} catch(e) {
			log(e);
			return log(String(data));
		}
		
		process.stdout.write("\n");
		
		if (context)
			log("Message from ".red + String(context).blue);
		
		if (error)
			log("%s, line %d: %s", error.file, error.line, String(error.message).red);
		
		if (message) {
			message = util.format.apply(util,message);
			
			if (message.indexOf("\n") < 0)
				message = message.blue;
			
			log(message);
		}
		
		process.stdout.write("\n");
		
		res.writeHead(200)
		res.end();
	}));
}

function injectoCore(req,res) {
	log("[INJECTO CORE]".green);
	res.writeHead(200,{"content-type":"text/javascript"});
	fs.createReadStream(path.join(__dirname,"/error.js"))
		.pipe(res);
}

function error(req,res,code) {
	console.error("[%d] Failed to deliver resource (%s)".red,code,req.url);
	res.writeHead(code);
	res.end("Failed to deliver resource. (" + code + ")");
}

function close() {
	log(
		"Thanks! Injecto was running for %d seconds.".green,
		Math.floor((Date.now() - startTime) / 1000)
	);
	
	process.exit(0);
}

// Server
var server = http.createServer(),
	wsServer = new ws.Server({ port: port + 1 });

// Handler
server.on("request",function(req,res) {
	if (req.url.match(/^\/\-\-injecto-core/))
		return injectoCore(req,res);
	
	if (req.url.match(/^\/\-\-injecto-console/))
		return consolo(req,res);
	
	if (req.url.match(/^\/\-\-injecto\//))
		return injecto(req,res);

	proxy(req,res);
});

// Listen
server.listen(port,started);

server.on("error",function(err) {
	log("ERROR: %s".red,error.message);
});

// Web sockets...
wsServer.on("connection", function(ws) {
	var index = wsClients.length;
	wsClients.push(ws);
	
	log("Web socket client connected.".red);
	
	prompt.prompt =
		util.format("broadcast REPL: %d clients> ",wsClients.length);
	
	ws.on("close",function() {
		log("Web socket client disconnected.".red);
		wsClients.splice(index,1);
		
		prompt.prompt =
			util.format("broadcast REPL: %d clients> ",wsClients.length);
	});
});

process.on("SIGINT",close);

// REPL
var prompt;
prompt = repl.start({
	prompt: "\n",
	eval: function(cmd, context, filename, callback) {
		cmd = (cmd||"").replace(/^\s*\(/, "").replace(/\)\s*$/, "");
		
		if (!cmd.trim().length) {
			return callback(null,new Error("No command".red));
		}
		
		if (!wsClients.length) {
			return callback(null,new Error("No clients connected".red));
		}
		
		if (cmd.replace(/\s+/ig,"") === "reload") {
			return reload("User command");
		}
		
		console.log("Broadcasting to %d clients.".blue, wsClients.length);
		var next = after(wsClients.length, function() {
			process.stdout.write("\n");
			prompt.displayPrompt()
		});
		
		wsClients.forEach(function(socket) {
			var complete = false;
			
			socket.send("command:" + cmd);
			socket.once("message", function(string, data) {
				if (complete) return;
				
				complete = true;
				string = string.substr(9);
				
				if (string.match(/^CYCLIC/)) {
					console.log(string.red);
				
				} else if (string.match(/^\s*undefined/)) {
					console.log("undefined");
					
				} else {
					console.log(JSON.parse(string))
				}
				
				next();
			});
			
			setTimeout(function() {
				if (!complete) {
					complete = true;
					next();
				}
			},250);
		});
	}
});

prompt.on("exit",function() {
	close();
});