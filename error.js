(function() {
	var ajaxObject = new XMLHttpRequest(),
		superConsole = console || {};
	
	window.addEventListener("error",function(err) {
		sendData({
			"error": {
				"message": err.message,
				"file": err.filename,
				"line": err.lineno
			},
			"context": String(window.location)
		});
	});
	
	function sendData(data) {
		try {
			data = JSON.stringify(data);
		} catch(e) {
			data = "CYCLIC:" + String(data);
		}
		
		ajaxObject.open('POST', "/--injecto-console", true);
		ajaxObject.send(data);
	}
	
	function sendMessage(kind,args) {
		superConsole[kind].apply(superConsole, args);
		sendData({
			"kind": kind,
			"message": [].slice.call(args,0),
			"context": String(window.location)
		})
	}
	
	window.console = {};
	["info","log","warn","error","dir"]
		.forEach(function(item) {
			window.console[item] = function() {
				sendMessage(item,arguments);
			};
		});

	if ("WebSocket" in window) {
		var socketReady = true;
		function connect() {
			var socket = new WebSocket(
				"ws://" + window.location.hostname + ":" + (+window.location.port+1));
			
			socket.addEventListener("open",function() {
				console.log("Client Websocket Ready.");
				socketReady = true;
			});
			
			socket.addEventListener("message",function(command) {
				command = command.data || command;
				
				if (command === "reload") {
					console.log("Reloading page.");
					window.location.reload();
				}
				
				if (command.match(/^command\:/i)) {
					var result = eval(command.substr(8));
					
					try {
						result = JSON.stringify(result);
					} catch(e) {
						result = "CYCLIC:" + String(result);
					}
					
					socket.send("response:" + result);
				}
			});
			
			socket.addEventListener("close",function() {
				socketReady = false;
			});
		}
		
		connect();
		setInterval(function sockCheck() {
			if (!socketReady) {
				connect();
			}
		},1000);
	}
})();