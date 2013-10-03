#!/usr/bin/env node

var fs			= require("fs"),
	bl			= require("bl"),
	ws			= require("ws"),
	url			= require("url"),
	path		= require("path"),
	http		= require("http"),
	zlib		= require("zlib"),
	util		= require("util"),
	colors		= require("colors"),
	cheerio		= require("cheerio"),
	chokidar	= require("chokidar"),
	optimist	= require("optimist").argv,
	
	// We only take one domain for now, whatever's last specified.
	proxyDomain	= (optimist._||[]).pop() || "localhost",
	port		= optimist.port || optimist.p || 3000,
	dir			= optimist.dir || process.cwd() || __dirname,
	
	// State
	startTime	= Date.now(),
	wsClients	= [],
	
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

function started() {
	console.log("Injecto running for %s, on port %d".blue.bold,proxyDomain,port);
	console.log("Watching %s for changes.",dir.bold);
	
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
	
	console.log("\n\nFilesystem changed: %s",path.red);
	console.log("Triggering reload for %d clients...".red,wsClients.length);
	
	wsClients.forEach(function(socket) {
		socket.send("reload");
	});
	wsClients = [];
}

function injecto(req,res) {
	var resPath = path.join(dir, req.url.split(/injecto\//).pop());

	fs.stat(resPath,function(err) {
		if (err) return error(req,res,404);
		console.log("[INJECTO] %s".green,req.url);
		fs.createReadStream(resPath).pipe(res);
	});
}

function rewrite(remoteRes,localRes) {
	remoteRes.pipe(bl(function(err,data) {
		if (err) throw err;

		if (remoteRes.headers['content-encoding'] && (
			remoteRes.headers['content-encoding'].match(/gzip/) ||
			remoteRes.headers['content-encoding'].match(/deflate/))) {

			console.log("Zipped. Unzipping".yellowBG.black);
			return zlib.unzip(data,function(err,newData) {
				if (err) throw err;
				runRewrite(newData);
			});
		}

		runRewrite(data);
	}));

	function runRewrite(data) {
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
		console.log("INJECTED!".green);

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

	http.get(requestOptions, function(remoteRes) {
		var time = Date.now() - timeStarted;

		console.log(
			"REMOTE [%s] %s (%dms)",
			String(remoteRes.statusCode)[remoteRes.statusCode>=400?"red":"green"],
			req.url.white,
			time,
			(remoteRes.headers["content-encoding"] || "uncompressed").yellow);

		if (remoteRes.headers["content-type"] &&
			remoteRes.headers["content-type"].match(/^text\/html/i)) {
			return rewrite(remoteRes,res);
		}

		if (remoteRes.headers["content-encoding"]) {
			delete remoteRes.headers["content-encoding"];
			return remoteRes.pipe(zlib.createUnzip()).pipe(res);
		}

		remoteRes.pipe(res);
	})
	.on("error",function(error) {
		console.log("Request Error: %s".red,error.message);
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
			console.log(e);
			return console.log(String(data));
		}
		
		process.stdout.write("\n");
		
		if (context)
			console.log("Message from ".red + String(context).blue);
		
		if (error)
			console.log("%s, line %d: %s", error.file, error.line, String(error.message).red);
		
		if (message) {
			message = util.format.apply(util,message);
			
			if (message.indexOf("\n") < 0)
				message = message.blue;
			
			console.log(message);
		}
		
		process.stdout.write("\n");
		
		res.writeHead(200)
		res.end();
	}));
}

function injectoCore(req,res) {
	console.log("[INJECTO CORE]".green);
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
	console.log(
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
	console.log("ERROR: %s".red,error.message);
});

// Web sockets...
wsServer.on("connection", function(ws) {
	var index = wsClients.length;
	wsClients.push(ws);
	
	console.log("Web socket client connected.".red);
	
	ws.on("close",function() {
		console.log("Web socket client disconnected.".red);
		wsClients.splice(index,1);
	});
});

process.on("SIGINT",close);