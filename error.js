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
		ajaxObject.open('POST', "/--injecto-console", true);
		ajaxObject.send(JSON.stringify(data));
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
})();