#!/usr/bin/env node

var fs			= require("fs"),
	bl			= require("bl"),
	url			= require("url"),
	path		= require("path"),
	http		= require("http"),
	zlib		= require("zlib"),
	colors		= require("colors"),
	cheerio		= require("cheerio"),
	optimist	= require("optimist"),
	
	// We only take one domain for now, whatever's last specified.
	proxyDomain	= optimist._.pop() || "localhost",
	port		= optimist.port || optimist.p || 3000,
	dir			= optimist.dir || process.cwd() || __dirname;

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
}

function injecto(req,res) {
	var resPath = path.join(__dirname, req.url.split(/injecto\//).pop());

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
					$(item).attr(param,attr.pathname + (attr.search||"") + (attr.hash||""));
				}
			});
		});

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
	});
}

function error(req,res,code) {
	console.error("[%d] Failed to deliver resource (%s)".red,code,req.url);
	res.writeHead(code);
	res.end("Failed to deliver resource. (" + code + ")");
}

// Server
var server = http.createServer();

// Handler
server.on("request",function(req,res) {
	if (req.url.match(/\/\-\-injecto/))
		return injecto(req,res);

	proxy(req,res);
});

// Listen
server.listen(port,started);